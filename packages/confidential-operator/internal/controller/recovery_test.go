package controller

import (
	"context"
	"encoding/json"
	"errors"
	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"strings"
	"testing"
	"time"
)

type bindingRenderer struct {
	testRenderer
	digest   string
	supplied map[string]string
}

func (r *bindingRenderer) Render(ctx context.Context, w *api.ConfidentialWorkload, s []api.ConfidentialStorage) (*Plan, error) {
	p, err := r.testRenderer.Render(ctx, w, s)
	if err != nil {
		return nil, err
	}
	r.supplied = w.Status.ResolvedImageDigests
	digest := r.digest
	if v := w.Status.ResolvedImageDigests["registry.example/app:release"]; v != "" {
		digest = v
	}
	p.ResolvedImageDigests = map[string]string{"registry.example/app:release": digest}
	p.Pod.Spec.Containers[0].Image = "registry.example/app@" + digest
	return p, nil
}
func TestResolvedPublicationSurvivesRestartAndDesiredEditIsExplicit(t *testing.T) {
	w, s, pvc := fixture("qualified", "durable")
	w.Spec.Raw = []byte(`{"containers":[{"name":"app","image":"registry.example/app:release","imageKeyResource":["default","image","app"]}],"storage":[{"name":"data","resource":"disk"}]}`)
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).Build()
	first := &bindingRenderer{digest: "sha256:" + strings.Repeat("a", 64)}
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: first}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	original := getPods(t, c)[0]
	state := getWorkload(t, c, w).Status
	if state.DesiredSpecSHA256 == "" || state.ResolvedImageDigests["registry.example/app:release"] != first.digest {
		t.Fatal("resolved tag was not durably checkpointed", state)
	}
	moved := &bindingRenderer{digest: "sha256:" + strings.Repeat("b", 64)}
	r = &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: moved}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if moved.supplied["registry.example/app:release"] != first.digest || getPods(t, c)[0].Spec.Containers[0].Image != original.Spec.Containers[0].Image {
		t.Fatal("restart followed a moved tag")
	}
	w = getWorkload(t, c, w)
	w.Generation++
	w.Spec.Raw = []byte(`{"containers":[{"name":"app","image":"registry.example/app:next","imageKeyResource":["default","image","app"]}],"storage":[{"name":"data","resource":"disk"}]}`)
	if err := c.Update(context.Background(), w); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if getWorkload(t, c, w).Status.Phase != "UpdatePending" || len(getPods(t, c)) != 1 || moved.calls != 1 {
		t.Fatal("an explicit tag edit silently replaced or rerendered the enrolled Pod")
	}
}
func TestServiceFailureKeepsActualPodTracking(t *testing.T) {
	w, s, pvc := fixture("qualified", "occupied")
	scheme := testScheme()
	foreign := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: w.Name, Namespace: w.Namespace}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc, foreign).WithInterceptorFuncs(interceptor.Funcs{Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
		if pod, ok := obj.(*corev1.Pod); ok {
			pod.UID = "actual-created-instance"
		}
		return c.Create(ctx, obj, opts...)
	}}).Build()
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &testRenderer{}}
	if run(t, r, w) == nil {
		t.Fatal("foreign service accepted")
	}
	state := getWorkload(t, c, w).Status
	if state.PodUID != "actual-created-instance" || state.PodName == "" || state.InitDataSHA256 == "" || state.DesiredSpecSHA256 == "" {
		t.Fatal("routing error erased created Pod tracking", state)
	}
}
func TestPodAdoptionRejectsActualExecutionMutations(t *testing.T) {
	for _, mutation := range []string{"image", "command", "env", "host", "runtime", "volume"} {
		t.Run(mutation, func(t *testing.T) {
			w, s, pvc := fixture("qualified", "mutated")
			scheme := testScheme()
			render := &testRenderer{}
			p, _ := render.Render(context.Background(), w, []api.ConfidentialStorage{*s})
			pod := p.Pod.DeepCopy()
			pod.Name = "existing"
			pod.GenerateName = ""
			pod.OwnerReferences = []metav1.OwnerReference{ownerReference(w)}
			pod.Labels = map[string]string{ownerLabel: string(w.UID)}
			pod.Annotations[renderLabel] = p.SpecSHA256
			switch mutation {
			case "image":
				pod.Spec.Containers[0].Image = "evil.example/other"
			case "command":
				pod.Spec.Containers[0].Command = []string{"/evil"}
			case "env":
				pod.Spec.Containers[0].Env = []corev1.EnvVar{{Name: "EVIL", Value: "1"}}
			case "host":
				pod.Spec.HostNetwork = true
			case "runtime":
				v := "runc"
				pod.Spec.RuntimeClassName = &v
			case "volume":
				pod.Spec.Volumes = []corev1.Volume{{Name: "host", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/"}}}}
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc, pod).Build()
			r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: render}
			if err := run(t, r, w); err != nil {
				t.Fatal(err)
			}
			if got := getWorkload(t, c, w).Status; got.Reason != "PodSpecMismatch" {
				t.Fatal("mutated execution was adopted", got)
			}
			var services corev1.ServiceList
			_ = c.List(context.Background(), &services)
			if len(services.Items) != 0 {
				t.Fatal("mutated Pod received routing")
			}
		})
	}
}

type failedRenderer struct {
	testRenderer
	err error
}

func (r *failedRenderer) Render(context.Context, *api.ConfidentialWorkload, []api.ConfidentialStorage) (*Plan, error) {
	r.calls++
	return nil, r.err
}
func TestFailedRenderingIsBoundedAndValidationWaitsForAnEdit(t *testing.T) {
	for _, permanent := range []bool{false, true} {
		t.Run(map[bool]string{false: "transient", true: "permanent"}[permanent], func(t *testing.T) {
			w, s, pvc := fixture("qualified", "failure")
			scheme := testScheme()
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).Build()
			render := &failedRenderer{err: errors.New("native rendering unavailable")}
			if permanent {
				render.err = &renderDiagnostic{reason: "InvalidDeclaration", message: "Confidential workload: invalid input"}
			}
			now := time.Now()
			r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: render, Now: func() time.Time { return now }}
			for range 8 {
				result, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(w)})
				if err != nil {
					t.Fatal(err)
				}
				if permanent && result.RequeueAfter != 0 {
					t.Fatal("invalid declaration was scheduled repeatedly")
				}
			}
			if render.calls != 1 {
				t.Fatalf("failed render ran %d times", render.calls)
			}
			now = now.Add(16 * time.Second)
			_ = run(t, r, w)
			want := 2
			if permanent {
				want = 1
			}
			if render.calls != want {
				t.Fatal("backoff/permanent classification was lost")
			}
			w = getWorkload(t, c, w)
			w.Generation++
			w.Spec = runtime.RawExtension{Raw: json.RawMessage(`{"containers":[],"storage":[]}`)}
			if err := c.Update(context.Background(), w); err != nil {
				t.Fatal(err)
			}
			_ = run(t, r, w)
			if render.calls != want+1 {
				t.Fatal("an explicit desired edit did not invalidate the failed-render checkpoint")
			}
		})
	}
}
func TestEncryptedStorageHasOneNormalConsumerUntilActualPodIsGone(t *testing.T) {
	w, s, pvc := fixture("qualified", "first")
	other := w.DeepCopy()
	other.Name = "second"
	other.UID = "second-uid"
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, other, s, pvc).Build()
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &testRenderer{}}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, other); err != nil {
		t.Fatal(err)
	}
	if len(getPods(t, c)) != 1 || getWorkload(t, c, other).Status.Reason != "StorageInUse" {
		t.Fatal("two normal workloads consumed the same block claim")
	}
	current := getWorkload(t, c, w)
	if err := c.Delete(context.Background(), current); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, other); err != nil {
		t.Fatal(err)
	}
	if len(getPods(t, c)) != 1 || !ownedBy(&getPods(t, c)[0], other) {
		t.Fatal("completed retirement did not free the advisory reservation")
	}
	var claim corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), &claim); err != nil || claim.UID != pvc.UID {
		t.Fatal("retirement altered the ciphertext claim")
	}
}

