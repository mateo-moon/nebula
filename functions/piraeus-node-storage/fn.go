package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/resource/composed"
	"github.com/crossplane/function-sdk-go/response"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

const (
	requiredNodesKey = "storage-nodes"
	defaultTTL       = 30 * time.Second
)

var (
	invalidDNSCharacter = regexp.MustCompile(`[^a-z0-9-]+`)
	validVolumeID       = regexp.MustCompile(`^vol-[0-9a-f]+$`)
)

// Function composes durable AWS EBS pool slots and attaches each slot to one
// selected Linux node in its availability zone.
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

	xr := &PiraeusNodeStorage{}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(ox.Resource.Object, xr); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot decode XPiraeusNodeStorage"))
		return rsp, nil
	}
	if err := validateSpec(xr.Spec); err != nil {
		response.Fatal(rsp, err)
		return rsp, nil
	}

	setNodeRequirement(rsp, xr.Spec.NodeSelector)
	required, resolved, err := getRequiredNodes(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read required Nodes"))
		return rsp, nil
	}
	if !resolved {
		f.log.Info("Waiting for Crossplane to resolve storage Nodes", "xr", xr.Name)
		return rsp, nil
	}

	nodes, err := decodeNodes(required, xr.Spec)
	if err != nil {
		response.Fatal(rsp, err)
		return rsp, nil
	}
	observed, err := request.GetObservedComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot read observed composed resources"))
		return rsp, nil
	}

	// This is the only function in the pipeline. Build the desired set from
	// scratch so resources for zones removed from the XCR are pruned.
	if rsp.Desired == nil {
		rsp.Desired = &fnv1.State{}
	}
	rsp.Desired.Resources = map[string]*fnv1.Resource{}
	desired := map[resource.Name]*resource.DesiredComposed{}
	status := PiraeusNodeStorageStatus{Zones: int32(len(xr.Spec.AvailabilityZones))}

	for _, zone := range xr.Spec.AvailabilityZones {
		volumeKey := resource.Name("volume-" + zone)
		attachmentKey := resource.Name("attachment-" + zone)
		poolKey := resource.Name("pool-" + zone)
		volumeName := dnsName(xr.Name, "pool", zone)
		attachmentName := dnsName(xr.Name, "attach", zone)
		poolConfigName := dnsName(xr.Name, "pool-config", zone)

		volumeReady := observedConditionTrue(observed[volumeKey], "Ready")
		if volumeReady {
			status.ReadyVolumes++
		}
		volume := newEBSVolume(xr, zone, volumeName)
		desired[volumeKey], err = desiredComposed(volume, readyState(volumeReady))
		if err != nil {
			response.Fatal(rsp, errors.Wrapf(err, "cannot compose EBS volume for %s", zone))
			return rsp, nil
		}

		attachedInstance := observedAttachmentInstance(observed[attachmentKey])
		node := chooseNode(nodes[zone], attachedInstance)
		if node == nil {
			continue
		}
		status.AssignedNodes++

		instanceID, _, err := awsNodeIdentity(node)
		if err != nil {
			response.Fatal(rsp, err)
			return rsp, nil
		}
		attachmentReady := observedConditionTrue(observed[attachmentKey], "Ready") && attachedInstance == instanceID
		if attachmentReady {
			status.ReadyAttachments++
		}
		attachment := newVolumeAttachment(xr, instanceID, volumeName, attachmentName)
		desired[attachmentKey], err = desiredComposed(attachment, readyState(attachmentReady))
		if err != nil {
			response.Fatal(rsp, errors.Wrapf(err, "cannot compose EBS attachment for %s", zone))
			return rsp, nil
		}

		volumeID := observedVolumeID(observed[volumeKey])
		if !validVolumeID.MatchString(volumeID) {
			continue
		}
		poolReady := observedPoolReady(observed[poolKey], node.Name)
		if poolReady {
			status.ReadyStoragePools++
		}
		pool := newStoragePool(xr, node.Name, poolConfigName, volumeID)
		desired[poolKey], err = desiredComposed(pool, readyState(poolReady))
		if err != nil {
			response.Fatal(rsp, errors.Wrapf(err, "cannot compose Piraeus pool for %s", zone))
			return rsp, nil
		}
	}

	if err := response.SetDesiredComposedResources(rsp, desired); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set desired composed resources"))
		return rsp, nil
	}
	if err := setCompositeStatus(rsp, ox, status); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set composite status"))
		return rsp, nil
	}

	ready := int(status.Zones) > 0 &&
		status.AssignedNodes == status.Zones &&
		status.ReadyVolumes == status.Zones &&
		status.ReadyAttachments == status.Zones &&
		status.ReadyStoragePools == status.Zones
	if ready {
		response.ConditionTrue(rsp, "StorageReady", "AllPoolsReady").
			WithMessage("Every configured availability zone has an attached, applied Piraeus storage pool.").
			TargetCompositeAndClaim()
	} else {
		response.ConditionFalse(rsp, "StorageReady", "ReconcilingPools").
			WithMessage(fmt.Sprintf("assigned=%d/%d volumes=%d/%d attachments=%d/%d pools=%d/%d",
				status.AssignedNodes, status.Zones,
				status.ReadyVolumes, status.Zones,
				status.ReadyAttachments, status.Zones,
				status.ReadyStoragePools, status.Zones)).
			TargetCompositeAndClaim()
	}

	return rsp, nil
}

