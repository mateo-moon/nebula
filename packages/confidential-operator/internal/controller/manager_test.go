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
	nodev1 "k8s.io/api/node/v1"
	"k8s.io/apimachinery/pkg/api/resource"
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
	if err := c.Create(ctx, &nodev1.RuntimeClass{ObjectMeta: metav1.ObjectMeta{Name: "kata-qemu-snp"}, Handler: "kata-qemu-snp",
		Overhead:   &nodev1.Overhead{PodFixed: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("2Gi")}},
		Scheduling: &nodev1.Scheduling{NodeSelector: map[string]string{"kata-deploy.katacontainers.io/default": "true"}}}); err != nil {
		t.Fatal(err)
	}

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
		"trustee":      map[string]string{"chart": "oci://ghcr.io/mateo-moon/helm/trustee@sha256:371376d5c4b135890f6b9b0071ad5a8f7c9975af797994b4aaf5efbea2e21cb5", "kbsImage": "example.invalid/image@sha256:" + strings.Repeat("a", 64), "tngImage": "example.invalid/image@sha256:" + strings.Repeat("a", 64), "gatewayImage": "example.invalid/image@sha256:" + strings.Repeat("a", 64)},
		"storageImage": "example.invalid/image@sha256:" + strings.Repeat("a", 64),
		"containers":   []any{map[string]any{"name": "app", "image": "example.invalid/image@sha256:" + strings.Repeat("a", 64), "command": []string{"/app"}, "uid": 11000, "gid": 11000}},
		"storage":      []any{map[string]string{"name": "scratch", "resource": "memory"}}, "resources": [][]string{{"default", "image", "generic"}},
	}

	// The actual API server must reject the same unsafe public declarations as
	// the shared TypeScript validator; these cases never reach a guest renderer.
	invalidMemory := &api.ConfidentialStorage{ObjectMeta: metav1.ObjectMeta{Name: "oversized-memory", Namespace: "qualified"}, Spec: runtime.RawExtension{Raw: []byte(`{"type":"Memory","sizeLimit":"1048577Gi"}`)}}
	if c.Create(ctx, invalidMemory) == nil {
		t.Fatal("CRD admitted memory above the shared safe byte bound")
	}
	cases := []struct {
		name   string
		change func(map[string]any)
	}{
		{"reserved-name", func(s map[string]any) { s["containers"].([]any)[0].(map[string]any)["name"] = "kbs" }},
		{"reserved-env", func(s map[string]any) {
			s["containers"].([]any)[0].(map[string]any)["env"] = map[string]any{"HOSTNAME": "wrong"}
		}},
		{"reserved-trustee-env", func(s map[string]any) {
			s["containers"].([]any)[0].(map[string]any)["env"] = map[string]any{"TRUSTEE_FAKE": "wrong"}
		}},
		{"resources", func(s map[string]any) {
			s["containers"].([]any)[0].(map[string]any)["resources"] = map[string]any{"requests": map[string]any{"cpu": "2"}, "limits": map[string]any{"cpu": "1"}}
		}},
		{"cpu-bound", func(s map[string]any) {
			s["containers"].([]any)[0].(map[string]any)["resources"] = map[string]any{"requests": map[string]any{"cpu": "32001m"}, "limits": map[string]any{}}
		}},
		{"lookaround", func(s map[string]any) { s["network"].(map[string]any)["ipv4AddressPattern"] = "^(?=10).+$" }},
		{"backref", func(s map[string]any) { s["network"].(map[string]any)["ipv4AddressPattern"] = `^(10)\1$` }},
		{"unsupported-escape", func(s map[string]any) { s["network"].(map[string]any)["ipv4AddressPattern"] = `^10[.][\p{L}]+$` }},
		{"repetition", func(s map[string]any) { s["network"].(map[string]any)["ipv4AddressPattern"] = "^10[.][0-9]{1001}$" }},
	}
	original, _ := json.Marshal(spec)
	for _, cpu := range []string{"1m", "0.001", "32", "32000m"} {
		var copy map[string]any
		_ = json.Unmarshal(original, &copy)
		copy["containers"].([]any)[0].(map[string]any)["resources"] = map[string]any{"requests": map[string]any{"cpu": cpu, "memory": "1Mi"}, "limits": map[string]any{"cpu": "32", "memory": "1048576Gi"}}
		data, _ := json.Marshal(copy)
		w := &api.ConfidentialWorkload{ObjectMeta: metav1.ObjectMeta{Name: "valid-quantity", Namespace: "qualified"}, Spec: runtime.RawExtension{Raw: data}}
		if err := c.Create(ctx, w, &client.CreateOptions{DryRun: []string{metav1.DryRunAll}}); err != nil {
			t.Fatalf("CRD refused valid common quantity %s: %v", cpu, err)
		}
	}

	for _, candidate := range cases {
		var copy map[string]any
		_ = json.Unmarshal(original, &copy)
		candidate.change(copy)
		data, _ := json.Marshal(copy)
		w := &api.ConfidentialWorkload{ObjectMeta: metav1.ObjectMeta{Name: candidate.name, Namespace: "qualified"}, Spec: runtime.RawExtension{Raw: data}}
		if c.Create(ctx, w) == nil {
			t.Fatalf("CRD admitted invalid %s declaration", candidate.name)
		}
	}
	data, _ := json.Marshal(spec)
	for _, item := range []struct{ ns, name string }{{"qualified", "first"}, {"qualified", "second"}, {"outside", "ignored"}} {
		if err := c.Create(ctx, &api.ConfidentialWorkload{ObjectMeta: metav1.ObjectMeta{Name: item.name, Namespace: item.ns}, Spec: runtime.RawExtension{Raw: data}}); err != nil {
			t.Fatal(err)
		}
	}
	var pods corev1.PodList
	eventually(func() bool { _ = c.List(ctx, &pods, client.InNamespace("qualified")); return len(pods.Items) == 2 })
	for _, pod := range pods.Items {
		if !knownKataAdmissionOverhead(pod.Spec.Overhead) || pod.Spec.NodeSelector["kata-deploy.katacontainers.io/default"] != "true" {
			t.Fatal("real RuntimeClass admission did not apply the accounting/scheduling fixture")
		}
	}
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
	var current api.ConfidentialWorkload
	_ = c.Get(ctx, client.ObjectKey{Namespace: "qualified", Name: owner.Name}, &current)
	publicPlan, _ := (&testRenderer{}).Render(ctx, &current, nil)
	if !podMatchesPlan(pod, &publicPlan.Pod) {
		a, e := pod.Spec.DeepCopy(), publicPlan.Pod.Spec.DeepCopy()
		normalizePodDefaults(a)
		normalizePodDefaults(e)
		ar, _ := json.Marshal(a)
		er, _ := json.Marshal(e)
		t.Fatalf("API-defaulted Pod differs from plan: actual=%s expected=%s", ar, er)
	}
	eventually(func() bool {
		var w api.ConfidentialWorkload
		_ = c.Get(ctx, client.ObjectKey{Namespace: "qualified", Name: owner.Name}, &w)
		return w.Status.Phase == "Running"
	})
	// A real metadata-only update must restore the public selector without
	// changing the admitted PodSpec, native measurement, UID or running status.
	beforeRoutingRepair := pod.DeepCopy()
	delete(pod.Labels, profileLabel)
	if err := c.Update(ctx, pod); err != nil {
		t.Fatal(err)
	}
	eventually(func() bool {
		var repaired corev1.Pod
		_ = c.Get(ctx, client.ObjectKeyFromObject(pod), &repaired)
		return repaired.Labels[profileLabel] == "same-code"
	})
	var repaired corev1.Pod
	if err := c.Get(ctx, client.ObjectKeyFromObject(pod), &repaired); err != nil {
		t.Fatal(err)
	}
	originalSpec, _ := json.Marshal(beforeRoutingRepair.Spec)
	repairedSpec, _ := json.Marshal(repaired.Spec)
	if repaired.UID != beforeRoutingRepair.UID || string(originalSpec) != string(repairedSpec) || repaired.Annotations[initDataAnnotation] != beforeRoutingRepair.Annotations[initDataAnnotation] {
		t.Fatal("metadata repair changed the actual admitted guest")
	}
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
