package controller

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"

	corev1 "k8s.io/api/core/v1"
)

const initDataAnnotation = "io.katacontainers.config.hypervisor.cc_init_data"
const measurementAnnotation = "confidential.nebula.dev/init-data-sha256"

// Derive status from the Pod that Kubernetes actually stores, including Pods
// created before the controller started stamping a measurement annotation.
// This mirrors the owner's bounded, single-member init-data decoding.
func podInitDataSHA256(pod *corev1.Pod) (string, error) {
	encoded := pod.Annotations[initDataAnnotation]
	if encoded == "" || len(encoded) > 2*1024*1024 {
		return "", errors.New("Pod init-data is absent or too large")
	}
	compressed, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(compressed) != encoded {
		return "", errors.New("Pod init-data is not canonical base64")
	}
	source := bytes.NewReader(compressed)
	reader, err := gzip.NewReader(source)
	if err != nil {
		return "", errors.New("Pod init-data is not gzip")
	}
	reader.Multistream(false)
	document, err := io.ReadAll(io.LimitReader(reader, 1024*1024+1))
	if err != nil || len(document) > 1024*1024 || source.Len() != 0 {
		return "", errors.New("Pod init-data is not one bounded gzip member")
	}
	if err := reader.Close(); err != nil {
		return "", errors.New("Pod init-data gzip close failed")
	}
	hash := sha256.Sum256(document)
	return hex.EncodeToString(hash[:]), nil
}
