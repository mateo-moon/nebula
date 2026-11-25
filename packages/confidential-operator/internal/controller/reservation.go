package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

const storageFinalizer = "confidential.nebula.dev/retire-guest"
const reservationLabel = "confidential.nebula.dev/storage-consumer"

func reservationName(pvc *corev1.PersistentVolumeClaim) string {
	hash := sha256.Sum256([]byte(pvc.Namespace + "/" + string(pvc.UID)))
	return "confidential-storage-" + hex.EncodeToString(hash[:16])
}

// This non-expiring Lease is a normal orchestration guard, not a hardware
// singleton against administrators. Guest MMP and owner instance/key policies
// remain unchanged. Never steal a reservation because a timeout elapsed.
func (r *WorkloadReconciler) reserveStorage(ctx context.Context, w *api.ConfidentialWorkload, storages []api.ConfidentialStorage, expectedPod *corev1.Pod) error {
	names := map[string]bool{}
	claims := map[string]bool{}
	for _, s := range storages {
		var spec storageRouting
		if jsonUnmarshalStorage(s, &spec) != nil {
			return errors.New("invalid storage declaration")
		}
		if spec.Type != "EncryptedBlock" {
			continue
		}
		pvc, err := blockClaim(ctx, r.Reader, s.Namespace, spec.ClaimName)
		if err != nil {
			return err
		}
		if pvc.UID == "" {
			return errors.New("block claim identity is unavailable")
		}
		names[reservationName(pvc)] = true
		claims[pvc.Name] = true
	}

	pods, err := r.namespacePods(ctx, w.Namespace)
	if err != nil {
		return err
	}
	ownPresent := false
	for i := range pods {
		pod := &pods[i]
		same := expectedPod != nil && pod.Name == expectedPod.Name && pod.UID == expectedPod.UID && ownedBy(pod, w)
		if same {
			ownPresent = true
			continue
		}
		// Terminating Pods still hold the claim until their actual API object is
		// gone. This also covers pre-upgrade Pods whose Lease has never existed or
		// was independently garbage-collected during foreground retirement.
		for _, volume := range pod.Spec.Volumes {
			if volume.PersistentVolumeClaim != nil && claims[volume.PersistentVolumeClaim.ClaimName] {
				return &publicFailure{reason: "StorageInUse", message: "Encrypted block storage is still referenced by another Pod"}
			}
		}
	}
	if !ownPresent {
		// A prior multi-claim attempt may have failed its rollback. With no actual
		// owned Pod, all its leases are unused; retry their cleanup before taking
		// any new reservation instead of permanently retaining a partial set.
		var previous coordinationv1.LeaseList
		if err := r.Reader.List(ctx, &previous, client.InNamespace(w.Namespace), client.MatchingLabels{reservationLabel: string(w.UID)}); err != nil {
			return kubeFailure("StorageReservationCleanupFailed", "unused storage reservations could not be inspected", err)
		}
		for i := range previous.Items {
			lease := &previous.Items[i]
			if !ownedBy(lease, w) || lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity != string(w.UID) {
				return errors.New("unused storage reservation ownership conflicts")
			}
			if err := r.Delete(ctx, lease, client.Preconditions{UID: &lease.UID}); err != nil && !apierrors.IsNotFound(err) {
				return kubeFailure("StorageReservationCleanupFailed", "unused storage reservation cleanup will retry", err)
			}
		}
	}
	ordered := []string{}
	for name := range names {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	created := []coordinationv1.Lease{}
	rollback := func() error {
		if ownPresent {
			return nil
		}
		for i := range created {
			lease := &created[i]
			if err := r.Delete(ctx, lease, client.Preconditions{UID: &lease.UID}); err != nil && !apierrors.IsNotFound(err) {
				return err
			}
		}
		return nil
	}
	fail := func(err error) error {
		if cleanup := rollback(); cleanup != nil {
			return kubeFailure("StorageReservationCleanupFailed", "unused storage reservation cleanup will retry", cleanup)
		}
		return err
	}
	for _, name := range ordered {
		var lease coordinationv1.Lease
		err := r.Reader.Get(ctx, types.NamespacedName{Namespace: w.Namespace, Name: name}, &lease)
		if apierrors.IsNotFound(err) {
			holder := string(w.UID)
			lease = coordinationv1.Lease{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: w.Namespace, Labels: map[string]string{reservationLabel: string(w.UID)}, OwnerReferences: []metav1.OwnerReference{ownerReference(w)}}, Spec: coordinationv1.LeaseSpec{HolderIdentity: &holder}}
			err = r.Create(ctx, &lease)
			if err == nil {
				created = append(created, lease)
				continue
			}
			if apierrors.IsAlreadyExists(err) {
				err = r.Reader.Get(ctx, client.ObjectKeyFromObject(&lease), &lease)
			}
		}
		if err != nil {
			return fail(kubeFailure("StorageReservationFailed", "storage reservation failed", err))
		}
		if !lease.DeletionTimestamp.IsZero() || !ownedBy(&lease, w) || lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity != string(w.UID) {
			return fail(&publicFailure{reason: "StorageInUse", message: "Encrypted block storage is reserved by another workload"})
		}
	}
	return nil
}
func jsonUnmarshalStorage(s api.ConfidentialStorage, out *storageRouting) error {
	return json.Unmarshal(s.Spec.Raw, out)
}
func (r *WorkloadReconciler) retire(ctx context.Context, w *api.ConfidentialWorkload) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(w, storageFinalizer) {
		r.forget(client.ObjectKeyFromObject(w))
		return ctrl.Result{}, nil
	}
	all, err := r.namespacePods(ctx, w.Namespace)
	if err != nil {
		return ctrl.Result{}, err
	}
	pods := []corev1.Pod{}
	for i := range all {
		if ownedBy(&all[i], w) || all[i].Labels[ownerLabel] == string(w.UID) {
			pods = append(pods, all[i])
		}
	}
	for i := range pods {
		pod := &pods[i]
		if !ownedBy(pod, w) {
			return ctrl.Result{}, errors.New("cannot retire a Pod with conflicting ownership")
		}
		if pod.DeletionTimestamp.IsZero() {
			if err := r.Delete(ctx, pod, client.Preconditions{UID: &pod.UID}); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
	}
	if len(pods) > 0 {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	var leases coordinationv1.LeaseList
	if err := r.Reader.List(ctx, &leases, client.InNamespace(w.Namespace), client.MatchingLabels{reservationLabel: string(w.UID)}); err != nil {
		return ctrl.Result{}, err
	}
	for i := range leases.Items {
		lease := &leases.Items[i]
		if !ownedBy(lease, w) || lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity != string(w.UID) {
			return ctrl.Result{}, errors.New("cannot release a reservation with conflicting ownership")
		}
		if err := r.Delete(ctx, lease, client.Preconditions{UID: &lease.UID}); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	before := w.DeepCopy()
	controllerutil.RemoveFinalizer(w, storageFinalizer)
	if err := r.Patch(ctx, w, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{})); err != nil {
		return ctrl.Result{}, err
	}
	r.forget(client.ObjectKeyFromObject(w))
	return ctrl.Result{}, nil
}

func (r *WorkloadReconciler) namespacePods(ctx context.Context, namespace string) ([]corev1.Pod, error) {
	result := []corev1.Pod{}
	continuation := ""
	for {
		var page corev1.PodList
		options := []client.ListOption{client.InNamespace(namespace), client.Limit(256)}
		if continuation != "" {
			options = append(options, client.Continue(continuation))
		}
		if err := r.Reader.List(ctx, &page, options...); err != nil {
			return nil, kubeFailure("PodLookupFailed", "namespace Pod inventory is unavailable", err)
		}
		result = append(result, page.Items...)
		if len(result) > 4096 {
			return nil, &publicFailure{reason: "PodInventoryLimit", message: "Namespace Pod inventory exceeds the safe inspection bound"}
		}
		continuation = page.Continue
		if continuation == "" {
			return result, nil
		}
	}
}
