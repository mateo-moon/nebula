package imagestore

import (
	"bytes"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const testAuthority = "confidential-operator-images.test-namespace.svc:8084"

// Reproducible synthetic RFC address-class fixtures only. No test contacts
// these addresses, and none are taken from a live deployment.
var (
	syntheticPrivateIP        = netip.AddrFrom4([4]byte{10, 96, 1, 2}).String()
	syntheticUpdatedPrivateIP = netip.AddrFrom4([4]byte{10, 96, 1, 3}).String()
	syntheticPrivateBaseIP    = netip.AddrFrom4([4]byte{10, 0, 0, 1}).String()
	syntheticLoopbackIP       = netip.AddrFrom4([4]byte{127, 0, 0, 1}).String()
	syntheticUnspecifiedIP    = netip.AddrFrom4([4]byte{}).String()
	syntheticLinkLocalIP      = netip.AddrFrom4([4]byte{169, 254, 1, 1}).String()
	syntheticPublicIP         = netip.AddrFrom4([4]byte{8, 8, 8, 8}).String()
	syntheticPrivateV6        = netip.AddrFrom16([16]byte{0: 0xfd, 14: 0x12, 15: 0x34}).String()
	syntheticPrivateV6One     = netip.AddrFrom16([16]byte{0: 0xfd, 15: 1}).String()
	syntheticLoopbackV6       = netip.AddrFrom16([16]byte{15: 1}).String()
	syntheticUnspecifiedV6    = netip.AddrFrom16([16]byte{}).String()
	syntheticLinkLocalV6      = netip.AddrFrom16([16]byte{0: 0xfe, 1: 0x80, 15: 1}).String()
	syntheticMulticastV6      = netip.AddrFrom16([16]byte{0: 0xff, 15: 1}).String()
	syntheticPublicV6         = netip.AddrFrom16([16]byte{0: 0x26, 1: 6, 2: 0x47, 4: 0x47, 14: 0x11, 15: 0x11}).String()
	syntheticMappedV6         = netip.AddrFrom16([16]byte{10: 0xff, 11: 0xff, 12: 10, 15: 1}).String()
)

func registryDirectory(t *testing.T) string {
	t.Helper()
	// macOS's standard temporary directory can itself have a symlink ancestor.
	// Production init uses a real, authority-specific mount with no symlinks.
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestReaderNamespaceIsAnOptionalSingleExactConfiguredAuthority(t *testing.T) {
	config := Config{Directory: t.TempDir(), Repository: repository, Authority: testAuthority, MaxBytes: 1 << 20}
	s, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cfg, layer, manifest := populate(t, s)
	paths := []string{"/v2/", "/v2", prefix + "/manifests/release", prefix + "/manifests/" + digest(manifest), prefix + "/blobs/" + digest(cfg), prefix + "/blobs/" + digest(layer)}
	for _, method := range []string{"GET", "HEAD"} {
		for _, path := range paths {
			plain := request(s.Reader(), method, path, nil)
			namespaced := request(s.Reader(), method, path+"?ns="+url.QueryEscape(testAuthority), nil)
			expect(t, plain, 200)
			expect(t, namespaced, 200)
			if !bytes.Equal(plain.Body.Bytes(), namespaced.Body.Bytes()) || plain.Header().Get("Docker-Content-Digest") != namespaced.Header().Get("Docker-Content-Digest") {
				t.Fatal("namespace changed immutable response")
			}
		}
	}
	q := url.QueryEscape(testAuthority)
	for _, query := range []string{"", "ns", "ns=", "ns=other.namespace.svc%3A8084", "ns=" + q + "&ns=" + q, "ns=" + q + "&", "other=" + q, "NS=" + q, "n%73=" + q, "ns=" + q + "&other=", "ns=" + q + ";other=x", "ns=%zz", "ns=" + q + "%00"} {
		for _, path := range paths {
			for _, method := range []string{"GET", "HEAD"} {
				expect(t, request(s.Reader(), method, path+"?"+query, nil), 400)
			}
		}
	}
	for _, method := range []string{"PUT", "POST", "PATCH", "DELETE"} {
		expect(t, request(s.Reader(), method, prefix+"/manifests/release?ns="+q, manifest), 405)
	}
	expect(t, request(s.Reader(), "GET", "/v2/other/workload/manifests/release?ns="+q, nil), 404)
	legacy, _ := testStore(t, 1<<20)
	expect(t, request(legacy.Reader(), "GET", "/v2/?ns="+q, nil), 400)
	// The write endpoint keeps its original query rules regardless of authority.
	for _, target := range []string{prefix + "/manifests/release?ns=" + q, prefix + "/blobs/uploads/?ns=" + q} {
		for _, method := range []string{"GET", "POST", "PUT"} {
			if request(s.Writer(), method, target, manifest).Code != request(legacy.Writer(), method, target, manifest).Code {
				t.Fatal("reader authority changed writer query semantics")
			}
		}
	}
}

func TestRegistryAuthorityRejectsAliasesPathsAndAlternateTransports(t *testing.T) {
	for _, authority := range []string{"", "http://" + testAuthority, "CONFIDENTIAL-operator-images.namespace.svc:8084", "service.namespace.svc:8085", "service.namespace.svc.", "service.namespace.svc.cluster.local:8084", "service.svc:8084", syntheticLoopbackIP + ":8084", "[" + syntheticPrivateV6One + "]:8084", "service.namespace.svc:8084/path", "service.namespace.svc:8084?ns=x", "-service.namespace.svc:8084", "service..svc:8084", "service.namespace.svc:8084\n", strings.Repeat("a", 64) + ".namespace.svc:8084"} {
		if ValidateRegistryAuthority(authority) == nil {
			t.Fatal("invalid authority accepted", authority)
		}
	}
	if ValidateRegistryAuthority("custom-images.namespace.svc:8084") != nil {
		t.Fatal("canonical reader authority rejected")
	}
	if ConfigureRegistryHosts("custom-images.namespace.svc:8084", syntheticPrivateIP, registryDirectory(t)) == nil {
		t.Fatal("fixed service environment accepted a different Service name")
	}
}

func TestRegistryHostsIsExactReadOnlyAtomicAndIdempotent(t *testing.T) {
	directory := registryDirectory(t)
	for _, ip := range []string{syntheticPrivateIP, syntheticPrivateV6} {
		if err := ConfigureRegistryHosts(testAuthority, ip, directory); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, registryHostsName)
		raw, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(raw, registryHostsBytes(testAuthority, ip)) {
			t.Fatal("not the exact private read/resolve configuration", err)
		}
		before, err := os.Stat(path)
		if err != nil || before.Mode().Perm() != 0644 {
			t.Fatal("wrong hosts permissions", err)
		}
		if err := ConfigureRegistryHosts(testAuthority, ip, directory); err != nil {
			t.Fatal(err)
		}
		after, _ := os.Stat(path)
		if !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
			t.Fatal("idempotent invocation rewrote the file")
		}
		entries, _ := os.ReadDir(directory)
		if len(entries) != 1 || entries[0].Name() != registryHostsName {
			t.Fatal("transaction left another file")
		}
	}
}