func validateSpec(spec PiraeusNodeStorageSpec) error {
	if spec.Region == "" {
		return errors.New("spec.region must not be empty")
	}
	if len(spec.AvailabilityZones) == 0 {
		return errors.New("spec.availabilityZones must not be empty")
	}
	seen := map[string]bool{}
	for _, zone := range spec.AvailabilityZones {
		if !strings.HasPrefix(zone, spec.Region) {
			return errors.Errorf("availability zone %q is not in region %q", zone, spec.Region)
		}
		if seen[zone] {
			return errors.Errorf("availability zone %q is duplicated", zone)
		}
		seen[zone] = true
	}
	if spec.AWSProviderConfigRef == "" {
		return errors.New("spec.awsProviderConfigRef must not be empty")
	}
	if spec.StoragePoolName == "" {
		return errors.New("spec.storagePoolName must not be empty")
	}
	if spec.Volume.SizeGiB < 1 {
		return errors.New("spec.volume.sizeGiB must be at least 1")
	}
	if spec.Volume.Type == "" {
		return errors.New("spec.volume.type must not be empty")
	}
	if !strings.HasPrefix(spec.Volume.DeviceName, "/dev/") {
		return errors.New("spec.volume.deviceName must be an absolute /dev path")
	}
	if os, ok := spec.NodeSelector[corev1.LabelOSStable]; ok && os != string(corev1.Linux) {
		return errors.Errorf("spec.nodeSelector %s must select linux Nodes", corev1.LabelOSStable)
	}
	return nil
}

func setNodeRequirement(rsp *fnv1.RunFunctionResponse, selector map[string]string) {
	labels := cloneMap(selector)
	if labels == nil {
		labels = map[string]string{}
	}
	labels[corev1.LabelOSStable] = string(corev1.Linux)
	match := &fnv1.ResourceSelector{
		ApiVersion: "v1",
		Kind:       "Node",
		Match: &fnv1.ResourceSelector_MatchLabels{
			MatchLabels: &fnv1.MatchLabels{Labels: labels},
		},
	}
	if rsp.Requirements == nil {
		rsp.Requirements = &fnv1.Requirements{}
	}
	// Crossplane 2.1 resolves extra_resources. Newer releases resolve resources.
	// Request both during the transition and accept either request field.
	rsp.Requirements.ExtraResources = map[string]*fnv1.ResourceSelector{requiredNodesKey: match}
	rsp.Requirements.Resources = map[string]*fnv1.ResourceSelector{requiredNodesKey: match}
}

func getRequiredNodes(req *fnv1.RunFunctionRequest) ([]resource.Required, bool, error) {
	current, currentOK, err := request.GetRequiredResource(req, requiredNodesKey)
	if err != nil {
		return nil, false, err
	}
	legacy, err := request.GetExtraResources(req)
	if err != nil {
		return nil, false, err
	}
	old, legacyOK := legacy[requiredNodesKey]
	if currentOK && len(current) > 0 {
		return current, true, nil
	}
	if legacyOK {
		return old, true, nil
	}
	return current, currentOK, nil
}

