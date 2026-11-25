package v1alpha1

import (
	"bytes"
	"encoding/json"
	"testing"
)

// The shared structural SDK schema remains the authority. RawExtension must
// retain the opt-in public store declaration without rewriting legacy specs.
func TestOptionalImageStoreRoundTripsWithoutChangingLegacySpec(t *testing.T) {
	for _, spec := range []string{
		`{"profile":"legacy","containers":[]}`,
		`{"profile":"new","imageStore":{"endpoint":"http://operator-images.namespace.svc:8084","writeEndpoint":"http://operator-images.namespace.svc:8085","repository":"namespace/workload"},"containers":[]}`,
	} {
		var value ConfidentialWorkload
		if err := json.Unmarshal([]byte(`{"apiVersion":"confidential.nebula.dev/v1alpha1","kind":"ConfidentialWorkload","metadata":{"name":"workload"},"spec":`+spec+`}`), &value); err != nil {
			t.Fatal(err)
		}
		copy := value.DeepCopy()
		if !bytes.Equal(value.Spec.Raw, []byte(spec)) || !bytes.Equal(copy.Spec.Raw, value.Spec.Raw) {
			t.Fatal("raw public declaration changed during decoding/deepcopy")
		}
		raw, err := json.Marshal(copy)
		if err != nil {
			t.Fatal(err)
		}
		var restored ConfidentialWorkload
		if err := json.Unmarshal(raw, &restored); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(restored.Spec.Raw, []byte(spec)) {
			t.Fatal("optional store or legacy declaration changed on roundtrip")
		}
	}
}
