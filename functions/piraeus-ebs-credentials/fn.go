package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/resource/composed"
	"github.com/crossplane/function-sdk-go/response"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

const (
	defaultTTL    = 30 * time.Second
	identityLabel = "nebula.io/piraeus-ebs-credential"
)

var ebsActions = []string{
	"ec2:AttachVolume",
	"ec2:CreateSnapshot",
	"ec2:CreateTags",
	"ec2:CreateVolume",
	"ec2:DeleteSnapshot",
	"ec2:DeleteTags",
	"ec2:DeleteVolume",
	"ec2:DescribeAvailabilityZones",
	"ec2:DescribeInstances",
	"ec2:DescribeSnapshots",
	"ec2:DescribeVolumes",
	"ec2:DescribeVolumesModifications",
	"ec2:DetachVolume",
	"ec2:ModifyVolume",
}

// Function creates only the static AWS credential that LINSTOR's native EBS
// remote requires. It deliberately does not manage EBS volumes, attachments,
// LINSTOR remotes, special satellites, or storage pools.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer
	log logging.Logger
}

func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, defaultTTL)

	ox, err := request.GetObservedCompositeResource(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read observed composite resource"))
		return rsp, nil
	}

	xr := &PiraeusEbsCredentials{}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(ox.Resource.Object, xr); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot decode XPiraeusEbsCredentials"))
		return rsp, nil
	}
	if err := validateSpec(xr.Spec); err != nil {
		response.Fatal(rsp, err)
		return rsp, nil
	}

	observed, err := request.GetObservedComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read observed composed resources"))
		return rsp, nil
	}

	policyDocument, err := newPolicyDocument(xr.Spec.Region)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot encode LINSTOR EBS IAM policy"))
		return rsp, nil
	}

	desired := map[resource.Name]*resource.DesiredComposed{}
	resources := map[resource.Name]any{
		"iam-user":              newIAMUser(xr),
		"iam-policy":            newIAMPolicy(xr, policyDocument),
		"iam-policy-attachment": newIAMUserPolicyAttachment(xr),
		"access-key":            newIAMAccessKey(xr),
	}
	for name, object := range resources {
		ready := observedConditionTrue(observed[name], "Ready")
		desired[name], err = desiredComposed(object, readyState(ready))
		if err != nil {
			response.Fatal(rsp, errors.Wrapf(err, "cannot compose %s", name))
			return rsp, nil
		}
	}
	if err := response.SetDesiredComposedResources(rsp, desired); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set desired credential resources"))
		return rsp, nil
	}

	status := PiraeusEbsCredentialsStatus{
		CredentialSecretRef: &SecretReference{
			Name:      xr.Spec.CredentialSecretName,
			Namespace: xr.Spec.CredentialSecretNamespace,
		},
	}
	if err := setCompositeStatus(rsp, ox, status); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set composite status"))
		return rsp, nil
	}

	allReady := true
	for name := range resources {
		if !observedConditionTrue(observed[name], "Ready") {
			allReady = false
			break
		}
	}
	if allReady {
		response.ConditionTrue(rsp, "CredentialsReady", "AccessKeyPublished").
			WithMessage(fmt.Sprintf("AWS credentials are published to Secret %s/%s.", xr.Spec.CredentialSecretNamespace, xr.Spec.CredentialSecretName)).
			TargetCompositeAndClaim()
	} else {
		response.ConditionFalse(rsp, "CredentialsReady", "ReconcilingIAM").
			WithMessage("Waiting for the IAM user, policy, attachment, and access key.").
			TargetCompositeAndClaim()
	}

	return rsp, nil
}

func validateSpec(spec PiraeusEbsCredentialsSpec) error {
	if strings.TrimSpace(spec.Region) == "" {
		return errors.New("spec.region must not be empty")
	}
	if strings.TrimSpace(spec.IAMUserName) == "" {
		return errors.New("spec.iamUserName must not be empty")
	}
	if strings.TrimSpace(spec.AWSProviderConfigRef) == "" {
		return errors.New("spec.awsProviderConfigRef must not be empty")
	}
	if strings.TrimSpace(spec.CredentialSecretName) == "" {
		return errors.New("spec.credentialSecretName must not be empty")
	}
	if strings.TrimSpace(spec.CredentialSecretNamespace) == "" {
		return errors.New("spec.credentialSecretNamespace must not be empty")
	}
	return nil
}