func TestRegistryHostsRejectsNonprivateOrAmbiguousIPsBeforeWriting(t *testing.T) {
	for _, ip := range []string{"", "None", "localhost", syntheticLoopbackIP, syntheticLoopbackV6, syntheticUnspecifiedIP, syntheticUnspecifiedV6, syntheticLinkLocalIP, syntheticLinkLocalV6, syntheticMulticastV6, syntheticPublicIP, syntheticPublicV6, strings.TrimSuffix(syntheticPrivateBaseIP, "1") + "01", syntheticPrivateBaseIP + "\n", syntheticPrivateV6One + "%eth0", syntheticMappedV6, syntheticPrivateBaseIP + ":8084", "http://" + syntheticPrivateBaseIP} {
		directory := registryDirectory(t)
		if ConfigureRegistryHosts(testAuthority, ip, directory) == nil {
			t.Fatal("invalid private ClusterIP accepted", ip)
		}
		entries, _ := os.ReadDir(directory)
		if len(entries) != 0 {
			t.Fatal("invalid IP wrote a file")
		}
	}
}

func TestRegistryHostsRefusesForeignFilesAndLinksWithoutChangingThem(t *testing.T) {
	for _, kind := range []string{"unknown-file", "foreign-authority", "changed-capabilities", "symlink", "hardlink", "directory", "mode", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			directory := registryDirectory(t)
			path := filepath.Join(directory, registryHostsName)
			outside := filepath.Join(registryDirectory(t), "unrelated")
			if err := os.WriteFile(outside, []byte("outside must not change"), 0644); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "unknown-file":
				os.WriteFile(filepath.Join(directory, "unrecognized.toml"), []byte("leave intact"), 0644)
			case "foreign-authority":
				os.WriteFile(path, registryHostsBytes("confidential-operator-images.other.svc:8084", syntheticPrivateIP), 0644)
			case "changed-capabilities":
				os.WriteFile(path, bytes.ReplaceAll(registryHostsBytes(testAuthority, syntheticPrivateIP), []byte(`"resolve"`), []byte(`"resolve", "push"`)), 0644)
			case "symlink":
				os.Symlink(outside, path)
			case "hardlink":
				if err := os.Link(outside, path); err != nil {
					t.Fatal(err)
				}
			case "directory":
				os.Mkdir(path, 0755)
			case "mode":
				os.WriteFile(path, registryHostsBytes(testAuthority, syntheticPrivateIP), 0600)
			case "fifo":
				if err := syscall.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			}
			started := time.Now()
			if ConfigureRegistryHosts(testAuthority, syntheticUpdatedPrivateIP, directory) == nil {
				t.Fatal("foreign or unsafe file accepted")
			}
			if time.Since(started) > time.Second {
				t.Fatal("unsafe file blocked the one-shot init")
			}
			raw, _ := os.ReadFile(outside)
			if string(raw) != "outside must not change" {
				t.Fatal("wrote outside authority directory")
			}
		})
	}
	for _, kind := range []string{"final-link", "ancestor-link", "world-writable", "relative", "unclean"} {
		t.Run(kind, func(t *testing.T) {
			base := registryDirectory(t)
			directory := base
			switch kind {
			case "final-link":
				directory = filepath.Join(registryDirectory(t), "link")
				os.Symlink(base, directory)
			case "ancestor-link":
				os.Mkdir(filepath.Join(base, "child"), 0700)
				link := filepath.Join(registryDirectory(t), "link")
				os.Symlink(base, link)
				directory = link + "/child"
			case "world-writable":
				os.Chmod(base, 0777)
			case "relative":
				directory = "relative"
			case "unclean":
				directory = base + "/../other"
			}
			if ConfigureRegistryHosts(testAuthority, syntheticPrivateIP, directory) == nil {
				t.Fatal("unsafe directory accepted")
			}
		})
	}
}

