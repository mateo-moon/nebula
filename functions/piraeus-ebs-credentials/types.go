package main

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// PiraeusEbsCredentials is the typed view of the
// XPiraeusEbsCredentials composite resource.
type PiraeusEbsCredentials struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PiraeusEbsCredentialsSpec   `json:"spec"`
	Status PiraeusEbsCredentialsStatus `json:"status,omitempty"`
}

type PiraeusEbsCredentialsSpec struct {
	Region                    string            `json:"region"`
	IAMUserName               string            `json:"iamUserName"`
	AWSProviderConfigRef      string            `json:"awsProviderConfigRef"`
	CredentialSecretName      string            `json:"credentialSecretName"`
	CredentialSecretNamespace string            `json:"credentialSecretNamespace"`
	Tags                      map[string]string `json:"tags,omitempty"`
}

type PiraeusEbsCredentialsStatus struct {
	CredentialSecretRef *SecretReference `json:"credentialSecretRef,omitempty"`
}

type SecretReference struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

type resourceReference struct {
	Name string `json:"name"`
}

type selector struct {
	MatchControllerRef *bool             `json:"matchControllerRef,omitempty"`
	MatchLabels        map[string]string `json:"matchLabels,omitempty"`
}

type writeConnectionSecretReference struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

type managedResourceSpec struct {
	DeletionPolicy    string            `json:"deletionPolicy"`
	ProviderConfigRef resourceReference `json:"providerConfigRef"`
}

type iamUser struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              iamUserSpec `json:"spec"`
}

type iamUserSpec struct {
	managedResourceSpec `json:",inline"`
	ForProvider         iamUserParameters `json:"forProvider"`
}

type iamUserParameters struct {
	ForceDestroy bool              `json:"forceDestroy"`
	Path         string            `json:"path"`
	Tags         map[string]string `json:"tags,omitempty"`
}

type iamPolicy struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              iamPolicySpec `json:"spec"`
}

type iamPolicySpec struct {
	managedResourceSpec `json:",inline"`
	ForProvider         iamPolicyParameters `json:"forProvider"`
}

type iamPolicyParameters struct {
	Description string            `json:"description"`
	Path        string            `json:"path"`
	Policy      string            `json:"policy"`
	Tags        map[string]string `json:"tags,omitempty"`
}

type iamUserPolicyAttachment struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              iamUserPolicyAttachmentSpec `json:"spec"`
}

type iamUserPolicyAttachmentSpec struct {
	managedResourceSpec `json:",inline"`
	ForProvider         iamUserPolicyAttachmentParameters `json:"forProvider"`
}

type iamUserPolicyAttachmentParameters struct {
	PolicyARNSelector selector `json:"policyArnSelector"`
	UserSelector      selector `json:"userSelector"`
}

type iamAccessKey struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              iamAccessKeySpec `json:"spec"`
}

type iamAccessKeySpec struct {
	managedResourceSpec        `json:",inline"`
	ForProvider                iamAccessKeyParameters         `json:"forProvider"`
	WriteConnectionSecretToRef writeConnectionSecretReference `json:"writeConnectionSecretToRef"`
}

type iamAccessKeyParameters struct {
	Status       string   `json:"status"`
	UserSelector selector `json:"userSelector"`
}

type iamPolicyDocument struct {
	Version   string               `json:"Version"`
	Statement []iamPolicyStatement `json:"Statement"`
}

type iamPolicyStatement struct {
	Sid       string                       `json:"Sid"`
	Effect    string                       `json:"Effect"`
	Action    []string                     `json:"Action"`
	Resource  string                       `json:"Resource"`
	Condition map[string]map[string]string `json:"Condition"`
}

func (in *PiraeusEbsCredentials) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := *in
	out.ObjectMeta = *in.ObjectMeta.DeepCopy()
	out.Spec.Tags = cloneMap(in.Spec.Tags)
	if in.Status.CredentialSecretRef != nil {
		ref := *in.Status.CredentialSecretRef
		out.Status.CredentialSecretRef = &ref
	}
	return &out
}

func cloneMap[M ~map[string]string](in M) M {
	if in == nil {
		return nil
	}
	out := make(M, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
