// Licensed under the Apache License, Version 2.0.
package main

import (
	"errors"
	"flag"
	"io"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// A compiled table with synthetic names, standing in for the one a build may embed.
var syntheticTable = map[string]map[string]deviceAccess{
	ownNamespace: {"guest-a=storage": storageDevices, "guest-a=adapter": peerDevices},
	"tenant-b":   {"guest-z=storage": storageDevices},
}

func withCompiledTable(t *testing.T, table map[string]map[string]deviceAccess) {
	t.Helper()
	saved := compiledScopes
	compiledScopes = table
	t.Cleanup(func() { compiledScopes = saved })
}

// On the compiled table a --binding the table does not name was a parse failure before the other scope sources
// existed, so -h after it exited 1. It still does; a known binding, or another source, leaves -h a request for help.
func TestHelpAfterAnUnknownCompiledBindingIsAParseFailure(t *testing.T) {
	withCompiledTable(t, syntheticTable)
	for _, args := range [][]string{
		{"--binding", "bogus", "-h"},
		{"--binding", "guest-c=storage", "-h"},
		{"--binding", "guest-a=storage", "--binding", "other=storage", "--help"},
		{"--own-namespace", ownNamespace, "--binding", "bogus", "-h"},
	} {
		if _, err := parseConfig(args, io.Discard); err == nil || errors.Is(err, flag.ErrHelp) {
			t.Fatalf("%v: %v", args, err)
		}
	}
	for _, args := range [][]string{
		{"-h"},
		{"--binding", "guest-a=storage", "-h"},
		{"--binding", "guest-z=storage", "-h"},
		{"-h", "--binding", "bogus"},
		{"--scopes-file", writeScopes(t, tenantScopes), "--binding", "bogus", "-h"},
		{"--storage-binding", "guest-c=storage", "-h"},
		{"--storage-binding", "guest-c=storage", "--binding", "bogus", "-h"},
		{"--attest-binding", "guest-c=adapter", "--binding", "bogus", "-h"},
	} {
		if _, err := parseConfig(args, io.Discard); !errors.Is(err, flag.ErrHelp) {
			t.Fatalf("%v: %v", args, err)
		}
	}
	withCompiledTable(t, nil)
	if _, err := parseConfig([]string{"--binding", "bogus", "-h"}, io.Discard); !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("without a compiled table: %v", err)
	}
}

// The restored parse failure reads as the flag package reported it, and names the first unknown binding in sorted
// order whatever the argument order, so the message is the same on every run.
func TestTheRestoredParseFailureNamesTheFirstUnknownBinding(t *testing.T) {
	withCompiledTable(t, syntheticTable)
	want := `invalid value "guest-c=storage" for flag -binding: unsupported device binding "guest-c=storage"`
	for i := 0; i < 64; i++ {
		_, err := parseConfig([]string{"--binding", "zz=storage", "--binding", "guest-a=storage", "--binding", "guest-d=adapter",
			"--binding", "guest-c=storage", "-h"}, io.Discard)
		if err == nil || err.Error() != want {
			t.Fatalf("run %d: %v, want %s", i, err, want)
		}
	}
}

// A scope file that cannot be opened is reported as such; one that opens but is not a regular file is refused.
func TestTheScopeFileRefusalsSayWhy(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent.json")
	_, err := parseConfig(ownArgs("--scopes-file", missing, "--binding", "guest-a=storage"), io.Discard)
	if err == nil || !strings.HasPrefix(err.Error(), "scope file: ") || !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("absent scope file: %v", err)
	}
	_, err = parseConfig(ownArgs("--scopes-file", t.TempDir(), "--binding", "guest-a=storage"), io.Discard)
	if err == nil || err.Error() != "--scopes-file must name a regular file" {
		t.Fatalf("directory as scope file: %v", err)
	}
}
