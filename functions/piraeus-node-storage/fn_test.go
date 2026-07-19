package main

import (
	"context"
	"testing"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

func TestRunFunctionRequestsNodes(t *testing.T) {
	req := requestForTest(nil, nil)
	rsp, err := (&Function{log: logging.NewNopLogger()}).RunFunction(context.Background(), req)
	if err != nil {
		t.Fatalf("RunFunction returned an error: %v", err)
	}
	if rsp.GetRequirements().GetResources()[requiredNodesKey] == nil {
		t.Fatal("RunFunction did not request storage Nodes")
	}
	if rsp.GetRequirements().GetExtraResources()[requiredNodesKey] == nil {
		t.Fatal("RunFunction did not request legacy ExtraResources for Crossplane 2.1")
	}
}

func TestRunFunctionComposesReadyPool(t *testing.T) {
	node := resource.MustStructJSON(`{
      "apiVersion": "v1",
      "kind": "Node",
      "metadata": {
        "name": "stage-control-plane-a",
        "creationTimestamp": "2026-07-01T00:00:00Z",
        "labels": {
          "kubernetes.io/os": "linux",
          "kubernetes.io/hostname": "stage-control-plane-a",
          "node-role.kubernetes.io/control-plane": "true",
          "topology.kubernetes.io/zone": "eu-central-1a"
        }
      },
      "spec": {"providerID": "aws:///eu-central-1a/i-0123456789abcdef0"}
    }`)
	observed := map[string]*fnv1.Resource{
		"volume-eu-central-1a": {Resource: resource.MustStructJSON(`{
          "apiVersion": "ec2.aws.upbound.io/v1beta1",
          "kind": "EBSVolume",
          "status": {
            "atProvider": {"id": "vol-0123456789abcdef0"},
            "conditions": [{"type": "Ready", "status": "True"}]
          }
        }`)},
		"attachment-eu-central-1a": {Resource: resource.MustStructJSON(`{
          "apiVersion": "ec2.aws.upbound.io/v1beta1",
          "kind": "VolumeAttachment",
          "status": {
            "atProvider": {"instanceId": "i-0123456789abcdef0"},
            "conditions": [{"type": "Ready", "status": "True"}]
          }
        }`)},
		"pool-eu-central-1a": {Resource: resource.MustStructJSON(`{
          "apiVersion": "piraeus.io/v1",
          "kind": "LinstorSatelliteConfiguration",
          "spec": {"nodeSelector": {"kubernetes.io/hostname": "stage-control-plane-a"}},
          "status": {
            "matched": 1,
            "conditions": [{"type": "Applied", "status": "True"}]
          }
        }`)},
	}
	required := map[string]*fnv1.Resources{
		requiredNodesKey: {Items: []*fnv1.Resource{{Resource: node}}},
	}
	req := requestForTest(observed, required)
	rsp, err := (&Function{log: logging.NewNopLogger()}).RunFunction(context.Background(), req)
	if err != nil {
		t.Fatalf("RunFunction returned an error: %v", err)
	}
	if len(rsp.GetDesired().GetResources()) != 3 {
		t.Fatalf("wanted 3 composed resources, got %d", len(rsp.GetDesired().GetResources()))
	}

	volume := rsp.GetDesired().GetResources()["volume-eu-central-1a"].GetResource().AsMap()
	assertNested(t, volume, "gp3", "spec", "forProvider", "type")
	assertNested(t, volume, true, "spec", "forProvider", "encrypted")

	attachment := rsp.GetDesired().GetResources()["attachment-eu-central-1a"].GetResource().AsMap()
	assertNested(t, attachment, "i-0123456789abcdef0", "spec", "forProvider", "instanceId")

	pool := rsp.GetDesired().GetResources()["pool-eu-central-1a"].GetResource().AsMap()
	path := pool["spec"].(map[string]any)["storagePools"].([]any)[0].(map[string]any)["source"].(map[string]any)["hostDevices"].([]any)[0]
	wantPath := "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0"
	if path != wantPath {
		t.Fatalf("wanted pool path %q, got %q", wantPath, path)
	}

	if len(rsp.GetConditions()) != 1 || rsp.GetConditions()[0].GetStatus() != fnv1.Status_STATUS_CONDITION_TRUE {
		t.Fatalf("wanted a true StorageReady condition, got %#v", rsp.GetConditions())
	}
}

func requestForTest(observed map[string]*fnv1.Resource, required map[string]*fnv1.Resources) *fnv1.RunFunctionRequest {
	xr := resource.MustStructJSON(`{
      "apiVersion": "nebula.io/v1alpha1",
      "kind": "XPiraeusNodeStorage",
      "metadata": {"name": "stage-piraeus"},
      "spec": {
        "region": "eu-central-1",
        "availabilityZones": ["eu-central-1a"],
        "awsProviderConfigRef": "default",
        "nodeSelector": {"node-role.kubernetes.io/control-plane": "true"},
        "storagePoolName": "PiraeusPool",
        "volume": {
          "sizeGiB": 200,
          "type": "gp3",
          "encrypted": true,
          "finalSnapshot": true,
          "deviceName": "/dev/sdf"
        }
      }
    }`)
	return &fnv1.RunFunctionRequest{
		Meta: &fnv1.RequestMeta{Tag: "test"},
		Observed: &fnv1.State{
			Composite: &fnv1.Resource{Resource: xr},
			Resources: observed,
		},
		Desired:           &fnv1.State{Composite: &fnv1.Resource{Resource: xr}},
		RequiredResources: required,
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
