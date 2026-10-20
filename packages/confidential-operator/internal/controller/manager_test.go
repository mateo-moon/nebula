package controller

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/config"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

// Exercises real API defaulting, CRD CEL validation, informer watches, queued
// reconciliation and recovery after a manager restart. No kubelet is needed.
func TestManager(t *testing.T) {
	if os.Getenv("CONFIDENTIAL_ENVTEST") != "1" {
		t.Skip("run make envtest with KUBEBUILDER_ASSETS")
	}
	env := &envtest.Environment{CRDDirectoryPaths: []string{filepath.Join("..", "..", "config", "crd", "bases")}, ErrorIfCRDPathMissing: true}
	cfg, err := env.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := env.Stop(); err != nil {
			t.Error(err)
		}
	})
	scheme := testScheme()
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, ns := range []string{"qualified", "outside"} {
		if err := c.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); err != nil {
			t.Fatal(err)
		}
	}
	start := func() func() {
		skipDuplicateTestNames := true
		mgr, err := ctrl.NewManager(cfg, ctrl.Options{Scheme: scheme, Controller: config.Controller{SkipNameValidation: &skipDuplicateTestNames}, Metrics: metricsserver.Options{BindAddress: "0"}, HealthProbeBindAddress: "0", Cache: cache.Options{DefaultNamespaces: map[string]cache.Config{"qualified": {}}, ReaderFailOnMissingInformer: true}})
		if err != nil {
			t.Fatal(err)
		}
		render := &testRenderer{}
		if err := (&WorkloadReconciler{Client: mgr.GetClient(), Reader: mgr.GetAPIReader(), Scheme: scheme, Renderer: render}).SetupWithManager(mgr); err != nil {
			t.Fatal(err)
		}
		if err := (&StorageReconciler{Client: mgr.GetClient(), Reader: mgr.GetAPIReader(), Renderer: render}).SetupWithManager(mgr); err != nil {
			t.Fatal(err)
		}
		runCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- mgr.Start(runCtx) }()
		return func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Error(err)
				}
			case <-time.After(10 * time.Second):
				t.Error("manager shutdown timed out")
			}
		}
	}
	stop := start()
	defer func() {
		if stop != nil {
			stop()
		}
	}()
	eventually := func(check func() bool) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			if check() {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("informer reconciliation did not converge")
	}
	storage := &api.ConfidentialStorage{ObjectMeta: metav1.ObjectMeta{Name: "memory", Namespace: "qualified"}, Spec: runtime.RawExtension{Raw: []byte(`{"type":"Memory","sizeLimit":"32Mi"}`)}}
	if err := c.Create(ctx, storage); err != nil {
		t.Fatal(err)
	}
	// Changing storage bindings must be rejected by the real CEL admission rule.
	changed := storage.DeepCopy()
	changed.Spec.Raw = []byte(`{"type":"Memory","sizeLimit":"64Mi"}`)
	if c.Update(ctx, changed) == nil {
		t.Fatal("immutable storage binding changed")
	}
	spec := map[string]any{
		"profile": "same-code", "ownerPublicKeyPem": "public-fixture", "guest": map[string]any{"measurement": strings.Repeat("a", 96), "chipId": strings.Repeat("b", 128), "minimumReportedTcb": map[string]any{"bootloader": 1, "tee": 0, "snp": 1, "microcode": 1}},
		"nodeSelector": map[string]string{"kubernetes.io/hostname": "qualified-node"}, "network": map[string]string{"ipv4AddressPattern": "^10[.].+$", "ipv6AddressPattern": "^fd42:.+$"},
		"trustee":    map[string]string{"chart": "official-chart.tgz", "kbsImage": "example.invalid/image@sha256:" + strings.Repeat("a", 64), "tngImage": "example.invalid/image@sha256:" + strings.Repeat("a", 64), "gatewayImage": "example.invalid/image@sha256:" + strings.Repeat("a", 64)},
		"containers": []any{map[string]any{"name": "app", "image": "example.invalid/image@sha256:" + strings.Repeat("a", 64), "command": []string{"/app"}, "uid": 11000, "gid": 11000}},
		"storage":    []any{map[string]string{"name": "scratch", "resource": "memory"}}, "resources": [][]string{{"default", "image", "generic"}},
	}
	data, _ := json.Marshal(spec)
	for _, item := range []struct{ ns, name string }{{"qualified", "first"}, {"qualified", "second"}, {"outside", "ignored"}} {
		if err := c.Create(ctx, &api.ConfidentialWorkload{ObjectMeta: metav1.ObjectMeta{Name: item.name, Namespace: item.ns}, Spec: runtime.RawExtension{Raw: data}}); err != nil {
			t.Fatal(err)
		}
	}
	var pods corev1.PodList
	eventually(func() bool { _ = c.List(ctx, &pods, client.InNamespace("qualified")); return len(pods.Items) == 2 })
	firstNames := map[string]bool{}
	for _, pod := range pods.Items {
		firstNames[pod.Name] = true
	}
	var outside corev1.PodList
	_ = c.List(ctx, &outside, client.InNamespace("outside"))
	if len(outside.Items) != 0 {
		t.Fatal("controller escaped namespace scope")
	}
	// A Pod status watch must trigger the owning workload, not wait for polling.
	pod := pods.Items[0].DeepCopy()
	pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastTransitionTime: metav1.Now()}}
	if err := c.Status().Update(ctx, pod); err != nil {
		t.Fatal(err)
	}
	owner := metav1.GetControllerOf(pod)
	eventually(func() bool {
		var w api.ConfidentialWorkload
		_ = c.Get(ctx, client.ObjectKey{Namespace: "qualified", Name: owner.Name}, &w)
		return w.Status.Phase == "Running"
	})
	stop()
	stop = start()
	eventually(func() bool {
		var w api.ConfidentialWorkload
		_ = c.Get(ctx, client.ObjectKey{Namespace: "qualified", Name: "second"}, &w)
		return w.Status.PodName != ""
	})
	// Allow initial list events to be consumed after restart.
	time.Sleep(400 * time.Millisecond)
	_ = c.List(ctx, &pods, client.InNamespace("qualified"))
	if len(pods.Items) != 2 {
		t.Fatal("restart duplicated guests")
	}
	for _, pod := range pods.Items {
		if !firstNames[pod.Name] {
			t.Fatal("restart replaced enrolled Pod")
		}
	}
	var secrets corev1.SecretList
	_ = c.List(ctx, &secrets, client.InNamespace("qualified"))
	if len(secrets.Items) != 0 {
		t.Fatal("controller created a Secret")
	}
}
