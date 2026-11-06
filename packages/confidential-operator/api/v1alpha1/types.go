package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// Specs retain their complete JSON representation for the shared Nebula
// validator/renderer. Its structural CRD schemas are the single authority;
// make manifests exports them without weakening admission validation.
// Neither this API nor the controller accepts private provisioning material.
type Status struct {
	ObservedGeneration int64  `json:"observedGeneration,omitempty"`
	Phase              string `json:"phase,omitempty"`
	Reason             string `json:"reason,omitempty"`
	Message            string `json:"message,omitempty"`
	PodName            string `json:"podName,omitempty"`
	PodUID             string `json:"podUid,omitempty"`
	SpecSHA256         string `json:"specSha256,omitempty"`
	InitDataSHA256     string `json:"initDataSha256,omitempty"`
	AccessTokenSHA256  string `json:"accessTokenSha256,omitempty"`
	AccessSecretName   string `json:"accessSecretName,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
type ConfidentialWorkload struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              runtime.RawExtension `json:"spec"`
	Status            Status               `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type ConfidentialWorkloadList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ConfidentialWorkload `json:"items"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
type ConfidentialStorage struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              runtime.RawExtension `json:"spec"`
	Status            Status               `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type ConfidentialStorageList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ConfidentialStorage `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(scheme *runtime.Scheme) error {
		scheme.AddKnownTypes(GroupVersion, &ConfidentialWorkload{}, &ConfidentialWorkloadList{}, &ConfidentialStorage{}, &ConfidentialStorageList{})
		return nil
	})
}