func TestOldCRDPruningUsesPodCheckpointWithoutAStatusWriteLoop(t *testing.T) {
	w, s, pvc := fixture("qualified", "old-crd")
	w.Spec.Raw = []byte(`{"containers":[{"name":"app","image":"registry.example/app:release","imageKeyResource":["default","image","app"]}],"storage":[{"name":"data","resource":"disk"}]}`)
	scheme := testScheme()
	writes := 0
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).WithInterceptorFuncs(interceptor.Funcs{SubResourcePatch: func(ctx context.Context, c client.Client, sub string, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
		if value, ok := obj.(*api.ConfidentialWorkload); ok && sub == "status" {
			writes++
			value.Status.DesiredSpecSHA256 = ""
			value.Status.ResolvedImageDigests = nil
		}
		return c.SubResource(sub).Patch(ctx, obj, patch, opts...)
	}}).Build()
	original := "sha256:" + strings.Repeat("a", 64)
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &bindingRenderer{digest: original}}
	for range 4 {
		if err := run(t, r, w); err != nil {
			t.Fatal(err)
		}
	}
	if writes != 1 {
		t.Fatalf("old status schema caused repeated writes: %d", writes)
	}
	renderer := &bindingRenderer{digest: "sha256:" + strings.Repeat("b", 64)}
	r = &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: renderer}
	for range 4 {
		if err := run(t, r, w); err != nil {
			t.Fatal(err)
		}
	}
	if writes != 2 || renderer.supplied["registry.example/app:release"] != original || len(getPods(t, c)) != 1 {
		t.Fatal("pruned status lost the actual Pod pin or caused a write loop", writes, renderer.supplied)
	}
}

type volumeRenderer struct{ testRenderer }

