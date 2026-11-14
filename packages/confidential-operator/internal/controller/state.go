package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"strings"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
)

const desiredAnnotation = "confidential.nebula.dev/desired-spec-sha256"
const resolvedAnnotation = "confidential.nebula.dev/resolved-images"

var digestRE = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

func declarationKey(w *api.ConfidentialWorkload, s []api.ConfidentialStorage) (string, error) {
	data, err := json.Marshal(struct {
		UID     types.UID
		Spec    json.RawMessage
		Storage []json.RawMessage
	}{w.UID, w.Spec.Raw, storageSpecs(s)})
	if err != nil {
		return "", errors.New("invalid declaration JSON")
	}
	var canonical any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if decoder.Decode(&canonical) != nil {
		return "", errors.New("invalid declaration JSON")
	}
	data, _ = json.Marshal(canonical)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// Resolutions are public operational checkpoints, not owner enrollment or key
// authority. Native measurement and the independently pinned owner remain the
// security boundary if a cluster administrator changes these objects.
func checkedResolutions(w *api.ConfidentialWorkload, pod *corev1.Pod, values map[string]string) bool {
	var spec struct {
		Containers []struct {
			Name, Image      string
			ImageKeyResource []string `json:"imageKeyResource"`
		}
	}
	if json.Unmarshal(w.Spec.Raw, &spec) != nil || len(values) > 32 {
		return false
	}
	expected := map[string]bool{}
	for _, c := range spec.Containers {
		if len(c.ImageKeyResource) == 0 || strings.Contains(c.Image, "@sha256:") {
			continue
		}
		digest, ok := values[c.Image]
		if !ok || !digestRE.MatchString(digest) {
			return false
		}
		image := c.Image[:strings.LastIndex(c.Image, ":")] + "@" + digest
		found := false
		for _, actual := range pod.Spec.Containers {
			if actual.Name == c.Name && actual.Image == image {
				found = true
			}
		}
		if !found {
			return false
		}
		expected[c.Image] = true
	}
	return len(expected) == len(values)
}
func actualStatus(pod *corev1.Pod) api.Status {
	hash, _ := podInitDataSHA256(pod)
	state := api.Status{PodName: pod.Name, PodUID: string(pod.UID), SpecSHA256: pod.Annotations[renderLabel], InitDataSHA256: hash,
		DesiredSpecSHA256: pod.Annotations[desiredAnnotation]}
	if raw := pod.Annotations[resolvedAnnotation]; raw != "" && len(raw) <= 16384 {
		_ = json.Unmarshal([]byte(raw), &state.ResolvedImageDigests)
	}
	return state
}
func updatePending(state api.Status, reason string) api.Status {
	state.Phase = "UpdatePending"
	state.Reason = reason
	state.Message = "Desired declaration changed. Explicitly retire the current Pod and enroll its replacement; the current instance is preserved."
	return state
}

// Compare all actual execution fields, allowing only fixed Kubernetes defaults
// and scheduler assignment. No image, command, environment, security context,
// volume, host namespace or RuntimeClass mutation is normalized away.
func podMatchesPlan(actual, expected *corev1.Pod) bool {
	for key, value := range expected.Annotations {
		if actual.Annotations[key] != value {
			return false
		}
	}
	for key, value := range actual.Annotations {
		if strings.HasPrefix(key, "io.katacontainers.") && expected.Annotations[key] != value {
			return false
		}
	}
	for key, value := range expected.Labels {
		if actual.Labels[key] != value {
			return false
		}
	}
	a, e := actual.Spec.DeepCopy(), expected.Spec.DeepCopy()
	if host := e.NodeSelector[corev1.LabelHostname]; host != "" && a.NodeName != "" && a.NodeName != host {
		return false
	}
	a.NodeName = ""
	e.NodeName = ""
	normalizePodDefaults(a)
	normalizePodDefaults(e)
	// RuntimeClass admission adds this official Kata scheduling requirement.
	if a.NodeSelector["kata-deploy.katacontainers.io/default"] == "true" && e.NodeSelector["kata-deploy.katacontainers.io/default"] == "" {
		delete(a.NodeSelector, "kata-deploy.katacontainers.io/default")
	}
	rawA, _ := json.Marshal(a)
	rawE, _ := json.Marshal(e)
	return bytes.Equal(rawA, rawE)
}
func normalizePodDefaults(p *corev1.PodSpec) {
	if p.SecurityContext == nil {
		p.SecurityContext = &corev1.PodSecurityContext{}
	}
	if p.EnableServiceLinks == nil {
		yes := true
		p.EnableServiceLinks = &yes
	}
	if p.DNSPolicy == "" {
		p.DNSPolicy = corev1.DNSClusterFirst
	}
	if p.SchedulerName == "" {
		p.SchedulerName = corev1.DefaultSchedulerName
	}
	if p.ServiceAccountName == "" {
		p.ServiceAccountName = "default"
	}
	p.DeprecatedServiceAccount = ""
	if p.Priority == nil {
		n := int32(0)
		p.Priority = &n
	}
	if p.PreemptionPolicy == nil {
		v := corev1.PreemptLowerPriority
		p.PreemptionPolicy = &v
	}
	if p.RestartPolicy == "" {
		p.RestartPolicy = corev1.RestartPolicyAlways
	}
	if p.TerminationGracePeriodSeconds == nil {
		n := int64(30)
		p.TerminationGracePeriodSeconds = &n
	}
	normalize := func(c *corev1.Container) {
		if c.ImagePullPolicy == "" {
			c.ImagePullPolicy = corev1.PullIfNotPresent
			if !strings.Contains(c.Image, "@") && (strings.LastIndex(c.Image, ":") <= strings.LastIndex(c.Image, "/") || strings.HasSuffix(c.Image, ":latest")) {
				c.ImagePullPolicy = corev1.PullAlways
			}
		}
		for _, probe := range []*corev1.Probe{c.ReadinessProbe, c.LivenessProbe, c.StartupProbe} {
			if probe == nil {
				continue
			}
			if probe.TimeoutSeconds == 0 {
				probe.TimeoutSeconds = 1
			}
			if probe.PeriodSeconds == 0 {
				probe.PeriodSeconds = 10
			}
			if probe.SuccessThreshold == 0 {
				probe.SuccessThreshold = 1
			}
			if probe.FailureThreshold == 0 {
				probe.FailureThreshold = 3
			}
			if probe.HTTPGet != nil && probe.HTTPGet.Scheme == "" {
				probe.HTTPGet.Scheme = corev1.URISchemeHTTP
			}
		}
		if c.TerminationMessagePath == "" {
			c.TerminationMessagePath = corev1.TerminationMessagePathDefault
		}
		if c.TerminationMessagePolicy == "" {
			c.TerminationMessagePolicy = corev1.TerminationMessageReadFile
		}
		for i := range c.Ports {
			if c.Ports[i].Protocol == "" {
				c.Ports[i].Protocol = corev1.ProtocolTCP
			}
		}
		for key, value := range c.Resources.Limits {
			if _, ok := c.Resources.Requests[key]; !ok {
				if c.Resources.Requests == nil {
					c.Resources.Requests = corev1.ResourceList{}
				}
				c.Resources.Requests[key] = value
			}
		}
	}
	for i := range p.Containers {
		normalize(&p.Containers[i])
	}
	for i := range p.InitContainers {
		normalize(&p.InitContainers[i])
	}
	filtered := p.Tolerations[:0]
	for _, t := range p.Tolerations {
		if (t.Key == "node.kubernetes.io/not-ready" || t.Key == "node.kubernetes.io/unreachable") && t.Operator == corev1.TolerationOpExists && t.Effect == corev1.TaintEffectNoExecute && t.Value == "" && t.TolerationSeconds != nil && *t.TolerationSeconds == 300 {
			continue
		}
		filtered = append(filtered, t)
	}
	p.Tolerations = filtered
}
func workloadState(pod *corev1.Pod, state api.Status) api.Status {
	state.Phase = "Starting"
	state.Reason = "BootstrapPending"
	state.Message = "Guest bootstrap is pending; use the owner client for authenticated enrollment and key status"
	if pod.Status.Phase == corev1.PodFailed || pod.Status.Phase == corev1.PodSucceeded {
		state.Phase = "Stopped"
		state.Reason = podStopReason(pod)
		state.Message = "Explicitly retire the stopped Pod and enroll its replacement"
		return state
	}
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodScheduled && condition.Status == corev1.ConditionFalse {
			state.Phase = "Pending"
			state.Reason = "SchedulingPending"
			state.Message = "Kubernetes has not scheduled the Pod; check node capacity and placement"
			return state
		}
	}
	// Report actual container failures before the generic owner gate. Kubernetes
	// readiness is not evidence that owner enrollment or key release succeeded.
	for _, group := range [][]corev1.ContainerStatus{pod.Status.InitContainerStatuses, pod.Status.ContainerStatuses} {
		for _, c := range group {
			if wait := c.State.Waiting; wait != nil && wait.Reason != "" && wait.Reason != "PodInitializing" && wait.Reason != "ContainerCreating" {
				state.Phase = "StartupPending"
				state.Reason = "ContainerWaiting"
				state.Message = "Container " + c.Name + " is waiting (" + safeContainerReason(wait.Reason) + ")"
				return state
			}
			if ended := c.State.Terminated; ended != nil && ended.ExitCode != 0 {
				state.Phase = "StartupPending"
				state.Reason = "ContainerFailed"
				state.Message = "Container " + c.Name + " exited unsuccessfully; Kubernetes will retry within the existing Pod"
				return state
			}
		}
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
			state.Phase = "Running"
			state.Reason = "PodReady"
			state.Message = "Kubernetes reports ready; verify guest attestation with the owner client"
			return state
		}
	}
	for _, c := range pod.Status.InitContainerStatuses {
		if c.Name == "nebula-await-owner" && c.State.Terminated != nil && c.State.Terminated.ExitCode == 0 {
			state.Phase = "Starting"
			state.Reason = "ApplicationStarting"
			state.Message = "The owner bootstrap gate completed; application startup is pending"
			return state
		}
	}
	return state
}
func safeContainerReason(reason string) string {
	switch reason {
	case "CreateContainerError", "RunContainerError", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "InvalidImageName":
		return reason
	default:
		return "Kubernetes reported a container error"
	}
}

// Old CRDs may prune the optional resolution status fields. Detect that once
// through an uncached read; Pod annotations remain the durable checkpoint and
// subsequent reconciles must not rewrite a pruned status indefinitely.
func (r *WorkloadReconciler) resolutionStatusPruned() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.resolutionStatus == 2
}
func (r *WorkloadReconciler) observeResolutionStatus(ctx context.Context, w *api.ConfidentialWorkload, wanted api.Status) {
	if wanted.DesiredSpecSHA256 == "" {
		return
	}
	r.mu.Lock()
	unknown := r.resolutionStatus == 0
	r.mu.Unlock()
	if !unknown {
		return
	}
	var stored api.ConfidentialWorkload
	if r.Reader.Get(ctx, client.ObjectKeyFromObject(w), &stored) != nil {
		return
	}
	supported := stored.Status.DesiredSpecSHA256 == wanted.DesiredSpecSHA256 && len(stored.Status.ResolvedImageDigests) == len(wanted.ResolvedImageDigests)
	for key, value := range wanted.ResolvedImageDigests {
		supported = supported && stored.Status.ResolvedImageDigests[key] == value
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if supported {
		r.resolutionStatus = 1
	} else {
		r.resolutionStatus = 2
	}
}
