package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

const ownerLabel = "confidential.nebula.dev/owner"
const renderLabel = "confidential.nebula.dev/spec-sha256"
const storageIndex = "spec.storage.resource"
const claimIndex = "spec.claimName"

// These projections are for Kubernetes routing only. The full spec is validated
// and rendered by the same TypeScript implementation used by the owner CLI.
type workloadRouting struct {
	Storage []struct {
		Name     string `json:"name"`
		Resource string `json:"resource"`
	} `json:"storage"`
	Containers []struct {
		Ports []struct {
			Name string `json:"name"`
			Port int32  `json:"port"`
		} `json:"ports"`
	} `json:"containers"`
}
type storageRouting struct {
	Type      string `json:"type"`
	ClaimName string `json:"claimName"`
}
type cachedPlan struct {
	key  string
	plan *Plan
}

type WorkloadReconciler struct {
	client.Client
	Reader   client.Reader // uncached read before creation prevents duplicate Pods
	Scheme   *runtime.Scheme
	Renderer Renderer
	mu       sync.Mutex
	plans    map[types.NamespacedName]cachedPlan
}

func (r *WorkloadReconciler) forget(key types.NamespacedName) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.plans, key)
}
func (r *WorkloadReconciler) plan(ctx context.Context, w *api.ConfidentialWorkload, s []api.ConfidentialStorage) (*Plan, error) {
	data, _ := json.Marshal(struct {
		UID     types.UID
		Spec    runtime.RawExtension
		Storage []json.RawMessage
	}{w.UID, w.Spec, storageSpecs(s)})
	// API merge patches may reorder object fields without changing the spec.
	var canonical any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&canonical); err != nil {
		return nil, errors.New("invalid declaration JSON")
	}
	data, _ = json.Marshal(canonical)
	hash := sha256.Sum256(data)
	key := hex.EncodeToString(hash[:])
	name := client.ObjectKeyFromObject(w)
	r.mu.Lock()
	cached, ok := r.plans[name]
	r.mu.Unlock()
	if ok && cached.key == key {
		return cached.plan, nil
	}
	p, err := r.Renderer.Render(ctx, w, s)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.plans == nil {
		r.plans = map[types.NamespacedName]cachedPlan{}
	}
	r.plans[name] = cachedPlan{key, p}
	return p, nil
}
func storageSpecs(items []api.ConfidentialStorage) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(items))
	for _, s := range items {
		b, _ := json.Marshal(struct {
			Name string
			Spec runtime.RawExtension
		}{s.Name, s.Spec})
		result = append(result, b)
	}
	return result
}
func (r *WorkloadReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var w api.ConfidentialWorkload
	if err := r.Get(ctx, req.NamespacedName, &w); err != nil {
		if apierrors.IsNotFound(err) {
			r.forget(req.NamespacedName)
		}
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !w.DeletionTimestamp.IsZero() {
		r.forget(req.NamespacedName)
		return ctrl.Result{}, nil
	}
	state, err := r.reconcile(ctx, &w)
	if err != nil {
		state = w.Status
		state.Phase = "Error"
		state.Message = err.Error()
	}
	state.ObservedGeneration = w.Generation
	if len(state.Message) > 512 {
		state.Message = "Reconciliation failed"
	}
	if !reflect.DeepEqual(w.Status, state) {
		before := w.DeepCopy()
		w.Status = state
		if e := r.Status().Patch(ctx, &w, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{})); e != nil {
			return ctrl.Result{}, errors.New("workload status update failed")
		}
	}
	// Errors use the controller-runtime rate-limited work queue, including missing
	// referenced resources. No fixed polling loop or raw API response is logged.
	return ctrl.Result{}, err
}
func (r *WorkloadReconciler) reconcile(ctx context.Context, w *api.ConfidentialWorkload) (api.Status, error) {
	var routing workloadRouting
	if json.Unmarshal(w.Spec.Raw, &routing) != nil || w.UID == "" {
		return api.Status{}, errors.New("invalid workload declaration")
	}
	storages := []api.ConfidentialStorage{}
	seen := map[string]bool{}
	for _, binding := range routing.Storage {
		if seen[binding.Resource] {
			continue
		}
		seen[binding.Resource] = true
		var s api.ConfidentialStorage
		if err := r.Get(ctx, types.NamespacedName{Namespace: w.Namespace, Name: binding.Resource}, &s); err != nil {
			return api.Status{}, errors.New("referenced storage is unavailable")
		}
		if !s.DeletionTimestamp.IsZero() {
			return api.Status{}, errors.New("referenced storage is being deleted")
		}
		var spec storageRouting
		if json.Unmarshal(s.Spec.Raw, &spec) != nil {
			return api.Status{}, errors.New("invalid storage declaration")
		}
		if spec.Type == "EncryptedBlock" {
			if _, err := blockClaim(ctx, r.Reader, s.Namespace, spec.ClaimName); err != nil {
				return api.Status{}, err
			}
		}
		storages = append(storages, s)
	}
	sort.Slice(storages, func(i, j int) bool { return storages[i].Name < storages[j].Name })
	plan, err := r.plan(ctx, w, storages)
	if err != nil {
		return api.Status{}, err
	}
	var pods corev1.PodList
	if err := r.Reader.List(ctx, &pods, client.InNamespace(w.Namespace), client.MatchingLabels{ownerLabel: string(w.UID)}); err != nil {
		return api.Status{}, errors.New("workload Pod lookup failed")
	}
	if len(pods.Items) > 1 {
		return api.Status{}, errors.New("conflicting workload Pods; owner intervention required")
	}
	var pod *corev1.Pod
	if len(pods.Items) == 1 {
		pod = &pods.Items[0]
		if !ownedBy(pod, w) {
			return api.Status{}, errors.New("conflicting Pod ownership; owner intervention required")
		}
		if pod.Annotations[renderLabel] != plan.SpecSHA256 {
			return api.Status{Phase: "UpdatePending", Message: "Configuration changed. Explicitly retire the current Pod and enroll its replacement.", PodName: pod.Name, PodUID: string(pod.UID)}, nil
		}
		if !pod.DeletionTimestamp.IsZero() {
			return api.Status{Phase: "Retiring", Message: "Waiting for the current Pod to terminate before creating a replacement", PodName: pod.Name, PodUID: string(pod.UID)}, nil
		}
	} else {
		pod = plan.Pod.DeepCopy()
		pod.OwnerReferences = []metav1.OwnerReference{ownerReference(w)}
		if pod.Labels == nil {
			pod.Labels = map[string]string{}
		}
		pod.Labels[ownerLabel] = string(w.UID)
		if pod.Annotations == nil {
			pod.Annotations = map[string]string{}
		}
		pod.Annotations[renderLabel] = plan.SpecSHA256
		if err := r.Create(ctx, pod); err != nil {
			return api.Status{}, errors.New("workload Pod creation failed")
		}
	}
	if err := r.service(ctx, w, routing); err != nil {
		return api.Status{}, err
	}
	state := api.Status{Phase: "AwaitingOwner", Message: "Owner verification and enrollment are required before provisioning keys", PodName: pod.Name, PodUID: string(pod.UID), SpecSHA256: plan.SpecSHA256, InitDataSHA256: plan.InitDataSHA256}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			state.Phase = "Running"
			state.Message = "Kubernetes reports ready; verify guest attestation with the owner CLI"
		}
	}
	if pod.Status.Phase == corev1.PodFailed || pod.Status.Phase == corev1.PodSucceeded {
		state.Phase = "Stopped"
		state.Message = "Explicitly retire the stopped Pod and enroll its replacement"
	}
	return state, nil
}
func ownerReference(w *api.ConfidentialWorkload) metav1.OwnerReference {
	yes, no := true, false
	return metav1.OwnerReference{APIVersion: api.GroupVersion.String(), Kind: "ConfidentialWorkload", Name: w.Name, UID: w.UID, Controller: &yes, BlockOwnerDeletion: &no}
}
func ownedBy(object client.Object, w *api.ConfidentialWorkload) bool {
	o := metav1.GetControllerOf(object)
	return o != nil && o.UID == w.UID && o.Kind == "ConfidentialWorkload" && o.APIVersion == api.GroupVersion.String() && o.Name == w.Name
}
func (r *WorkloadReconciler) service(ctx context.Context, w *api.ConfidentialWorkload, routing workloadRouting) error {
	ports := []corev1.ServicePort{{Name: "owner", Port: 8443, TargetPort: intstr.FromInt32(8443), Protocol: corev1.ProtocolTCP}}
	for _, c := range routing.Containers {
		for _, p := range c.Ports {
			ports = append(ports, corev1.ServicePort{Name: p.Name, Port: p.Port, TargetPort: intstr.FromInt32(p.Port), Protocol: corev1.ProtocolTCP})
		}
	}
	var s corev1.Service
	err := r.Reader.Get(ctx, client.ObjectKeyFromObject(w), &s)
	if apierrors.IsNotFound(err) {
		s = corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: w.Name, Namespace: w.Namespace, OwnerReferences: []metav1.OwnerReference{ownerReference(w)}}, Spec: corev1.ServiceSpec{Selector: map[string]string{ownerLabel: string(w.UID)}, Ports: ports}}
		if r.Create(ctx, &s) != nil {
			return errors.New("workload Service creation failed")
		}
		return nil
	}
	if err != nil {
		return errors.New("workload Service lookup failed")
	}
	if !ownedBy(&s, w) || len(s.Spec.Selector) != 1 || s.Spec.Selector[ownerLabel] != string(w.UID) {
		return errors.New("Service belongs to another resource")
	}
	if !reflect.DeepEqual(s.Spec.Ports, ports) {
		before := s.DeepCopy()
		s.Spec.Ports = ports
		if r.Patch(ctx, &s, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{})) != nil {
			return errors.New("workload Service update failed")
		}
	}
	return nil
}
func blockClaim(ctx context.Context, reader client.Reader, namespace, name string) (*corev1.PersistentVolumeClaim, error) {
	var pvc corev1.PersistentVolumeClaim
	if reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &pvc) != nil {
		return nil, errors.New("block claim is unavailable")
	}
	if !pvc.DeletionTimestamp.IsZero() || pvc.Spec.VolumeMode == nil || *pvc.Spec.VolumeMode != corev1.PersistentVolumeBlock {
		return nil, errors.New("encrypted storage requires an available raw block claim")
	}
	return &pvc, nil
}