func decodeNodes(required []resource.Required, spec PiraeusNodeStorageSpec) (map[string][]corev1.Node, error) {
	zones := make(map[string][]corev1.Node, len(spec.AvailabilityZones))
	allowed := map[string]bool{}
	for _, zone := range spec.AvailabilityZones {
		allowed[zone] = true
	}
	for _, r := range required {
		node := corev1.Node{}
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(r.Resource.Object, &node); err != nil {
			return nil, errors.Wrap(err, "cannot decode required Node")
		}
		if !labelsMatch(node.Labels, spec.NodeSelector) {
			continue
		}
		_, zone, err := awsNodeIdentity(&node)
		if err != nil {
			return nil, err
		}
		if labelZone := node.Labels[corev1.LabelTopologyZone]; labelZone != "" && labelZone != zone {
			return nil, errors.Errorf("Node %s providerID zone %s conflicts with topology label %s", node.Name, zone, labelZone)
		}
		if allowed[zone] {
			zones[zone] = append(zones[zone], node)
		}
	}
	for zone := range zones {
		slices.SortFunc(zones[zone], func(a, b corev1.Node) int {
			if c := a.CreationTimestamp.Time.Compare(b.CreationTimestamp.Time); c != 0 {
				return c
			}
			return strings.Compare(a.Name, b.Name)
		})
	}
	return zones, nil
}

func chooseNode(nodes []corev1.Node, attachedInstance string) *corev1.Node {
	for i := range nodes {
		instanceID, _, err := awsNodeIdentity(&nodes[i])
		if err == nil && instanceID == attachedInstance {
			return &nodes[i]
		}
	}
	if len(nodes) == 0 {
		return nil
	}
	return &nodes[0]
}

func awsNodeIdentity(node *corev1.Node) (instanceID, zone string, err error) {
	u, parseErr := url.Parse(node.Spec.ProviderID)
	if parseErr != nil || u.Scheme != "aws" {
		return "", "", errors.Errorf("Node %s has invalid AWS providerID %q", node.Name, node.Spec.ProviderID)
	}
	parts := []string{}
	if u.Host != "" {
		parts = append(parts, u.Host)
	}
	parts = append(parts, strings.Split(strings.Trim(u.Path, "/"), "/")...)
	if len(parts) < 2 || !strings.HasPrefix(parts[len(parts)-1], "i-") {
		return "", "", errors.Errorf("Node %s has invalid AWS providerID %q", node.Name, node.Spec.ProviderID)
	}
	return parts[len(parts)-1], parts[len(parts)-2], nil
}

func labelsMatch(labels, selector map[string]string) bool {
	for key, value := range selector {
		if labels[key] != value {
			return false
		}
	}
	return true
}

func newEBSVolume(xr *PiraeusNodeStorage, zone, name string) *ebsVolume {
	tags := map[string]*string{}
	for key, value := range xr.Spec.Volume.Tags {
		v := value
		tags[key] = &v
	}
	for key, value := range map[string]string{
		"Name":                         name,
		"app.kubernetes.io/managed-by": "crossplane",
		"nebula.io/storage-owner":      xr.Name,
		"nebula.io/storage-zone":       zone,
	} {
		v := value
		tags[key] = &v
	}

	parameters := ebsVolumeParameters{
		AvailabilityZone: zone,
		Encrypted:        xr.Spec.Volume.Encrypted,
		FinalSnapshot:    xr.Spec.Volume.FinalSnapshot,
		Region:           xr.Spec.Region,
		Size:             float64(xr.Spec.Volume.SizeGiB),
		Tags:             tags,
		Type:             xr.Spec.Volume.Type,
	}
	if xr.Spec.Volume.IOPS != nil {
		v := float64(*xr.Spec.Volume.IOPS)
		parameters.IOPS = &v
	}
	if xr.Spec.Volume.Throughput != nil {
		v := float64(*xr.Spec.Volume.Throughput)
		parameters.Throughput = &v
	}

	return &ebsVolume{
		TypeMeta: metav1.TypeMeta{APIVersion: "ec2.aws.upbound.io/v1beta1", Kind: "EBSVolume"},
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "crossplane",
				"nebula.io/storage-owner":      xr.Name,
				"nebula.io/storage-zone":       zone,
			},
		},
		Spec: ebsVolumeSpec{
			managedResourceSpec: managedResourceSpec{
				ProviderConfigRef: resourceReference{Name: xr.Spec.AWSProviderConfigRef},
				DeletionPolicy:    "Delete",
			},
			ForProvider: parameters,
		},
	}
}

