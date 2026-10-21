package controller

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

type testRenderer struct {
	calls    int
	document string
}

type publicationRenderer struct {
	testRenderer
	pending bool
}

func (r *publicationRenderer) Render(ctx context.Context, w *api.ConfidentialWorkload, s []api.ConfidentialStorage) (*Plan, error) {
	if r.pending {
		return nil, &renderDiagnostic{reason: "ImageNotPublished", message: "Confidential workload: encrypted publication is not yet available"}
	}
	return r.testRenderer.Render(ctx, w, s)
}

func (r *testRenderer) Render(_ context.Context, w *api.ConfidentialWorkload, _ []api.ConfidentialStorage) (*Plan, error) {
	r.calls++
	document := r.document
	if document == "" {
		document = "reviewed guest v1"
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write([]byte(document))
	_ = writer.Close()
	pod := corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: w.Namespace, GenerateName: "same-code-",
		Annotations: map[string]string{initDataAnnotation: base64.StdEncoding.EncodeToString(compressed.Bytes())}},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "example.invalid/test@sha256:" + strings.Repeat("a", 64)}}}}
	hash, _ := podInitDataSHA256(&pod)
	return &Plan{Pod: pod, SpecSHA256: fmt.Sprintf("%064d", w.Generation), InitDataSHA256: hash}, nil
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

func TestUnpublishedImageRetriesWithoutCreatingAPod(t *testing.T) {
	w, s, pvc := fixture("qualified", "future-image")
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).Build()
	render := &publicationRenderer{pending: true}
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: render}
	result, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(w)})
	if err != nil || result.RequeueAfter <= 0 || len(getPods(t, c)) != 0 {
		t.Fatalf("unpublished image did not wait safely: result=%+v err=%v", result, err)
	}
	if got := getWorkload(t, c, w); got.Status.Phase != "AwaitingPublication" || got.Status.Reason != "ImageNotPublished" {
		t.Fatalf("wrong publication status: %+v", got.Status)
	}
	render.pending = false
	if err := run(t, r, w); err != nil || len(getPods(t, c)) != 1 {
		t.Fatalf("published image did not boot automatically: %v", err)
	}
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
	if got := getWorkload(t, c, w); got.Status.InitDataSHA256 != before.Annotations[measurementAnnotation] {
		t.Fatal("updated status described a prospective measurement rather than the existing Pod")
	}
	if pods = getPods(t, c); len(pods) != 1 || pods[0].Name != before.Name || pods[0].Annotations[renderLabel] != before.Annotations[renderLabel] {
		t.Fatal("configuration update replaced measured Pod")
	}
	terminating := pods[0].DeepCopy()
	terminating.Finalizers = []string{"test.nebula.dev/retain-during-deletion"}
	if err := c.Update(ctx, terminating); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, terminating); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if got := getWorkload(t, c, w); got.Status.Phase != "Retiring" || got.Status.InitDataSHA256 != before.Annotations[measurementAnnotation] {
		t.Fatal("a terminating Pod was reported as a new measurement", got.Status)
	}
	var claim corev1.PersistentVolumeClaim
	if err := c.Get(ctx, client.ObjectKeyFromObject(pvc), &claim); err != nil {
		t.Fatal("claim was removed")
	}
}
func TestRendererUpgradeReportsExistingPodMeasurement(t *testing.T) {
	w, s, pvc := fixture("qualified", "upgrade")
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).Build()
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &testRenderer{}}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	pod := getPods(t, c)[0]
	original := pod.Annotations[measurementAnnotation]
	// A new operator process has a new renderer, but the declaration is unchanged.
	r = &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme,
		Renderer: &testRenderer{document: "reviewed guest v2"}}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	state := getWorkload(t, c, w).Status
	if state.Phase != "UpdatePending" || state.Reason != "MeasurementChanged" ||
		state.InitDataSHA256 != original || len(getPods(t, c)) != 1 {
		t.Fatalf("renderer upgrade misreported or replaced the enrolled Pod: %+v", state)
	}
}