type StorageReconciler struct {
	client.Client
	Reader   client.Reader
	Renderer Renderer
}

func (r *StorageReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var s api.ConfidentialStorage
	if err := r.Get(ctx, req.NamespacedName, &s); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !s.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}
	state := api.Status{ObservedGeneration: s.Generation, Phase: "Available", Message: "Guest memory storage"}
	err := r.Renderer.ValidateStorage(ctx, &s)
	var spec storageRouting
	if err == nil {
		err = json.Unmarshal(s.Spec.Raw, &spec)
	}
	if err == nil && spec.Type == "EncryptedBlock" {
		var pvc *corev1.PersistentVolumeClaim
		pvc, err = blockClaim(ctx, r.Reader, s.Namespace, spec.ClaimName)
		if err == nil {
			state.Message = "Ciphertext claim only; key custody and volume opening remain inside the guest"
			if pvc.Status.Phase != corev1.ClaimBound {
				state.Phase = "AwaitingBinding"
			}
		}
	}
	if err != nil {
		state.Phase = "Invalid"
		state.Message = "Storage validation failed or its raw block claim is unavailable"
		err = errors.New(state.Message)
	}
	if !reflect.DeepEqual(s.Status, state) {
		before := s.DeepCopy()
		s.Status = state
		if r.Status().Patch(ctx, &s, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{})) != nil {
			return ctrl.Result{}, errors.New("storage status update failed")
		}
	}
	return ctrl.Result{}, err
}

