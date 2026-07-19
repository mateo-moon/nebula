package main

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// PiraeusNodeStorage is the typed view of the XPiraeusNodeStorage composite.
type PiraeusNodeStorage struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PiraeusNodeStorageSpec   `json:"spec"`
	Status PiraeusNodeStorageStatus `json:"status,omitempty"`
}

type PiraeusNodeStorageSpec struct {
	Region               string            `json:"region"`
	AvailabilityZones    []string          `json:"availabilityZones"`
	AWSProviderConfigRef string            `json:"awsProviderConfigRef"`
	NodeSelector         map[string]string `json:"nodeSelector,omitempty"`
	StoragePoolName      string            `json:"storagePoolName"`
	Volume               EBSVolumeConfig   `json:"volume"`
}

type EBSVolumeConfig struct {
	SizeGiB       int64             `json:"sizeGiB"`
	Type          string            `json:"type"`
	Encrypted     bool              `json:"encrypted"`
	FinalSnapshot bool              `json:"finalSnapshot"`
	IOPS          *int64            `json:"iops,omitempty"`
	Throughput    *int64            `json:"throughput,omitempty"`
	DeviceName    string            `json:"deviceName"`
	Tags          map[string]string `json:"tags,omitempty"`
}

type PiraeusNodeStorageStatus struct {
	Zones             int32 `json:"zones,omitempty"`
	AssignedNodes     int32 `json:"assignedNodes,omitempty"`
	ReadyVolumes      int32 `json:"readyVolumes,omitempty"`
	ReadyAttachments  int32 `json:"readyAttachments,omitempty"`
	ReadyStoragePools int32 `json:"readyStoragePools,omitempty"`
}

// The function owns a deliberately small, typed subset of the installed
// provider-aws EC2 CRDs. Keeping the contract narrow avoids linking all of the
// provider's generated Terraform implementation into the runtime image.
type resourceReference struct {
	Name string `json:"name"`
}

type managedResourceSpec struct {
	DeletionPolicy    string            `json:"deletionPolicy"`
	ProviderConfigRef resourceReference `json:"providerConfigRef"`
}

type ebsVolume struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              ebsVolumeSpec   `json:"spec"`
	Status            ebsVolumeStatus `json:"status,omitempty"`
}

type ebsVolumeSpec struct {
	managedResourceSpec `json:",inline"`
	ForProvider         ebsVolumeParameters `json:"forProvider"`
}

type ebsVolumeParameters struct {
	AvailabilityZone string             `json:"availabilityZone"`
	Encrypted        bool               `json:"encrypted"`
	FinalSnapshot    bool               `json:"finalSnapshot"`
	IOPS             *float64           `json:"iops,omitempty"`
	Region           string             `json:"region"`
	Size             float64            `json:"size"`
	Tags             map[string]*string `json:"tags,omitempty"`
	Throughput       *float64           `json:"throughput,omitempty"`
	Type             string             `json:"type"`
}

type ebsVolumeStatus struct {
	AtProvider ebsVolumeObservation `json:"atProvider,omitempty"`
}

type ebsVolumeObservation struct {
	ID string `json:"id,omitempty"`
}

type volumeAttachment struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              volumeAttachmentSpec   `json:"spec"`
	Status            volumeAttachmentStatus `json:"status,omitempty"`
}

type volumeAttachmentSpec struct {
	managedResourceSpec `json:",inline"`
	ForProvider         volumeAttachmentParameters `json:"forProvider"`
}

type volumeAttachmentParameters struct {
	DeviceName  string            `json:"deviceName"`
	InstanceID  string            `json:"instanceId"`
	Region      string            `json:"region"`
	VolumeIDRef resourceReference `json:"volumeIdRef"`
}

type volumeAttachmentStatus struct {
	AtProvider volumeAttachmentObservation `json:"atProvider,omitempty"`
}

type volumeAttachmentObservation struct {
	InstanceID string `json:"instanceId,omitempty"`
}

func (in *PiraeusNodeStorage) DeepCopyObject() runtime.Object {
	if in == nil {
		return nil
	}
	out := *in
	out.ObjectMeta = *in.ObjectMeta.DeepCopy()
	out.Spec.AvailabilityZones = append([]string(nil), in.Spec.AvailabilityZones...)
	out.Spec.NodeSelector = cloneMap(in.Spec.NodeSelector)
	out.Spec.Volume.Tags = cloneMap(in.Spec.Volume.Tags)
	if in.Spec.Volume.IOPS != nil {
		v := *in.Spec.Volume.IOPS
		out.Spec.Volume.IOPS = &v
	}
	if in.Spec.Volume.Throughput != nil {
		v := *in.Spec.Volume.Throughput
		out.Spec.Volume.Throughput = &v
	}
	return &out
}

type linstorSatelliteConfiguration struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              linstorSatelliteConfigurationSpec `json:"spec"`
}

type linstorSatelliteConfigurationSpec struct {
	NodeSelector   map[string]string    `json:"nodeSelector"`
	StoragePools   []linstorStoragePool `json:"storagePools"`
	DeletionPolicy string               `json:"deletionPolicy"`
}

type linstorStoragePool struct {
	Name        string                     `json:"name"`
	LVMThinPool *linstorStoragePoolLVMThin `json:"lvmThinPool"`
	Source      *linstorStoragePoolSource  `json:"source"`
}

type linstorStoragePoolLVMThin struct {
	VolumeGroup string `json:"volumeGroup,omitempty"`
	ThinPool    string `json:"thinPool,omitempty"`
}

type linstorStoragePoolSource struct {
	HostDevices []string `json:"hostDevices"`
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
