package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

func TestRunFunctionComposesOnlyCredentials(t *testing.T) {
	rsp, err := (&Function{log: logging.NewNopLogger()}).RunFunction(context.Background(), requestForTest(nil))
	if err != nil {
		t.Fatalf("RunFunction returned an error: %v", err)
	}

	desired := rsp.GetDesired().GetResources()
	if len(desired) != 4 {
		t.Fatalf("wanted 4 IAM resources, got %d", len(desired))
	}
	for _, name := range []string{"iam-user", "iam-policy", "iam-policy-attachment", "access-key"} {
		if desired[name] == nil {
			t.Fatalf("missing desired resource %q", name)
		}
	}
	for name, resource := range desired {
		kind := resource.GetResource().AsMap()["kind"]
		if kind == "EBSVolume" || kind == "VolumeAttachment" || kind == "LinstorSatelliteConfiguration" || kind == "Request" {
			t.Fatalf("credential function must not compose storage resource %q (%v)", name, kind)
		}
	}

	accessKey := desired["access-key"].GetResource().AsMap()
	assertNested(t, accessKey, "linstor-ebs-aws-credentials", "spec", "writeConnectionSecretToRef", "name")
	assertNested(t, accessKey, "crossplane-system", "spec", "writeConnectionSecretToRef", "namespace")

	policy := desired["iam-policy"].GetResource().AsMap()
	policyJSON := policy["spec"].(map[string]any)["forProvider"].(map[string]any)["policy"].(string)
	document := iamPolicyDocument{}
	if err := json.Unmarshal([]byte(policyJSON), &document); err != nil {
		t.Fatalf("policy is not valid JSON: %v", err)
	}
	if got := document.Statement[0].Condition["StringEquals"]["aws:RequestedRegion"]; got != "eu-central-1" {
		t.Fatalf("wanted regional IAM restriction, got %q", got)
	}

	if rsp.GetRequirements() != nil && (len(rsp.GetRequirements().GetResources()) > 0 || len(rsp.GetRequirements().GetExtraResources()) > 0) {
		t.Fatalf("credential function must not request Nodes or other resources: %#v", rsp.GetRequirements())
	}
	if len(rsp.GetConditions()) != 1 || rsp.GetConditions()[0].GetStatus() != fnv1.Status_STATUS_CONDITION_FALSE {
		t.Fatalf("wanted a false CredentialsReady condition while IAM reconciles, got %#v", rsp.GetConditions())
	}
}

func TestRunFunctionReportsReady(t *testing.T) {
	observed := map[string]*fnv1.Resource{}
	for _, name := range []string{"iam-user", "iam-policy", "iam-policy-attachment", "access-key"} {
		observed[name] = &fnv1.Resource{Resource: resource.MustStructJSON(`{
          "apiVersion": "iam.aws.upbound.io/v1beta1",
          "kind": "ManagedResource",
          "status": {"conditions": [{"type": "Ready", "status": "True"}]}
        }`)}
	}
	rsp, err := (&Function{log: logging.NewNopLogger()}).RunFunction(context.Background(), requestForTest(observed))
	if err != nil {
		t.Fatalf("RunFunction returned an error: %v", err)
	}
	if len(rsp.GetConditions()) != 1 || rsp.GetConditions()[0].GetStatus() != fnv1.Status_STATUS_CONDITION_TRUE {
		t.Fatalf("wanted a true CredentialsReady condition, got %#v", rsp.GetConditions())
	}
}

func requestForTest(observed map[string]*fnv1.Resource) *fnv1.RunFunctionRequest {
	xr := resource.MustStructJSON(`{
      "apiVersion": "nebula.io/v1alpha1",
      "kind": "XPiraeusEbsCredentials",
      "metadata": {"name": "stage-piraeus-ebs-credentials"},
      "spec": {
        "region": "eu-central-1",
        "iamUserName": "stage-linstor-ebs",
        "awsProviderConfigRef": "default",
        "credentialSecretName": "linstor-ebs-aws-credentials",
        "credentialSecretNamespace": "crossplane-system",
        "tags": {"nuconstruct.io/cluster": "stage"}
      }
    }`)
	return &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "test"},
		Observed: &fnv1.State{
			Composite: &fnv1.Resource{Resource: xr},
			Resources: observed,
		},
		Desired: &fnv1.State{Composite: &fnv1.Resource{Resource: xr}},
	}
}

func assertNested(t *testing.T, object map[string]any, want any, fields ...string) {
	t.Helper()
	current := any(object)
	for _, field := range fields {
		m, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("%v is not an object while reading %v", current, fields)
		}
		current = m[field]
	}
	if current != want {
		t.Fatalf("wanted %v at %v, got %v", want, fields, current)
	}
}
