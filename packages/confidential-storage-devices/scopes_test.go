// Licensed under the Apache License, Version 2.0.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/containerd/nri/pkg/api"
	"google.golang.org/protobuf/proto"
)

// Synthetic names only: these cover the scope sources a deployment uses
// without the compiled table (grant flags and a scope file).
const ownNamespace = "tenant-a"

func TestGeneratedStorageScope(t *testing.T) {
	args := ownArgs("--storage-generated-binding", "profile-=nebula-storage-data")
	c, err := parseConfig(args, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	assertRecipients(t, c, []recipient{
		{ownNamespace, "profile-bc245", "nebula-storage-data", runtimeHandler, grantFor(true)},
		{ownNamespace, "profile-bc246", "nebula-storage-data", runtimeHandler, grantFor(true)},
		{ownNamespace, "profile-bc245", "application", runtimeHandler, nil},
		{ownNamespace, "profile-bc245", "nebula-storage-other", runtimeHandler, nil},
		{ownNamespace, "profile-extra-bc245", "nebula-storage-data", runtimeHandler, nil},
		{ownNamespace, "profile-bc245", "nebula-storage-data", "runc", nil},
		{"tenant-b", "profile-bc245", "nebula-storage-data", runtimeHandler, nil},
	})
	for _, value := range []string{"*=nebula-storage-data", "profile=nebula-storage-data",
		"profile-=app", "profile-=nebula-storage-*", "-=nebula-storage-data"} {
		if _, err := parseConfig(ownArgs("--storage-generated-binding", value), io.Discard); err == nil {
			t.Fatalf("accepted invalid generated scope %s", value)
		}
	}
	if _, err := parseConfig(dropFlag(args, "--own-namespace"), io.Discard); err == nil {
		t.Fatal("accepted missing own namespace")
	}
	if _, err := parseConfig(append(args, "--attest-binding", "guest=adapter"), io.Discard); err == nil {
		t.Fatal("accepted mixed scope sources")
	}
}

const tenantScopes = `{
  "version": 1,
  "scopes": {
    "tenant-a": {
      "guest-a=storage": "storage",
      "guest-a=adapter": "attest",
      "guest-b=adapter": "attest"
    },
    "tenant-b": {
      "guest-z=storage": "storage"
    }
  }
}
`

func ownArgs(extra ...string) []string {
	return append([]string{"--idx", "97", "--namespace", ownNamespace, "--own-namespace", ownNamespace,
		"--runtime-handler", runtimeHandler, "--device-major", "10", "--device-minor", "258"}, extra...)
}

func setFlag(args []string, flag, value string) []string {
	out := append([]string{}, args...)
	for i := 0; i+1 < len(out); i += 2 {
		if out[i] == flag {
			out[i+1] = value
		}
	}
	return out
}

func dropFlag(args []string, flag string) []string {
	out := []string{}
	for i := 0; i+1 < len(args); i += 2 {
		if args[i] != flag {
			out = append(out, args[i], args[i+1])
		}
	}
	return out
}

func writeScopes(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "scopes.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// grantFor is the exact adjustment a recipient receives: /dev/sev-guest for
// attest, plus /dev/mapper/control for storage.
func grantFor(storage bool) *api.ContainerAdjustment {
	want := &api.ContainerAdjustment{}
	want.AddDevice(&api.LinuxDevice{Path: "/dev/sev-guest", Type: "c", Major: 10, Minor: 258, FileMode: &api.OptionalFileMode{Value: 384}})
	if storage {
		want.AddDevice(&api.LinuxDevice{Path: "/dev/mapper/control", Type: "c", Major: 10, Minor: 236, FileMode: &api.OptionalFileMode{Value: 384}})
	}
	return want
}

type recipient struct {
	namespace, pod, container, runtime string
	want                               *api.ContainerAdjustment
}

func assertRecipients(t *testing.T, c config, cases []recipient) {
	t.Helper()
	p := &plugin{config: c}
	for _, tc := range cases {
		pod := &api.PodSandbox{Name: tc.pod, Namespace: tc.namespace, RuntimeHandler: tc.runtime,
			Annotations: map[string]string{"devices.noderesource.dev/container." + tc.container: "[{path: /dev/kvm, type: c, major: 10, minor: 232}]"}}
		ctr := &api.Container{Name: tc.container, Annotations: map[string]string{"devices.nri.io": "/dev/mapper/control"}}
		adjust, updates, err := p.CreateContainer(context.Background(), pod, ctr)
		if err != nil || len(updates) != 0 {
			t.Fatalf("%v: unexpected error/update: %v %v", tc, err, updates)
		}
		if tc.want == nil {
			if adjust != nil {
				t.Fatalf("%s/%s/%s (%s): out-of-scope adjustment %v", tc.namespace, tc.pod, tc.container, tc.runtime, adjust)
			}
			continue
		}
		if !proto.Equal(adjust, tc.want) {
			t.Fatalf("%s/%s/%s: got %v, want %v", tc.namespace, tc.pod, tc.container, adjust, tc.want)
		}
	}
}

func TestGrantFlagsDeclareTheWholeScope(t *testing.T) {
	c, err := parseConfig(ownArgs("--storage-binding", "guest-a=storage", "--attest-binding", "guest-a=adapter",
		"--attest-binding", "guest-b.v2=adapter"), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.bindings.String(); got != "guest-a=adapter,guest-a=storage,guest-b.v2=adapter" {
		t.Fatalf("selected bindings: %s", got)
	}
	if c.source != "flags" || c.ownNamespace != ownNamespace {
		t.Fatalf("source %q own namespace %q", c.source, c.ownNamespace)
	}
	assertRecipients(t, c, []recipient{
		{ownNamespace, "guest-a", "storage", runtimeHandler, grantFor(true)},
		{ownNamespace, "guest-a", "adapter", runtimeHandler, grantFor(false)},
		{ownNamespace, "guest-b.v2", "adapter", runtimeHandler, grantFor(false)},
		{ownNamespace, "guest-b.v2", "storage", runtimeHandler, nil},
		{ownNamespace, "guest-a", "workload", runtimeHandler, nil},
		{ownNamespace, "guest-a", "initialize", runtimeHandler, nil},
		{ownNamespace, "guest-c", "storage", runtimeHandler, nil},
		{ownNamespace, "guest-a-stage", "storage", runtimeHandler, nil},
		{ownNamespace, "guest-a", "storage", "runc", nil},
		{ownNamespace, "guest-a", "storage", "", nil},
		{"tenant-b", "guest-a", "storage", runtimeHandler, nil},
		{"default", "guest-a", "adapter", runtimeHandler, nil},
		{"kube-system", "guest-a", "storage", runtimeHandler, nil},
	})
}

func TestTheTargetNamespaceMustBeTheInjectorsOwn(t *testing.T) {
	grants := ownArgs("--storage-binding", "guest-a=storage")
	file := ownArgs("--scopes-file", writeScopes(t, tenantScopes), "--binding", "guest-a=storage")
	for name, args := range map[string][]string{
		"grants":        grants,
		"file":          file,
		"file tenant-b": setFlag(setFlag(ownArgs("--scopes-file", writeScopes(t, tenantScopes), "--binding", "guest-z=storage"), "--namespace", "tenant-b"), "--own-namespace", "tenant-b"),
	} {
		if _, err := parseConfig(args, io.Discard); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	for _, args := range [][]string{grants, file} {
		for name, bad := range map[string][]string{
			"absent":                  dropFlag(args, "--own-namespace"),
			"another namespace":       setFlag(args, "--own-namespace", "tenant-b"),
			"another target":          setFlag(args, "--namespace", "tenant-b"),
			"empty":                   setFlag(args, "--own-namespace", ""),
			"unexpanded downward API": setFlag(args, "--own-namespace", "$(POD_NAMESPACE)"),
			"prefix":                  setFlag(args, "--own-namespace", "tenant"),
			"case":                    setFlag(args, "--own-namespace", "Tenant-A"),
			"padded":                  setFlag(args, "--own-namespace", " tenant-a"),
		} {
			if _, err := parseConfig(bad, io.Discard); err == nil {
				t.Fatalf("accepted own namespace case %q: %v", name, bad)
			}
		}
	}
}

func TestGrantFlagsRefuseInvalidOrMixedScopes(t *testing.T) {
	base := ownArgs("--storage-binding", "guest-a=storage")
	if _, err := parseConfig(base, io.Discard); err != nil {
		t.Fatal(err)
	}
	both := func(value string) []string {
		return setFlag(setFlag(base, "--namespace", value), "--own-namespace", value)
	}
	cases := map[string][]string{
		"uppercase namespace":     both("Tenant-A"),
		"underscore namespace":    both("tenant_a"),
		"leading dash namespace":  both("-tenant"),
		"trailing dash namespace": both("tenant-"),
		"dotted namespace":        both("tenant.a"),
		"long namespace":          both(strings.Repeat("a", 64)),
		"empty namespace":         both(""),
		"runtime":                 setFlag(base, "--runtime-handler", "runc"),
		"device":                  setFlag(base, "--device-minor", "42"),
		"index":                   setFlag(base, "--idx", "9"),
		"relative socket":         append(append([]string{}, base...), "--socket-path", "nri.sock"),
		"health port":             append(append([]string{}, base...), "--health-address", ":80"),
		"selection with grants":   append(append([]string{}, base...), "--binding", "guest-a=storage"),
		"file with grants":        append(append([]string{}, base...), "--scopes-file", writeScopes(t, tenantScopes)),
		"duplicate grant":         append(append([]string{}, base...), "--storage-binding", "guest-a=storage"),
		"regranted as attest":     append(append([]string{}, base...), "--attest-binding", "guest-a=storage"),
		"positional":              append(append([]string{}, base...), "guest-b=adapter"),
	}
	for _, grant := range []string{"", "*=storage", "guest-a", "guest-a=", "=storage", "guest-a=storage=x", "Guest=storage",
		"guest-a=Storage", "guest-a=stor.age", ".guest=storage", "guest-=storage", "guest-a=-storage", "guest a=storage",
		strings.Repeat("a", 254) + "=storage", "guest-a=" + strings.Repeat("a", 64)} {
		cases["storage grant "+grant] = ownArgs("--storage-binding", grant)
		cases["attest grant "+grant] = ownArgs("--attest-binding", grant)
	}
	for name, args := range cases {
		if _, err := parseConfig(args, io.Discard); err == nil {
			t.Fatalf("accepted %s: %v", name, args)
		}
	}
	// The longest valid names are accepted.
	long := ownArgs("--attest-binding", strings.Repeat("a", 253)+"="+strings.Repeat("b", 63))
	if _, err := parseConfig(setFlag(setFlag(long, "--namespace", strings.Repeat("c", 63)), "--own-namespace", strings.Repeat("c", 63)), io.Discard); err != nil {
		t.Fatal(err)
	}
}

func TestScopeFileSelectsRecipientsLikeACompiledTable(t *testing.T) {
	path := writeScopes(t, tenantScopes)
	c, err := parseConfig(ownArgs("--scopes-file", path, "--binding", "guest-a=storage", "--binding", "guest-a=adapter"), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(tenantScopes))
	if c.source != "file" || c.scopesSHA256 != hex.EncodeToString(sum[:]) || c.ownNamespace != ownNamespace {
		t.Fatalf("source %q sha256 %q own %q", c.source, c.scopesSHA256, c.ownNamespace)
	}
	assertRecipients(t, c, []recipient{
		{ownNamespace, "guest-a", "storage", runtimeHandler, grantFor(true)},
		{ownNamespace, "guest-a", "adapter", runtimeHandler, grantFor(false)},
		// In the file's scope but not selected.
		{ownNamespace, "guest-b", "adapter", runtimeHandler, nil},
		{"tenant-b", "guest-z", "storage", runtimeHandler, nil},
		{"tenant-b", "guest-a", "storage", runtimeHandler, nil},
		{ownNamespace, "guest-z", "storage", runtimeHandler, nil},
		{ownNamespace, "guest-a", "storage", "runc", nil},
	})
	for name, args := range map[string][]string{
		"other namespace's binding": ownArgs("--scopes-file", path, "--binding", "guest-z=storage"),
		"unknown binding":           ownArgs("--scopes-file", path, "--binding", "guest-c=storage"),
		"access is the file's":      ownArgs("--scopes-file", path, "--binding", "guest-b=storage"),
		"no selection":              ownArgs("--scopes-file", path),
		"duplicate selection":       ownArgs("--scopes-file", path, "--binding", "guest-a=storage", "--binding", "guest-a=storage"),
		"namespace not in file":     setFlag(setFlag(ownArgs("--scopes-file", path, "--binding", "guest-a=storage"), "--namespace", "tenant-c"), "--own-namespace", "tenant-c"),
		"binding of another scope":  setFlag(setFlag(ownArgs("--scopes-file", path, "--binding", "guest-a=storage"), "--namespace", "tenant-b"), "--own-namespace", "tenant-b"),
	} {
		if _, err := parseConfig(args, io.Discard); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
}

func TestScopeFileIsStrict(t *testing.T) {
	valid := `{"version": 1, "scopes": {"tenant-a": {"guest-a=storage": "storage"}}}`
	args := func(path string) []string { return ownArgs("--scopes-file", path, "--binding", "guest-a=storage") }
	if _, err := parseConfig(args(writeScopes(t, valid)), io.Discard); err != nil {
		t.Fatal(err)
	}
	scope := func(body string) string { return `{"version": 1, "scopes": {"tenant-a": {` + body + `}}}` }
	for name, content := range map[string]string{
		"empty":               "",
		"truncated":           `{"version": 1, "scopes": {"tenant-a": {"guest-a=storage": "storage"}}`,
		"array":               `[]`,
		"null":                `null`,
		"trailing object":     valid + ` {}`,
		"trailing garbage":    valid + ` x`,
		"missing version":     `{"scopes": {"tenant-a": {"guest-a=storage": "storage"}}}`,
		"missing scopes":      `{"version": 1}`,
		"version 2":           `{"version": 2, "scopes": {"tenant-a": {"guest-a=storage": "storage"}}}`,
		"version string":      `{"version": "1", "scopes": {"tenant-a": {"guest-a=storage": "storage"}}}`,
		"version float":       `{"version": 1.0, "scopes": {"tenant-a": {"guest-a=storage": "storage"}}}`,
		"duplicate version":   `{"version": 1, "version": 1, "scopes": {"tenant-a": {"guest-a=storage": "storage"}}}`,
		"duplicate scopes":    `{"version": 1, "scopes": {"tenant-a": {"guest-a=storage": "storage"}}, "scopes": {}}`,
		"unknown key":         `{"version": 1, "scopes": {"tenant-a": {"guest-a=storage": "storage"}}, "bindings": []}`,
		"no namespaces":       `{"version": 1, "scopes": {}}`,
		"scopes array":        `{"version": 1, "scopes": [{"tenant-a": {"guest-a=storage": "storage"}}]}`,
		"empty scope":         `{"version": 1, "scopes": {"tenant-a": {}}}`,
		"scope string":        `{"version": 1, "scopes": {"tenant-a": "guest-a=storage"}}`,
		"duplicate namespace": `{"version": 1, "scopes": {"tenant-a": {"guest-a=adapter": "attest"}, "tenant-a": {"guest-a=storage": "storage"}}}`,
		"duplicate binding":   scope(`"guest-a=storage": "attest", "guest-a=storage": "storage"`),
		"invalid namespace":   `{"version": 1, "scopes": {"Tenant-A": {"guest-a=storage": "storage"}}}`,
		"numeric key":         `{"version": 1, "scopes": {1: {"guest-a=storage": "storage"}}}`,
		"escaped duplicate":   scope(`"guest-a=storage": "storage", "guest-a\u003dstorage": "attest"`),
		"namespace wildcard":  `{"version": 1, "scopes": {"*": {"guest-a=storage": "storage"}}}`,
		"binding wildcard":    scope(`"guest-a=storage": "storage", "*=storage": "storage"`),
		"binding no role":     scope(`"guest-a=storage": "storage", "guest-a": "storage"`),
		"binding two roles":   scope(`"guest-a=storage": "storage", "guest-a=storage=x": "storage"`),
		"access peer":         scope(`"guest-a=storage": "peer"`),
		"access all":          scope(`"guest-a=storage": "all"`),
		"access empty":        scope(`"guest-a=storage": ""`),
		"access case":         scope(`"guest-a=storage": "Storage"`),
		"access number":       scope(`"guest-a=storage": 1`),
		"access null":         scope(`"guest-a=storage": null`),
		"access list":         scope(`"guest-a=storage": ["storage"]`),
		"access object":       scope(`"guest-a=storage": {"access": "storage"}`),
		"oversized":           valid + strings.Repeat(" ", 1<<20),
	} {
		if _, err := parseConfig(args(writeScopes(t, content)), io.Discard); err == nil {
			t.Fatalf("accepted scope file %q", name)
		}
		// The decoder itself refuses it, not only a later scope check.
		if _, err := decodeScopes([]byte(content)); err == nil && name != "oversized" {
			t.Fatalf("decoded scope file %q", name)
		}
	}
	dir := t.TempDir()
	for name, path := range map[string]string{
		"empty path":   "",
		"relative":     "scopes.json",
		"unclean":      dir + "/../" + filepath.Base(dir) + "/scopes.json",
		"missing file": filepath.Join(dir, "absent.json"),
		"directory":    dir,
		"device":       os.DevNull,
	} {
		if _, err := parseConfig(args(path), io.Discard); err == nil {
			t.Fatalf("accepted scope file path %s", name)
		}
	}
	fifo := filepath.Join(dir, "fifo.json")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := parseConfig(args(fifo), io.Discard); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("accepted a FIFO")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("opening a FIFO blocked the start")
	}
}

func TestWithoutACompiledTableASourceIsRequired(t *testing.T) {
	saved := compiledScopes
	compiledScopes = nil
	defer func() { compiledScopes = saved }()
	selection := []string{"--idx", "97", "--namespace", ownNamespace, "--runtime-handler", runtimeHandler,
		"--device-major", "10", "--device-minor", "258", "--binding", "guest-a=storage"}
	for _, args := range [][]string{selection, append(append([]string{}, selection...), "--own-namespace", ownNamespace)} {
		if _, err := parseConfig(args, io.Discard); err == nil || !strings.Contains(err.Error(), "--scopes-file or the grant flags") {
			t.Fatalf("selected a binding without a scope table: %v: %v", args, err)
		}
	}
	for _, args := range [][]string{
		ownArgs("--storage-binding", "guest-a=storage"),
		ownArgs("--scopes-file", writeScopes(t, tenantScopes), "--binding", "guest-a=storage"),
	} {
		if _, err := parseConfig(args, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
}

// Only a non-default scope source logs the extra start line; the compiled
// table's start output is unchanged.
func TestScopeLineRecordsANonDefaultSource(t *testing.T) {
	path := writeScopes(t, tenantScopes)
	file, err := parseConfig(ownArgs("--scopes-file", path, "--binding", "guest-a=storage"), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(tenantScopes))
	want := "SCOPED_SNP_SCOPE source=file path=" + path + " sha256=" + hex.EncodeToString(sum[:]) + " own_namespace=" + ownNamespace
	if got := scopeLine(file); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	flags, err := parseConfig(ownArgs("--attest-binding", "guest-a=adapter"), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if got := scopeLine(flags); got != "SCOPED_SNP_SCOPE source=flags own_namespace="+ownNamespace {
		t.Fatalf("got %q", got)
	}
}
