package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// Run the test binary as an external renderer to exercise the actual process
// boundary, including cancellation and untrusted subprocess diagnostics.
func TestRendererProcess(t *testing.T) {
	mode := os.Getenv("CONFIDENTIAL_TEST_RENDERER")
	if mode == "" {
		return
	}
	var input struct {
		Workload api.ConfidentialWorkload  `json:"workload"`
		Storages []api.ConfidentialStorage `json:"storages"`
	}
	if json.NewDecoder(os.Stdin).Decode(&input) != nil {
		os.Exit(2)
	}
	for _, m := range []metav1.ObjectMeta{input.Workload.ObjectMeta, input.Storages[0].ObjectMeta} {
		if m.Name == "" || m.Namespace == "" || m.UID != "" || len(m.Annotations) != 0 || len(m.Labels) != 0 {
			os.Exit(3)
		}
	}
	if input.Workload.Status.Phase != "" || input.Storages[0].Status.Phase != "" {
		os.Exit(4)
	}
	switch mode {
	case "failure":
		fmt.Fprint(os.Stderr, "registry credential must never enter status")
		fmt.Fprint(os.Stdout, "private subprocess response")
		os.Exit(5)
	case "oversize":
		fmt.Fprint(os.Stdout, strings.Repeat("x", 17*1024*1024))
		os.Exit(0)
	case "diagnostic":
		fmt.Fprint(os.Stdout, `{"error":{"reason":"InvalidDeclaration","message":"Confidential workload: owner key must be P-256"}}`)
		os.Exit(0)
	case "hostile-diagnostic":
		fmt.Fprint(os.Stdout, `{"error":{"reason":"InvalidDeclaration","message":"Confidential workload: private credential\nleak"}}`)
		os.Exit(0)
	case "wait":
		time.Sleep(time.Minute)
	}
	namespace := input.Workload.Namespace
	if mode == "wrong-namespace" {
		namespace = "outside"
	}
	_ = json.NewEncoder(os.Stdout).Encode(Plan{
		Pod: corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: namespace, GenerateName: "guest-"},
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "example.invalid/test"}}}},
		SpecSHA256: strings.Repeat("a", 64), InitDataSHA256: strings.Repeat("b", 64),
	})
	os.Exit(0)
}

func TestCommandRendererBoundary(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	r := CommandRenderer{Command: executable, Args: []string{"-test.run=^TestRendererProcess$"}}
	w, s, _ := fixture("qualified", "first")
	w.Annotations = map[string]string{"ignored": "host supplied"}
	w.Labels = map[string]string{"ignored": "host supplied"}
	w.Status.Phase = "Untrusted"
	s.Annotations = w.Annotations
	s.Status.Phase = "Untrusted"
	for _, mode := range []string{"success", "failure", "oversize", "diagnostic", "hostile-diagnostic", "wrong-namespace", "wait"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("CONFIDENTIAL_TEST_RENDERER", mode)
			ctx := context.Background()
			if mode == "wait" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
				defer cancel()
			}
			plan, err := r.Render(ctx, w, []api.ConfidentialStorage{*s})
			if mode == "success" {
				if err != nil || plan.Pod.Namespace != w.Namespace {
					t.Fatalf("renderer rejected clean input: %v", err)
				}
				return
			}
			if err == nil || plan != nil {
				t.Fatal("unsafe renderer response accepted")
			}
			if mode == "diagnostic" && err.Error() != "Confidential workload: owner key must be P-256" {
				t.Fatal("fixed public validation diagnostic was lost")
			}
			if strings.Contains(err.Error(), "credential") || strings.Contains(err.Error(), "subprocess") {
				t.Fatal("subprocess diagnostics leaked into reconciliation error")
			}
		})
	}
}

func TestActualTypeScriptRendererProtocol(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required for the TypeScript renderer protocol test")
	}
	if _, err := os.Stat("../../node_modules/tsx"); err != nil {
		t.Skip("install the operator's frozen Node dependencies before running this test")
	}
	renderer := CommandRenderer{Command: node, Args: []string{"--import", "tsx", "../../src/main.ts"}}
	storage := &api.ConfidentialStorage{ObjectMeta: metav1.ObjectMeta{Name: "scratch", Namespace: "qualified"},
		Spec: runtime.RawExtension{Raw: []byte(`{"type":"Memory","sizeLimit":"32Mi"}`)}}
	if err := renderer.ValidateStorage(context.Background(), storage); err != nil {
		t.Fatalf("real renderer refused a valid public declaration: %v", err)
	}
	storage.Spec.Raw = []byte(`{"type":"Memory","sizeLimit":"invalid"}`)
	err = renderer.ValidateStorage(context.Background(), storage)
	if err == nil || err.Error() != "Confidential workload: memory size must be a positive Mi/Gi quantity" {
		t.Fatalf("real renderer did not return its fixed public validation diagnostic: %v", err)
	}
}