func TestStoppedStorageReasonUsesOnlyTypedExitCodes(t *testing.T) {
	for _, candidate := range []struct {
		code   int32
		reason string
	}{{5, "StorageUnlockDenied"}, {6, "StorageFormatDenied"}, {8, "DevicePrerequisiteMissing"}, {1, "PodStopped"}} {
		pod := &corev1.Pod{Status: corev1.PodStatus{InitContainerStatuses: []corev1.ContainerStatus{{
			Name: "nebula-storage-data", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: candidate.code}},
		}}}}
		if got := podStopReason(pod); got != candidate.reason {
			t.Fatalf("exit %d: got %s, expected %s", candidate.code, got, candidate.reason)
		}
	}
}

func TestStoredPodMeasurementRejectsTrailingGzipData(t *testing.T) {
	w, _, _ := fixture("qualified", "measure")
	plan, err := (&testRenderer{}).Render(context.Background(), w, nil)
	if err != nil {
		t.Fatal(err)
	}
	pod := plan.Pod
	if _, err := podInitDataSHA256(&pod); err != nil {
		t.Fatalf("valid measured Pod rejected: %v", err)
	}
	compressed, err := base64.StdEncoding.DecodeString(pod.Annotations[initDataAnnotation])
	if err != nil {
		t.Fatal(err)
	}
	compressed = append(compressed, []byte("unmeasured trailing data")...)
	pod.Annotations[initDataAnnotation] = base64.StdEncoding.EncodeToString(compressed)
	if _, err := podInitDataSHA256(&pod); err == nil {
		t.Fatal("unmeasured bytes after the first gzip member were accepted")
	}
}

func TestKubernetesFailureExposesOnlyItsStatusCategory(t *testing.T) {
	failure := kubeFailure("PodCreateFailed", "workload Pod creation failed", errors.New("sensitive admission detail"))
	if failure.Error() != "workload Pod creation failed (Unknown)" ||
		failure.(*publicFailure).Reason() != "PodCreateFailed" {
		t.Fatalf("raw API failure escaped into workload status: %v", failure)
	}
	forged := &apierrors.StatusError{ErrStatus: metav1.Status{Reason: "secret-from-admission-webhook", Message: "sensitive detail"}}
	if got := kubeFailure("PodCreateFailed", "workload Pod creation failed", forged).Error(); got != "workload Pod creation failed (Unknown)" {
		t.Fatalf("unrecognized Kubernetes status reason escaped: %s", got)
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
	if len(services.Items) != 4 {
		t.Fatal("service collision")
	}
	for _, service := range services.Items {
		ownerEndpoint := strings.HasSuffix(service.Name, "-owner")
		if service.Spec.PublishNotReadyAddresses != ownerEndpoint ||
			(ownerEndpoint && (len(service.Spec.Ports) != 1 || service.Spec.Ports[0].Port != 8443)) {
			t.Fatal("only the attested owner endpoint may bypass application readiness")
		}
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
	for _, scenario := range []string{"filesystem", "foreign-pod", "multiple-pods", "foreign-service", "foreign-owner-service"} {
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
			case "foreign-service", "foreign-owner-service":
				name := w.Name
				if scenario == "foreign-owner-service" {
					name += "-owner"
				}
				objects = append(objects, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: w.Namespace}})
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
	ownerKey := types.NamespacedName{Namespace: w.Namespace, Name: w.Name + "-owner"}
	_ = c.Get(ctx, ownerKey, &service)
	service.Spec.PublishNotReadyAddresses = false
	service.Spec.Ports = append(service.Spec.Ports, corev1.ServicePort{Name: "app", Port: 9080})
	_ = c.Update(ctx, &service)
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	_ = c.Get(ctx, ownerKey, &service)
	if !service.Spec.PublishNotReadyAddresses || len(service.Spec.Ports) != 1 || service.Spec.Ports[0].Port != 8443 {
		t.Fatal("owner bootstrap endpoint lost readiness-independent, owner-only routing")
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
