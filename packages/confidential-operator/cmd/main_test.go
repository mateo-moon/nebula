package main

import (
	"encoding/json"
	"flag"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegistryHostsModeDoesNotStartKubernetesOrTheStore(t *testing.T) {
	if os.Getenv("NEBULA_OPERATOR_INIT_TEST_CHILD") == "1" {
		var args []string
		if err := json.Unmarshal([]byte(os.Getenv("NEBULA_OPERATOR_INIT_TEST_ARGS")), &args); err != nil {
			panic(err)
		}
		os.Args = append([]string{"operator"}, args...)
		flag.CommandLine = flag.NewFlagSet("operator", flag.ExitOnError)
		main()
		return
	}
	// Reproducible synthetic RFC address-class fixtures, never contacted and
	// never read from a live deployment.
	privateIP := netip.AddrFrom4([4]byte{10, 96, 1, 2}).String()
	publicIP := netip.AddrFrom4([4]byte{8, 8, 8, 8}).String()
	for _, test := range []struct {
		name, ip, expectedError string
		configure               bool
	}{
		{name: "one-shot", ip: privateIP, configure: true},
		{name: "public-ip", ip: publicIP, configure: true, expectedError: "cannot configure image store registry hosts"},
		{name: "directory-without-mode", ip: privateIP, expectedError: "registry hosts directory is only valid in one-shot configuration mode"},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			args := []string{"--image-store-authority=confidential-operator-images.namespace.svc:8084", "--image-store-hosts-directory=" + directory}
			if test.configure {
				args = append(args, "--configure-image-store-registry-hosts")
			}
			raw, _ := json.Marshal(args)
			command := exec.Command(os.Args[0], "-test.run=^TestRegistryHostsModeDoesNotStartKubernetesOrTheStore$")
			command.Env = append(os.Environ(), "NEBULA_OPERATOR_INIT_TEST_CHILD=1", "NEBULA_OPERATOR_INIT_TEST_ARGS="+string(raw), "CONFIDENTIAL_OPERATOR_IMAGES_SERVICE_HOST="+test.ip,
				"WATCH_NAMESPACES=", "POD_NAMESPACE=", "KUBECONFIG="+filepath.Join(directory, "does-not-exist"), "IMAGE_STORE_DIRECTORY=/not-an-existing-store")
			output, err := command.CombinedOutput()
			if test.expectedError == "" {
				if err != nil {
					t.Fatalf("one-shot required manager or store configuration: %v: %s", err, output)
				}
				hosts, err := os.ReadFile(filepath.Join(directory, "hosts.toml"))
				if err != nil || !strings.Contains(string(hosts), `server = "http://`+privateIP+`:8084"`) {
					t.Fatal("one-shot did not write scoped configuration", err)
				}
			} else {
				if err == nil || !strings.Contains(string(output), test.expectedError) {
					t.Fatalf("wrong fail-closed branch: %v: %s", err, output)
				}
				entries, _ := os.ReadDir(directory)
				if len(entries) != 0 {
					t.Fatal("rejected mode wrote a file")
				}
			}
		})
	}
}