func (r *WorkloadReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := mgr.GetFieldIndexer().IndexField(context.Background(), &api.ConfidentialWorkload{}, storageIndex, func(o client.Object) []string {
		var s workloadRouting
		if json.Unmarshal(o.(*api.ConfidentialWorkload).Spec.Raw, &s) != nil {
			return nil
		}
		names := []string{}
		for _, b := range s.Storage {
			names = append(names, b.Resource)
		}
		return names
	}); err != nil {
		return err
	}
	return ctrl.NewControllerManagedBy(mgr).For(&api.ConfidentialWorkload{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).Owns(&corev1.Pod{}).Owns(&corev1.Service{}).
		Watches(&api.ConfidentialStorage{}, handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, o client.Object) []reconcile.Request {
			var items api.ConfidentialWorkloadList
			if r.List(ctx, &items, client.InNamespace(o.GetNamespace()), client.MatchingFields{storageIndex: o.GetName()}) != nil {
				return nil
			}
			requests := []reconcile.Request{}
			for _, w := range items.Items {
				requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&w)})
			}
			return requests
		})).Complete(r)
}
func (r *StorageReconciler) SetupWithManager(mgr ctrl.Manager) error {
	if err := mgr.GetFieldIndexer().IndexField(context.Background(), &api.ConfidentialStorage{}, claimIndex, func(o client.Object) []string {
		var s storageRouting
		if json.Unmarshal(o.(*api.ConfidentialStorage).Spec.Raw, &s) != nil || s.ClaimName == "" {
			return nil
		}
		return []string{s.ClaimName}
	}); err != nil {
		return err
	}
	return ctrl.NewControllerManagedBy(mgr).For(&api.ConfidentialStorage{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		Watches(&corev1.PersistentVolumeClaim{}, handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, o client.Object) []reconcile.Request {
			var items api.ConfidentialStorageList
			if r.List(ctx, &items, client.InNamespace(o.GetNamespace()), client.MatchingFields{claimIndex: o.GetName()}) != nil {
				return nil
			}
			requests := []reconcile.Request{}
			for _, s := range items.Items {
				requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&s)})
			}
			return requests
		})).Complete(r)
}

// Namespace restrictions are validated before any informer or client is started.
func ValidateNamespaces(names []string) error {
	if len(names) == 0 {
		return errors.New("WATCH_NAMESPACES is required")
	}
	seen := map[string]bool{}
	for _, n := range names {
		if n == "" || len(n) > 40 || seen[n] {
			return errors.New("invalid WATCH_NAMESPACES")
		}
		for i, c := range n {
			if !(c >= 'a' && c <= 'z') && !(i > 0 && (c == '-' || c >= '0' && c <= '9')) {
				return fmt.Errorf("invalid WATCH_NAMESPACES")
			}
		}
		seen[n] = true
	}
	return nil
}
