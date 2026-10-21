package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type Plan struct {
	Pod            corev1.Pod `json:"pod"`
	SpecSHA256     string     `json:"specSha256"`
	InitDataSHA256 string     `json:"initDataSha256"`
}

type Renderer interface {
	Render(context.Context, *api.ConfidentialWorkload, []api.ConfidentialStorage) (*Plan, error)
	ValidateStorage(context.Context, *api.ConfidentialStorage) error
}

// CommandRenderer uses a fixed, image-bundled executable and arguments. CRs
// supply public JSON on stdin, never executable paths, shell code or credentials.
// stderr is discarded because native registry tools can include credentials.
type CommandRenderer struct {
	Command string
	Args    []string
}

type boundedOutput struct{ bytes.Buffer }

type renderDiagnostic struct {
	reason  string
	message string
}

func (d *renderDiagnostic) Error() string  { return d.message }
func (d *renderDiagnostic) Reason() string { return d.reason }

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 16*1024*1024 {
		return 0, errors.New("renderer output limit exceeded")
	}
	return b.Buffer.Write(p)
}
func (r CommandRenderer) run(ctx context.Context, input any, output any) error {
	data, err := json.Marshal(input)
	if err != nil || len(data) > 4*1024*1024 {
		return errors.New("invalid renderer input")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Command, r.Args...)
	cmd.Stdin = bytes.NewReader(data)
	cmd.Stderr = io.Discard
	// Bound pipe cleanup even if a renderer subprocess outlives its parent.
	cmd.WaitDelay = 2 * time.Second
	var result boundedOutput
	cmd.Stdout = &result
	if err := cmd.Run(); err != nil {
		return errors.New("declaration validation or native policy rendering failed")
	}
	var diagnostic struct {
		Error *struct {
			Reason  string `json:"reason"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(result.Bytes(), &diagnostic) == nil && diagnostic.Error != nil {
		if diagnostic.Error.Reason != "InvalidDeclaration" || len(diagnostic.Error.Message) > 256 ||
			!strings.HasPrefix(diagnostic.Error.Message, "Confidential workload: ") ||
			strings.ContainsAny(diagnostic.Error.Message, "\r\n\x00") {
			return errors.New("invalid renderer diagnostic")
		}
		return &renderDiagnostic{reason: diagnostic.Error.Reason, message: diagnostic.Error.Message}
	}
	if err := json.Unmarshal(result.Bytes(), output); err != nil {
		return errors.New("invalid renderer response")
	}
	return nil
}
func (r CommandRenderer) Render(ctx context.Context, w *api.ConfidentialWorkload, storages []api.ConfidentialStorage) (*Plan, error) {
	// Do not pass status or arbitrary annotations through the rendering protocol.
	clean := w.DeepCopy()
	clean.TypeMeta = metav1.TypeMeta{APIVersion: api.GroupVersion.String(), Kind: "ConfidentialWorkload"}
	clean.ObjectMeta = metav1.ObjectMeta{Name: w.Name, Namespace: w.Namespace}
	clean.Status = api.Status{}
	items := make([]api.ConfidentialStorage, 0, len(storages))
	for _, s := range storages {
		s.TypeMeta = metav1.TypeMeta{APIVersion: api.GroupVersion.String(), Kind: "ConfidentialStorage"}
		s.ObjectMeta = metav1.ObjectMeta{Name: s.Name, Namespace: s.Namespace}
		s.Status = api.Status{}
		items = append(items, s)
	}
	var plan Plan
	err := r.run(ctx, map[string]any{"operation": "render-workload", "workload": clean, "storages": items}, &plan)
	if err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(plan.SpecSHA256) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(plan.InitDataSHA256) || plan.Pod.Namespace != w.Namespace || plan.Pod.GenerateName == "" || plan.Pod.Name != "" || len(plan.Pod.Spec.Containers) == 0 {
		return nil, errors.New("invalid rendered Pod or identity")
	}
	return &plan, nil
}
func (r CommandRenderer) ValidateStorage(ctx context.Context, s *api.ConfidentialStorage) error {
	clean := s.DeepCopy()
	clean.TypeMeta = metav1.TypeMeta{APIVersion: api.GroupVersion.String(), Kind: "ConfidentialStorage"}
	clean.ObjectMeta = metav1.ObjectMeta{Name: s.Name, Namespace: s.Namespace}
	clean.Status = api.Status{}
	var result map[string]any
	return r.run(ctx, map[string]any{"operation": "validate-storage", "storage": clean}, &result)
}
