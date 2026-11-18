// Licensed under the Apache License, Version 2.0.
package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/containerd/nri/pkg/api"
	"google.golang.org/protobuf/proto"
)

const fixtureNamespace = "fixture-a"

func init() {
	compiledScopes = map[string]map[string]deviceAccess{fixtureNamespace: {"guest-a=storage": storageDevices}}
}

func validArgs() []string {
	return []string{"--idx", "93", "--namespace", fixtureNamespace, "--runtime-handler", runtimeHandler, "--device-major", "10", "--device-minor", "258", "--binding", "guest-a=storage"}
}

func validConfig(t *testing.T) config {
	t.Helper()
	c, err := parseConfig(validArgs(), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConfigurationRequiresExactScopeAndDevice(t *testing.T) {
	cases := []struct{ flag, value string }{
		{"--idx", ""}, {"--idx", "9"}, {"--idx", "900"}, {"--idx", "xx"},
		{"--namespace", ""}, {"--namespace", "default"},
		{"--runtime-handler", ""}, {"--runtime-handler", "runc"},
		{"--device-major", "-1"}, {"--device-major", "0"}, {"--device-major", "11"},
		{"--device-major", "18446744073709551616"}, {"--device-major", "malformed"},
		{"--device-minor", "-1"}, {"--device-minor", "42"}, {"--device-minor", "malformed"},
		{"--binding", ""}, {"--binding", "*=storage"}, {"--binding", "guest-a=control"},
		{"--binding", "guest-a=storage=control"}, {"--binding", "guest-a"},
	}
	for _, tc := range cases {
		t.Run(tc.flag+"="+tc.value, func(t *testing.T) {
			args := validArgs()
			for i := 0; i < len(args); i += 2 {
				if args[i] == tc.flag {
					args[i+1] = tc.value
				}
			}
			if _, err := parseConfig(args, io.Discard); err == nil {
				t.Fatal("accepted invalid configuration")
			}
		})
	}
	for _, flag := range []string{"--idx", "--namespace", "--runtime-handler", "--device-major", "--device-minor", "--binding"} {
		t.Run("missing "+flag, func(t *testing.T) {
			args := validArgs()
			for i := 0; i < len(args); i += 2 {
				if args[i] == flag {
					args = append(args[:i], args[i+2:]...)
					break
				}
			}
			if _, err := parseConfig(args, io.Discard); err == nil {
				t.Fatal("accepted missing required flag")
			}
		})
	}
	for _, extra := range [][]string{
		{"unexpected"}, {"--unknown", "x"}, {"--socket-path", "relative/socket"},
		{"--socket-path", "/run/../socket"}, {"--health-address", ":80"},
		{"--health-address", "8080"}, {"--binding", "guest-a=storage"},
		{"--device-path", "/dev/kvm"}, {"--device-annotation-file", "/host/file"},
	} {
		t.Run(strings.Join(extra, " "), func(t *testing.T) {
			if _, err := parseConfig(append(validArgs(), extra...), io.Discard); err == nil {
				t.Fatal("accepted unexpected configuration")
			}
		})
	}
}

func assertDeviceOnly(t *testing.T, adjustment *api.ContainerAdjustment) {
	t.Helper()
	want := &api.ContainerAdjustment{}
	want.AddDevice(&api.LinuxDevice{Path: "/dev/sev-guest", Type: "c", Major: 10, Minor: 258, FileMode: &api.OptionalFileMode{Value: 384}})
	want.AddDevice(&api.LinuxDevice{Path: "/dev/mapper/control", Type: "c", Major: 10, Minor: 236, FileMode: &api.OptionalFileMode{Value: 384}})
	if !proto.Equal(adjustment, want) {
		t.Fatalf("adjustment differs from exact device-only request: got %v, want %v", adjustment, want)
	}
	// Check the consumer's OCI representation independently of the producer's
	// optional-value helper: nil means mode 0 at the Kata policy boundary.
	device := adjustment.Linux.Devices[0].ToOCI()
	if device.FileMode == nil || *device.FileMode != 0600 {
		t.Fatalf("OCI device must explicitly request mode 0600, got %v", device.FileMode)
	}
}

func TestEveryScopeDimension(t *testing.T) {
	p := &plugin{config: validConfig(t)}
	cases := []struct {
		name, namespace, pod, uid, container, runtime string
		want                                          bool
	}{
		{"match", fixtureNamespace, "guest-a", "first-uid", "storage", runtimeHandler, true},
		{"recreated UID", fixtureNamespace, "guest-a", "second-uid", "storage", runtimeHandler, true},
		{"namespace", "other", "guest-a", "first-uid", "storage", runtimeHandler, false},
		{"pod", fixtureNamespace, "guest-a-extra", "first-uid", "storage", runtimeHandler, false},
		{"container", fixtureNamespace, "guest-a", "first-uid", "control", runtimeHandler, false},
		{"init container", fixtureNamespace, "guest-a", "first-uid", "device-check", runtimeHandler, false},
		{"runtime", fixtureNamespace, "guest-a", "first-uid", "storage", "runc", false},
		{"empty runtime", fixtureNamespace, "guest-a", "first-uid", "storage", "", false},
		{"unselected allowed pod", fixtureNamespace, "unselected-pod", "first-uid", "storage", runtimeHandler, false},
		{"unselected denied recipient", fixtureNamespace, "different-pod", "first-uid", "control", runtimeHandler, false},
		{"unselected denied image", fixtureNamespace, "unknown-pod", "first-uid", "storage", runtimeHandler, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pod := &api.PodSandbox{Name: tc.pod, Namespace: tc.namespace, Uid: tc.uid, RuntimeHandler: tc.runtime}
			adjust, updates, err := p.CreateContainer(context.Background(), pod, &api.Container{Name: tc.container})
			if err != nil || len(updates) != 0 {
				t.Fatalf("unexpected error/update: %v %v", err, updates)
			}
			if tc.want {
				assertDeviceOnly(t, adjust)
			} else if adjust != nil {
				t.Fatalf("out-of-scope adjustment: %v", adjust)
			}
		})
	}
	for _, input := range []struct {
		pod *api.PodSandbox
		ctr *api.Container
	}{
		{nil, nil}, {nil, &api.Container{Name: "storage"}}, {&api.PodSandbox{}, nil},
	} {
		adjust, updates, err := p.CreateContainer(context.Background(), input.pod, input.ctr)
		if adjust != nil || len(updates) != 0 || err != nil {
			t.Fatalf("nil scope was not ignored: %v %v %v", adjust, updates, err)
		}
	}
}

func TestWorkloadAnnotationsNeverConfigureAdjustments(t *testing.T) {
	p := &plugin{config: validConfig(t)}
	pod := &api.PodSandbox{Name: "guest-a", Namespace: fixtureNamespace, RuntimeHandler: runtimeHandler,
		Annotations: map[string]string{
			"devices.noderesource.dev/container.storage":       "[{path: /dev/kvm, type: c, major: 10, minor: 232}]",
			"devices.nri.io/pod":                               "malformed YAML: [",
			"mounts.noderesource.dev/container.storage":        "[{source: /, destination: /host}]",
			"cdi-devices.noderesource.dev":                     "[untrusted/device]",
			"io.katacontainers.config.hypervisor.cc_init_data": "measured policy remains opaque",
		}}
	ctr := &api.Container{Name: "storage", Annotations: map[string]string{"devices.nri.io": "bad device", "sysctl.noderesource.dev": "bad sysctl"}}
	podBefore, ctrBefore := proto.Clone(pod), proto.Clone(ctr)
	adjust, updates, err := p.CreateContainer(context.Background(), pod, ctr)
	if err != nil || len(updates) != 0 {
		t.Fatalf("unexpected error/update: %v %v", err, updates)
	}
	assertDeviceOnly(t, adjust)
	if !proto.Equal(pod, podBefore) || !proto.Equal(ctr, ctrBefore) {
		t.Fatal("mutated incoming workload data")
	}
}

func TestRuntimeConfigurationCannotOverrideArguments(t *testing.T) {
	p := &plugin{config: validConfig(t)}
	events, err := p.Configure(context.Background(), "", "containerd", "test")
	var want api.EventMask
	want.Set(api.Event_CREATE_CONTAINER)
	if err != nil || events != want {
		t.Fatalf("unexpected subscription: %v %v", events, err)
	}
	for _, input := range []string{"{}", "namespace: other", "bindings: ['*=*']"} {
		if _, err := p.Configure(context.Background(), input, "containerd", "test"); err == nil {
			t.Fatal("accepted external runtime configuration")
		}
	}
}

func TestReadinessTracksNRIRegistration(t *testing.T) {
	var readiness atomic.Uint32
	handler := healthHandler(&readiness)
	for _, tc := range []struct {
		state  uint32
		path   string
		status int
	}{
		{0, "/readyz", http.StatusServiceUnavailable},
		{0, "/healthz", http.StatusOK},
		{nriRegistered, "/readyz", http.StatusServiceUnavailable},
		{nriSynchronized, "/readyz", http.StatusServiceUnavailable},
		{nriRegistered | nriSynchronized, "/readyz", http.StatusOK},
		{nriRegistered | nriSynchronized | nriDisconnected, "/readyz", http.StatusServiceUnavailable},
		{nriRegistered | nriSynchronized, "/configure", http.StatusNotFound},
	} {
		readiness.Store(tc.state)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if response.Code != tc.status {
			t.Fatalf("%s state=%d: got %d want %d", tc.path, tc.state, response.Code, tc.status)
		}
	}
}

func TestSynchronizeOnlyMarksReadiness(t *testing.T) {
	var readiness atomic.Uint32
	p := &plugin{config: validConfig(t), readiness: &readiness}
	readiness.Or(nriRegistered)
	updates, err := p.Synchronize(context.Background(), []*api.PodSandbox{{Name: "guest-a"}}, []*api.Container{{Name: "storage"}})
	if err != nil || len(updates) != 0 || readiness.Load() != nriRegistered|nriSynchronized {
		t.Fatalf("unexpected synchronization: %v %v state=%d", updates, err, readiness.Load())
	}
	readiness.Or(nriDisconnected)
	if _, err := p.Synchronize(context.Background(), nil, nil); err != nil {
		t.Fatal(err)
	}
	if readiness.Load() != nriRegistered|nriSynchronized|nriDisconnected {
		t.Fatal("synchronization cleared terminal disconnected state")
	}
}
