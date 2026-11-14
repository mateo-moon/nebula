package controller

import (
	"context"
	"encoding/json"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"reflect"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"testing"
)

func TestKnownKataAccountingDoesNotRelaxExecutionOrResources(t *testing.T) {
	name := "kata-qemu-snp"
	expected := &corev1.Pod{Spec: corev1.PodSpec{RuntimeClassName: &name, Containers: []corev1.Container{{Name: "app", Image: "example.invalid/app"}}}}
	admitted := expected.DeepCopy()
	admitted.Spec.Overhead = corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("2Gi")}
	if !podMatchesPlan(admitted, expected) {
		t.Fatal("supported fixed RuntimeClass accounting was refused")
	}
	for _, scenario := range []string{"cpu", "memory", "extra-accounting", "pod-resources", "process", "runtime"} {
		t.Run(scenario, func(t *testing.T) {
			actual, want := admitted.DeepCopy(), expected.DeepCopy()
			switch scenario {
			case "cpu":
				actual.Spec.Overhead[corev1.ResourceCPU] = resource.MustParse("2")
			case "memory":
				actual.Spec.Overhead[corev1.ResourceMemory] = resource.MustParse("4Gi")
			case "extra-accounting":
				actual.Spec.Overhead[corev1.ResourceEphemeralStorage] = resource.MustParse("1Gi")
			case "pod-resources":
				actual.Spec.Resources = &corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("2Gi")}}
			case "process":
				actual.Spec.Containers[0].Command = []string{"/unapproved"}
			case "runtime":
				other := "other-runtime"
				actual.Spec.RuntimeClassName = &other
				want.Spec.RuntimeClassName = &other
			}
			if podMatchesPlan(actual, want) {
				t.Fatal("unexpected admission/execution mutation was ignored")
			}
		})
	}
}
func TestNativeWorkloadReceivesProfileRoutingWithoutChangingGuestPolicy(t *testing.T) {
	w, s, pvc := fixture("qualified", "native-profile")
	var spec map[string]any
	_ = json.Unmarshal(w.Spec.Raw, &spec)
	spec["profile"] = "native-profile"
	w.Spec.Raw, _ = json.Marshal(spec)
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).Build()
	render := &testRenderer{}
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: render}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	var selected corev1.PodList
	if err := c.List(context.Background(), &selected, client.InNamespace(w.Namespace), client.MatchingLabels{profileLabel: "native-profile"}); err != nil {
		t.Fatal(err)
	}
	if len(selected.Items) != 1 || selected.Items[0].Labels[ownerLabel] != string(w.UID) {
		t.Fatal("native public profile selector cannot identify the owned Pod")
	}
	plan, err := render.Render(context.Background(), w, nil)
	if err != nil {
		t.Fatal(err)
	}
	actualHash, err := podInitDataSHA256(&selected.Items[0])
	if err != nil || actualHash != plan.InitDataSHA256 {
		t.Fatal("routing metadata changed measured guest policy")
	}
}

func TestMissingProfileRepairOnlyTouchesVerifiedOwnedMetadata(t *testing.T) {
	for _, scenario := range []string{"legitimate", "foreign", "wrong-spec", "wrong-profile"} {
		t.Run(scenario, func(t *testing.T) {
			w, s, pvc := fixture("qualified", "routing-repair")
			var spec map[string]any
			_ = json.Unmarshal(w.Spec.Raw, &spec)
			spec["profile"] = "routing-repair"
			w.Spec.Raw, _ = json.Marshal(spec)
			scheme := testScheme()
			patches := 0
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w, s).WithObjects(w, s, pvc).WithInterceptorFuncs(interceptor.Funcs{
				Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
					if pod, ok := obj.(*corev1.Pod); ok {
						pod.UID = "retained-instance"
					}
					return c.Create(ctx, obj, opts...)
				},
				Patch: func(ctx context.Context, c client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
					if _, ok := obj.(*corev1.Pod); ok {
						patches++
						raw, err := patch.Data(obj)
						if err != nil {
							t.Fatal(err)
						}
						var ops []map[string]any
						_ = json.Unmarshal(raw, &ops)
						if len(ops) != 5 || ops[0]["path"] != "/metadata/uid" || ops[1]["path"] != "/metadata/resourceVersion" || ops[4]["op"] != "add" || ops[4]["path"] != "/metadata/labels/confidential.nebula.dev~1profile" {
							t.Fatal("repair was not the bounded identity-guarded metadata patch")
						}
					}
					return c.Patch(ctx, obj, patch, opts...)
				},
			}).Build()
			r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &testRenderer{}}
			if err := run(t, r, w); err != nil {
				t.Fatal(err)
			}
			pod := getPods(t, c)[0]
			delete(pod.Labels, profileLabel)
			switch scenario {
			case "foreign":
				pod.OwnerReferences[0].UID = "another-owner"
			case "wrong-spec":
				pod.Spec.Containers[0].Image = "example.invalid/changed"
			case "wrong-profile":
				pod.Labels[profileLabel] = "other-profile"
			}
			if err := c.Update(context.Background(), &pod); err != nil {
				t.Fatal(err)
			}
			before := pod.DeepCopy()
			_ = run(t, r, w)
			after := getPods(t, c)[0]
			originalSpec, _ := json.Marshal(before.Spec)
			actualSpec, _ := json.Marshal(after.Spec)
			if string(originalSpec) != string(actualSpec) || before.UID != after.UID || !reflect.DeepEqual(before.Annotations, after.Annotations) || !reflect.DeepEqual(before.OwnerReferences, after.OwnerReferences) {
				t.Fatal("routing repair changed execution, checkpoint or ownership")
			}
			if scenario == "legitimate" {
				if patches != 1 || after.Labels[profileLabel] != "routing-repair" {
					t.Fatal("owned routing metadata was not repaired")
				}
			} else if patches != 0 || !reflect.DeepEqual(before.Labels, after.Labels) {
				t.Fatal("unverified/conflicting Pod metadata was modified")
			}
		})
	}
}