func newPolicyDocument(region string) (string, error) {
	document := iamPolicyDocument{
		Version: "2012-10-17",
		Statement: []iamPolicyStatement{{
			Sid:      "LinstorEbs",
			Effect:   "Allow",
			Action:   ebsActions,
			Resource: "*",
			Condition: map[string]map[string]string{
				"StringEquals": {"aws:RequestedRegion": region},
			},
		}},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func newIAMUser(xr *PiraeusEbsCredentials) *iamUser {
	labels := identityLabels(xr)
	return &iamUser{
		TypeMeta: metav1.TypeMeta{APIVersion: "iam.aws.upbound.io/v1beta1", Kind: "User"},
		ObjectMeta: metav1.ObjectMeta{
			Annotations: map[string]string{"crossplane.io/external-name": xr.Spec.IAMUserName},
			Labels:      labels,
		},
		Spec: iamUserSpec{
			managedResourceSpec: providerSpec(xr),
			ForProvider: iamUserParameters{
				ForceDestroy: true,
				Path:         "/piraeus/",
				Tags:         resourceTags(xr),
			},
		},
	}
}

func newIAMPolicy(xr *PiraeusEbsCredentials, policyDocument string) *iamPolicy {
	policyName := xr.Spec.IAMUserName + "-policy"
	return &iamPolicy{
		TypeMeta: metav1.TypeMeta{APIVersion: "iam.aws.upbound.io/v1beta1", Kind: "Policy"},
		ObjectMeta: metav1.ObjectMeta{
			Annotations: map[string]string{"crossplane.io/external-name": policyName},
			Labels:      identityLabels(xr),
		},
		Spec: iamPolicySpec{
			managedResourceSpec: providerSpec(xr),
			ForProvider: iamPolicyParameters{
				Description: "LINSTOR native EBS target and initiator operations",
				Path:        "/piraeus/",
				Policy:      policyDocument,
				Tags:        resourceTags(xr),
			},
		},
	}
}

func newIAMUserPolicyAttachment(xr *PiraeusEbsCredentials) *iamUserPolicyAttachment {
	matchControllerRef := true
	labels := identityLabels(xr)
	return &iamUserPolicyAttachment{
		TypeMeta: metav1.TypeMeta{APIVersion: "iam.aws.upbound.io/v1beta1", Kind: "UserPolicyAttachment"},
		Spec: iamUserPolicyAttachmentSpec{
			managedResourceSpec: providerSpec(xr),
			ForProvider: iamUserPolicyAttachmentParameters{
				PolicyARNSelector: selector{MatchControllerRef: &matchControllerRef, MatchLabels: labels},
				UserSelector:      selector{MatchControllerRef: &matchControllerRef, MatchLabels: labels},
			},
		},
	}
}

func newIAMAccessKey(xr *PiraeusEbsCredentials) *iamAccessKey {
	matchControllerRef := true
	return &iamAccessKey{
		TypeMeta: metav1.TypeMeta{APIVersion: "iam.aws.upbound.io/v1beta1", Kind: "AccessKey"},
		Spec: iamAccessKeySpec{
			managedResourceSpec: providerSpec(xr),
			ForProvider: iamAccessKeyParameters{
				Status: "Active",
				UserSelector: selector{
					MatchControllerRef: &matchControllerRef,
					MatchLabels:        identityLabels(xr),
				},
			},
			WriteConnectionSecretToRef: writeConnectionSecretReference{
				Name:      xr.Spec.CredentialSecretName,
				Namespace: xr.Spec.CredentialSecretNamespace,
			},
		},
	}
}

func providerSpec(xr *PiraeusEbsCredentials) managedResourceSpec {
	return managedResourceSpec{
		DeletionPolicy:    "Delete",
		ProviderConfigRef: resourceReference{Name: xr.Spec.AWSProviderConfigRef},
	}
}

func identityLabels(xr *PiraeusEbsCredentials) map[string]string {
	return map[string]string{identityLabel: xr.Name}
}

func resourceTags(xr *PiraeusEbsCredentials) map[string]string {
	tags := cloneMap(xr.Spec.Tags)
	if tags == nil {
		tags = map[string]string{}
	}
	tags["ManagedBy"] = "crossplane"
	tags["Purpose"] = "piraeus-linstor-ebs"
	return tags
}

func desiredComposed(object any, ready resource.Ready) (*resource.DesiredComposed, error) {
	content, err := runtime.DefaultUnstructuredConverter.ToUnstructured(object)
	if err != nil {
		return nil, err
	}
	u := composed.New()
	u.SetUnstructuredContent(content)
	return &resource.DesiredComposed{Resource: u, Ready: ready}, nil
}

func observedConditionTrue(observed resource.ObservedComposed, conditionType string) bool {
	if observed.Resource == nil {
		return false
	}
	conditions, found, _ := unstructured.NestedSlice(observed.Resource.Object, "status", "conditions")
	if !found {
		return false
	}
	for _, raw := range conditions {
		condition, ok := raw.(map[string]any)
		if ok && condition["type"] == conditionType && condition["status"] == string(metav1.ConditionTrue) {
			return true
		}
	}
	return false
}

func readyState(ready bool) resource.Ready {
	if ready {
		return resource.ReadyTrue
	}
	return resource.ReadyFalse
}

func setCompositeStatus(rsp *fnv1.RunFunctionResponse, observed *resource.Composite, status PiraeusEbsCredentialsStatus) error {
	desired := &resource.Composite{
		Resource:          observed.Resource.DeepCopy(),
		ConnectionDetails: observed.ConnectionDetails,
	}
	content, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&status)
	if err != nil {
		return err
	}
	desired.Resource.Object["status"] = content
	return response.SetDesiredCompositeResource(rsp, desired)
}
