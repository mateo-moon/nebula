package main

import (
	"reflect"
	"testing"
)

func TestNydusProxyMountArguments(t *testing.T) {
	// Synthetic paths and metadata with the same shape as containerd's
	// real invocation. Preserve every option without shell interpretation.
	args := []string{"overlay", "/run/containerd/tmp mount", "-o", "lowerdir=/snapshots/lower",
		"-o", "upperdir=/snapshots/upper,workdir=/snapshots/work", "-o", "io.katacontainers.fs-opt.image=example.invalid/image",
		"-o", "ro", "-t", helper}
	want := []string{helper, "overlay", "/run/containerd/tmp mount", "-o",
		"lowerdir=/snapshots/lower,upperdir=/snapshots/upper,workdir=/snapshots/work,io.katacontainers.fs-opt.image=example.invalid/image,ro"}
	got, err := mountArgs(args)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("mount argument translation failed: %v", err)
	}
	got, err = mountArgs([]string{"overlay", "/target", "-t", helper})
	if err != nil || !reflect.DeepEqual(got, []string{helper, "overlay", "/target"}) {
		t.Fatal("mount without options failed")
	}
}

func TestUnrelatedOrMalformedMountsAreRefused(t *testing.T) {
	for _, args := range [][]string{
		nil, {"overlay", "/target"}, {"device", "/target", "-t", helper},
		{"overlay", "relative", "-t", helper}, {"overlay", "/target", "-t", "/bin/sh"},
		{"overlay", "/target", "-o", "ro"}, {"overlay", "/target", "-t", helper, "-o"},
		{"overlay", "/target", "-t", helper, "-t", helper},
		{"overlay", "/target", "-t", helper, "-x", "unexpected"},
		{"overlay", "/target", "-t", helper, "-o", "ro\x00extra"},
	} {
		if _, err := mountArgs(args); err == nil {
			t.Fatal("unsupported mount was accepted")
		}
	}
}