func newVolumeAttachment(xr *PiraeusNodeStorage, instanceID, volumeName, name string) *volumeAttachment {
	return &volumeAttachment{
		TypeMeta:   metav1.TypeMeta{APIVersion: "ec2.aws.upbound.io/v1beta1", Kind: "VolumeAttachment"},
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: volumeAttachmentSpec{
			managedResourceSpec: managedResourceSpec{
				ProviderConfigRef: resourceReference{Name: xr.Spec.AWSProviderConfigRef},
				DeletionPolicy:    "Delete",
			},
			ForProvider: volumeAttachmentParameters{
				DeviceName:  xr.Spec.Volume.DeviceName,
				InstanceID:  instanceID,
				Region:      xr.Spec.Region,
				VolumeIDRef: resourceReference{Name: volumeName},
			},
		},
	}
}

func newStoragePool(xr *PiraeusNodeStorage, nodeName, name, volumeID string) *linstorSatelliteConfiguration {
	poolName := xr.Spec.StoragePoolName
	deviceID := strings.ReplaceAll(volumeID, "-", "")
	devicePath := "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_" + deviceID
	return &linstorSatelliteConfiguration{
		TypeMeta:   metav1.TypeMeta{APIVersion: "piraeus.io/v1", Kind: "LinstorSatelliteConfiguration"},
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: linstorSatelliteConfigurationSpec{
			NodeSelector:   map[string]string{corev1.LabelHostname: nodeName},
			DeletionPolicy: "Evacuate",
			StoragePools: []linstorStoragePool{{
				Name: poolName,
				LVMThinPool: &linstorStoragePoolLVMThin{
					VolumeGroup: "linstor_" + poolName,
					ThinPool:    poolName,
				},
				Source: &linstorStoragePoolSource{HostDevices: []string{devicePath}},
			}},
		},
	}
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

func observedVolumeID(observed resource.ObservedComposed) string {
	if observed.Resource == nil {
		return ""
	}
	volume := &ebsVolume{}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(observed.Resource.Object, volume); err != nil {
		return ""
	}
	return volume.Status.AtProvider.ID
}

func observedAttachmentInstance(observed resource.ObservedComposed) string {
	if observed.Resource == nil {
		return ""
	}
	attachment := &volumeAttachment{}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(observed.Resource.Object, attachment); err != nil {
		return ""
	}
	return attachment.Status.AtProvider.InstanceID
}

func observedPoolReady(observed resource.ObservedComposed, nodeName string) bool {
	if observed.Resource == nil || !observedConditionTrue(observed, "Applied") {
		return false
	}
	selected, found, _ := unstructured.NestedString(observed.Resource.Object, "spec", "nodeSelector", corev1.LabelHostname)
	if !found || selected != nodeName {
		return false
	}
	matched, found, _ := unstructured.NestedFieldNoCopy(observed.Resource.Object, "status", "matched")
	if !found {
		return false
	}
	switch value := matched.(type) {
	case int64:
		return value > 0
	case float64:
		return value > 0
	default:
		return false
	}
}

func readyState(ready bool) resource.Ready {
	if ready {
		return resource.ReadyTrue
	}
	return resource.ReadyFalse
}

func setCompositeStatus(rsp *fnv1.RunFunctionResponse, observed *resource.Composite, status PiraeusNodeStorageStatus) error {
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

func dnsName(parts ...string) string {
	name := strings.ToLower(strings.Join(parts, "-"))
	name = invalidDNSCharacter.ReplaceAllString(name, "-")
	name = strings.Trim(name, "-")
	if len(name) <= 63 {
		return name
	}
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte(name)))[:10]
	return strings.Trim(name[:52], "-") + "-" + sum
}