func (r *volumeRenderer) Render(ctx context.Context, w *api.ConfidentialWorkload, storage []api.ConfidentialStorage) (*Plan, error) {
	p, err := r.testRenderer.Render(ctx, w, storage)
	if err != nil {
		return nil, err
	}
	for _, s := range storage {
		var spec storageRouting
		_ = json.Unmarshal(s.Spec.Raw, &spec)
		if spec.Type == "EncryptedBlock" {
			p.Pod.Spec.Volumes = append(p.Pod.Spec.Volumes, corev1.Volume{Name: s.Name, VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: spec.ClaimName}}})
		}
	}
	return p, nil
}
func TestLegacyPodWithoutLeaseBlocksNewConsumerBeforeAdoption(t *testing.T) {
	for _, terminating := range []bool{false, true} {
		t.Run(map[bool]string{false: "running", true: "terminating"}[terminating], func(t *testing.T) {
			ctx := context.Background()
			w, s, pvc := fixture("qualified", "legacy")
			other := w.DeepCopy()
			other.Name = "new-consumer"
			other.UID = "new-consumer-uid"
			scheme := testScheme()
			renderer := &volumeRenderer{}
			plan, _ := renderer.Render(ctx, w, []api.ConfidentialStorage{*s})
			pod := plan.Pod.DeepCopy()
			pod.Name = "legacy-actual"
			pod.GenerateName = ""
			pod.UID = "legacy-pod-uid"
			pod.OwnerReferences = []metav1.OwnerReference{ownerReference(w)}
			pod.Labels = map[string]string{ownerLabel: string(w.UID)}
			pod.Annotations[renderLabel] = plan.SpecSHA256
			if terminating {
				pod.Finalizers = []string{"test.nebula.dev/retain"}
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, other, s, pvc, pod).Build()
			if terminating {
				if err := c.Delete(ctx, pod); err != nil {
					t.Fatal(err)
				}
			}
			r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: renderer}
			if err := run(t, r, other); err != nil {
				t.Fatal(err)
			}
			if len(getPods(t, c)) != 1 || getWorkload(t, c, other).Status.Reason != "StorageInUse" {
				t.Fatal("a new consumer won the legacy migration race")
			}
			if !terminating {
				if err := run(t, r, w); err != nil {
					t.Fatal(err)
				}
				var lease coordinationv1.Lease
				if err := c.Get(ctx, client.ObjectKey{Namespace: w.Namespace, Name: reservationName(pvc)}, &lease); err != nil || lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity != string(w.UID) {
					t.Fatal("verified existing Pod did not acquire its advisory reservation", err)
				}
			}
			if len(getPods(t, c)) != 1 {
				t.Fatal("migration replaced a guest")
			}
		})
	}
}
func TestFailedRollbackIsRetriedWithoutLeavingAnUnusedClaimReserved(t *testing.T) {
	ctx := context.Background()
	w, s, pvc := fixture("qualified", "partial")
	other := w.DeepCopy()
	other.Name = "foreign"
	other.UID = "foreign-uid"
	scheme := testScheme()
	second := pvc.DeepCopy()
	second.Name = "other-pvc"
	second.UID = "other-pvc-uid"
	second.ResourceVersion = ""
	// Ensure the foreign reservation is encountered after a new own lease.
	if reservationName(pvc) > reservationName(second) {
		pvc.UID, second.UID = second.UID, pvc.UID
	}
	storageB := s.DeepCopy()
	storageB.Name = "other-disk"
	storageB.Spec.Raw = []byte(`{"type":"EncryptedBlock","claimName":"other-pvc"}`)
	w.Spec.Raw = []byte(`{"containers":[{"ports":[{"name":"proof","port":9080}]}],"storage":[{"name":"a","resource":"disk"},{"name":"b","resource":"other-disk"}]}`)
	holder := string(other.UID)
	foreign := &coordinationv1.Lease{ObjectMeta: metav1.ObjectMeta{Name: reservationName(second), Namespace: w.Namespace, Labels: map[string]string{reservationLabel: holder}, OwnerReferences: []metav1.OwnerReference{ownerReference(other)}}, Spec: coordinationv1.LeaseSpec{HolderIdentity: &holder}}
	failDelete := true
	deletes := 0
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s, storageB).WithObjects(w, s, storageB, pvc, second, foreign).WithInterceptorFuncs(interceptor.Funcs{Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
		if lease, ok := obj.(*coordinationv1.Lease); ok && lease.Labels[reservationLabel] == string(w.UID) {
			deletes++
			if failDelete {
				failDelete = false
				return errors.New("synthetic transient API failure")
			}
		}
		return c.Delete(ctx, obj, opts...)
	}}).Build()
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &volumeRenderer{}}
	if run(t, r, w) == nil {
		t.Fatal("rollback failure was hidden")
	}
	if getWorkload(t, c, w).Status.Reason != "StorageReservationCleanupFailed" {
		t.Fatal("rollback diagnostic was lost")
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	var leases coordinationv1.LeaseList
	_ = c.List(ctx, &leases, client.InNamespace(w.Namespace), client.MatchingLabels{reservationLabel: string(w.UID)})
	if deletes < 2 || len(leases.Items) != 0 || len(getPods(t, c)) != 0 {
		t.Fatal("a failed rollback left an unused partial reservation")
	}
}
