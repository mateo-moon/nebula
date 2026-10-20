package controller

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

type testRenderer struct{ calls int }

func (r *testRenderer) Render(_ context.Context, w *api.ConfidentialWorkload, _ []api.ConfidentialStorage) (*Plan, error) {
	r.calls++
	return &Plan{Pod: corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: w.Namespace, GenerateName: "same-code-"}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "example.invalid/test@sha256:" + strings.Repeat("a", 64)}}}}, SpecSHA256: fmt.Sprintf("%064d", w.Generation), InitDataSHA256: strings.Repeat("b", 64)}, nil
}
func (r *testRenderer) ValidateStorage(context.Context, *api.ConfidentialStorage) error { return nil }
func testScheme() *runtime.Scheme {
	s := runtime.NewScheme()
	_ = corev1.AddToScheme(s)
	_ = api.AddToScheme(s)
	return s
}
func fixture(ns, name string) (*api.ConfidentialWorkload, *api.ConfidentialStorage, *corev1.PersistentVolumeClaim) {
	w := &api.ConfidentialWorkload{TypeMeta: metav1.TypeMeta{APIVersion: api.GroupVersion.String(), Kind: "ConfidentialWorkload"}, ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, UID: types.UID(name + "-uid"), Generation: 1}, Spec: runtime.RawExtension{Raw: []byte(`{"storage":[{"name":"data","resource":"disk"}],"containers":[{"ports":[{"name":"proof","port":9080}]}]}`)}}
	s := &api.ConfidentialStorage{ObjectMeta: metav1.ObjectMeta{Name: "disk", Namespace: ns}, Spec: runtime.RawExtension{Raw: []byte(`{"type":"EncryptedBlock","claimName":"disk-pvc"}`)}}
	mode := corev1.PersistentVolumeBlock
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "disk-pvc", Namespace: ns}, Spec: corev1.PersistentVolumeClaimSpec{VolumeMode: &mode}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending}}
	return w, s, pvc
}
func run(t *testing.T, r *WorkloadReconciler, w *api.ConfidentialWorkload) error {
	t.Helper()
	_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(w)})
	return err
}
func getWorkload(t *testing.T, c client.Client, w *api.ConfidentialWorkload) *api.ConfidentialWorkload {
	t.Helper()
	var result api.ConfidentialWorkload
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(w), &result); err != nil {
		t.Fatal(err)
	}
	return &result
}
func getPods(t *testing.T, c client.Client) []corev1.Pod {
	t.Helper()
	var pods corev1.PodList
	if err := c.List(context.Background(), &pods); err != nil {
		t.Fatal(err)
	}
	return pods.Items
}
func TestReconcileIdempotenceReplacementAndOwnership(t *testing.T) {
	ctx := context.Background()
	w, s, pvc := fixture("qualified", "first")
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).Build()
	render := &testRenderer{}
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: render}
	for range 2 {
		if err := run(t, r, w); err != nil {
			t.Fatal(err)
		}
	}
	pods := getPods(t, c)
	if len(pods) != 1 || render.calls != 1 {
		t.Fatalf("reconciliation duplicated Pod or rendering: pods=%d renders=%d", len(pods), render.calls)
	}
	if !ownedBy(&pods[0], w) {
		t.Fatal("missing exact ownership")
	}
	before := pods[0].DeepCopy()
	w = getWorkload(t, c, w)
	w.Generation++
	w.Spec.Raw = []byte(`{"storage":[{"name":"data","resource":"disk"}],"containers":[{"ports":[{"name":"proof","port":9081}]}]}`)
	if err := c.Update(ctx, w); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if got := getWorkload(t, c, w); got.Status.Phase != "UpdatePending" {
		t.Fatal(got.Status)
	}
	if pods = getPods(t, c); len(pods) != 1 || pods[0].Name != before.Name || pods[0].Annotations[renderLabel] != before.Annotations[renderLabel] {
		t.Fatal("configuration update replaced measured Pod")
	}
	var claim corev1.PersistentVolumeClaim
	if err := c.Get(ctx, client.ObjectKeyFromObject(pvc), &claim); err != nil {
		t.Fatal("claim was removed")
	}
}
func TestIdenticalWorkloadsSeparatePodsAndServices(t *testing.T) {
	w, s, pvc := fixture("qualified", "first")
	other := w.DeepCopy()
	other.Name = "second"
	other.UID = "second-uid"
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, other, s, pvc).Build()
	render := &testRenderer{}
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: render}
	for _, item := range []*api.ConfidentialWorkload{w, other} {
		if err := run(t, r, item); err != nil {
			t.Fatal(err)
		}
	}
	pods := getPods(t, c)
	if len(pods) != 2 || pods[0].Labels[ownerLabel] == pods[1].Labels[ownerLabel] {
		t.Fatal("instances are not independently routed")
	}
	if getWorkload(t, c, w).Status.InitDataSHA256 != getWorkload(t, c, other).Status.InitDataSHA256 {
		t.Fatal("identical declarations changed measurement")
	}
	var services corev1.ServiceList
	_ = c.List(context.Background(), &services)
	if len(services.Items) != 2 {
		t.Fatal("service collision")
	}
	// Restarting the process must recover existing Pods without creation.
	r = &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &testRenderer{}}
	for _, item := range []*api.ConfidentialWorkload{w, other} {
		if err := run(t, r, item); err != nil {
			t.Fatal(err)
		}
	}
	if len(getPods(t, c)) != 2 {
		t.Fatal("controller restart duplicated guests")
	}
}
func TestConflictsAndFilesystemClaimsFailClosed(t *testing.T) {
	for _, scenario := range []string{"filesystem", "foreign-pod", "multiple-pods", "foreign-service"} {
		t.Run(scenario, func(t *testing.T) {
			w, s, pvc := fixture("qualified", "first")
			scheme := testScheme()
			objects := []client.Object{w, s, pvc}
			switch scenario {
			case "filesystem":
				mode := corev1.PersistentVolumeFilesystem
				pvc.Spec.VolumeMode = &mode
			case "foreign-pod", "multiple-pods":
				pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "foreign", Namespace: w.Namespace, Labels: map[string]string{ownerLabel: string(w.UID)}}}
				objects = append(objects, pod)
				if scenario == "multiple-pods" {
					other := pod.DeepCopy()
					other.Name = "another"
					objects = append(objects, other)
				}
			case "foreign-service":
				objects = append(objects, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: w.Name, Namespace: w.Namespace}})
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(objects...).Build()
			r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &testRenderer{}}
			if run(t, r, w) == nil {
				t.Fatal("unsafe configuration accepted")
			}
			if getWorkload(t, c, w).Status.Phase != "Error" {
				t.Fatal("failure not surfaced")
			}
			if scenario == "filesystem" && len(getPods(t, c)) != 0 {
				t.Fatal("Pod created for filesystem claim")
			}
		})
	}
}
func TestServiceDriftAndStorageStatus(t *testing.T) {
	ctx := context.Background()
	w, s, pvc := fixture("qualified", "first")
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s, pvc).WithObjects(w, s, pvc).Build()
	renderer := &testRenderer{}
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: renderer}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	var service corev1.Service
	_ = c.Get(ctx, client.ObjectKeyFromObject(w), &service)
	service.Spec.Ports[0].Port = 1234
	_ = c.Update(ctx, &service)
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	_ = c.Get(ctx, client.ObjectKeyFromObject(w), &service)
	if service.Spec.Ports[0].Port != 8443 {
		t.Fatal("service drift persisted")
	}
	storage := &StorageReconciler{Client: c, Reader: c, Renderer: renderer}
	if _, err := storage.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(s)}); err != nil {
		t.Fatal(err)
	}
	_ = c.Get(ctx, client.ObjectKeyFromObject(s), s)
	if s.Status.Phase != "AwaitingBinding" {
		t.Fatal(s.Status)
	}
	_ = c.Get(ctx, client.ObjectKeyFromObject(pvc), pvc)
	pvc.Status.Phase = corev1.ClaimBound
	_ = c.Status().Update(ctx, pvc)
	if _, err := storage.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(s)}); err != nil {
		t.Fatal(err)
	}
	_ = c.Get(ctx, client.ObjectKeyFromObject(s), s)
	if s.Status.Phase != "Available" {
		t.Fatal(s.Status)
	}
}
func TestNamespaceScopeAndRawSpec(t *testing.T) {
	for _, names := range [][]string{nil, {""}, {"*"}, {"default", "default"}, {"a/b"}} {
		if ValidateNamespaces(names) == nil {
			t.Fatalf("unsafe scope accepted: %v", names)
		}
	}
	if ValidateNamespaces([]string{"qualified", "second"}) != nil {
		t.Fatal("valid namespaces refused")
	}
	var w api.ConfidentialWorkload
	data := []byte(`{"spec":{"future":{"value":123},"storage":[]}}`)
	if json.Unmarshal(data, &w) != nil {
		t.Fatal("raw JSON rejected")
	}
	cloned := w.DeepCopy()
	cloned.Spec.Raw[0] = 'X'
	if w.Spec.Raw[0] != '{' {
		t.Fatal("spec was aliased during deepcopy")
	}
}