func TestRegistryHostsConcurrentReadersNeverObservePartialUpdates(t *testing.T) {
	directory := registryDirectory(t)
	if err := ConfigureRegistryHosts(testAuthority, syntheticPrivateIP, directory); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, registryHostsName)
	done, failures := make(chan struct{}), make(chan string, 1)
	go func() {
		defer close(done)
		for i := 0; i < 400; i++ {
			raw, err := os.ReadFile(path)
			if err != nil || !(bytes.Equal(raw, registryHostsBytes(testAuthority, syntheticPrivateIP)) || bytes.Equal(raw, registryHostsBytes(testAuthority, syntheticUpdatedPrivateIP))) {
				failures <- "reader saw missing or partial hosts file"
				return
			}
		}
	}()
	var writers sync.WaitGroup
	for _, ip := range []string{syntheticPrivateIP, syntheticUpdatedPrivateIP} {
		writers.Go(func() {
			for i := 0; i < 30; i++ {
				// Competing one-shot invocations may fail closed on the directory
				// lock. A later ordinary retry is always safe and idempotent.
				_ = ConfigureRegistryHosts(testAuthority, ip, directory)
			}
		})
	}
	writers.Wait()
	<-done
	select {
	case failure := <-failures:
		t.Fatal(failure)
	default:
	}
	if err := ConfigureRegistryHosts(testAuthority, syntheticUpdatedPrivateIP, directory); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) != 1 || entries[0].Name() != registryHostsName {
		t.Fatal("failed/concurrent transaction leaked a file")
	}
}
