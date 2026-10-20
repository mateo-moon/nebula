/*
   Copyright The containerd Authors.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

// The CreateContainer/AddDevice flow is derived from containerd NRI's
// device-injector example. Configuration comes exclusively from startup
// arguments and the scope file they name, never workload annotations.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"maps"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/containerd/nri/pkg/api"
	"github.com/containerd/nri/pkg/stub"
)

const runtimeHandler = "kata-qemu-snp"

type deviceAccess uint8

const (
	peerDevices deviceAccess = iota
	storageDevices
)

// The access names a scope file and the grant flags use: attest receives
// /dev/sev-guest, storage also /dev/mapper/control.
var accessNames = map[string]deviceAccess{"attest": peerDevices, "storage": storageDevices}

// compiledScopes is the default scope table, when a build compiles one in.
// Without it a deployment names its scope with --scopes-file or the grant
// flags, which also require --own-namespace.
var compiledScopes map[string]map[string]deviceAccess

var (
	dnsLabel     = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	dnsSubdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
)

func validNamespace(name string) bool { return len(name) <= 63 && dnsLabel.MatchString(name) }

// validBinding accepts exactly pod=container: a Pod name and a container name.
func validBinding(binding string) bool {
	pod, container, ok := strings.Cut(binding, "=")
	return ok && len(pod) <= 253 && dnsSubdomain.MatchString(pod) && len(container) <= 63 && dnsLabel.MatchString(container)
}

type bindings map[string]bool

func (b *bindings) String() string {
	values := make([]string, 0, len(*b))
	for binding := range *b {
		values = append(values, binding)
	}
	sort.Strings(values)
	return strings.Join(values, ",")
}

// Set records a selection; membership in the namespace's scope is checked once
// the scope source is known.
func (b *bindings) Set(value string) error {
	if *b == nil {
		*b = make(bindings)
	}
	if (*b)[value] {
		return fmt.Errorf("duplicate binding %q", value)
	}
	(*b)[value] = true
	return nil
}

// grantFlag declares one recipient and its devices without a scope table.
type grantFlag struct {
	access deviceAccess
	grants *map[string]deviceAccess
}

func (g *grantFlag) String() string {
	if g == nil || g.grants == nil {
		return ""
	}
	values := []string{}
	for binding, access := range *g.grants {
		if access == g.access {
			values = append(values, binding)
		}
	}
	sort.Strings(values)
	return strings.Join(values, ",")
}

func (g *grantFlag) Set(value string) error {
	if !validBinding(value) {
		return fmt.Errorf("invalid device binding %q", value)
	}
	if *g.grants == nil {
		*g.grants = make(map[string]deviceAccess)
	}
	if _, duplicate := (*g.grants)[value]; duplicate {
		return fmt.Errorf("duplicate binding %q", value)
	}
	(*g.grants)[value] = g.access
	return nil
}

type config struct {
	index, socketPath, namespace, runtimeHandler, healthAddress string
	major, minor                                                int64
	bindings                                                    bindings
	// Opt-in generated Pod names: an exact prefix plus Kubernetes' five
	// character suffix and one exact storage container, in this namespace.
	storagePrefixes bindings
	// scope is the namespace's recipients from the scope source: compiled (the
	// default table), file (--scopes-file) or flags (the grant flags).
	scope                                          map[string]deviceAccess
	source, scopesFile, scopesSHA256, ownNamespace string
	grants                                         map[string]deviceAccess
}

const maxScopesFile = 1 << 20

// decodeScopes reads {"version": 1, "scopes": {namespace: {"pod=container":
// "attest"|"storage"}}} strictly: no repeated or unknown key, no empty scope,
// no trailing data.
func decodeScopes(data []byte) (map[string]map[string]deviceAccess, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	versioned, table := false, map[string]map[string]deviceAccess(nil)
	err := decodeObject(d, func(key string) error {
		switch key {
		case "version":
			token, err := d.Token()
			if err != nil {
				return err
			}
			if number, ok := token.(json.Number); !ok || number != "1" {
				return errors.New("version must be 1")
			}
			versioned = true
			return nil
		case "scopes":
			table = map[string]map[string]deviceAccess{}
			return decodeObject(d, func(namespace string) error {
				if !validNamespace(namespace) {
					return fmt.Errorf("invalid namespace %q", namespace)
				}
				scope := map[string]deviceAccess{}
				if err := decodeObject(d, func(binding string) error {
					if !validBinding(binding) {
						return fmt.Errorf("invalid binding %q", binding)
					}
					token, err := d.Token()
					if err != nil {
						return err
					}
					name, _ := token.(string)
					access, known := accessNames[name]
					if !known {
						return fmt.Errorf("binding %q: access must be attest or storage", binding)
					}
					scope[binding] = access
					return nil
				}); err != nil {
					return err
				}
				if len(scope) == 0 {
					return fmt.Errorf("namespace %q has an empty scope", namespace)
				}
				table[namespace] = scope
				return nil
			})
		default:
			return fmt.Errorf("unknown key %q", key)
		}
	})
	if err == nil {
		if _, trailing := d.Token(); trailing != io.EOF {
			err = errors.New("trailing data")
		} else if !versioned || len(table) == 0 {
			err = errors.New("version and a non-empty scopes object are required")
		}
	}
	if err != nil {
		return nil, fmt.Errorf("scope file: %w", err)
	}
	return table, nil
}

// decodeObject reads one JSON object; value consumes each key's value.
func decodeObject(d *json.Decoder, value func(key string) error) error {
	token, err := d.Token()
	if err != nil {
		return err
	}
	if token != json.Delim('{') {
		return errors.New("expected an object")
	}
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return err
		}
		key := token.(string)
		if seen[key] {
			return fmt.Errorf("repeated key %q", key)
		}
		seen[key] = true
		if err := value(key); err != nil {
			return err
		}
	}
	_, err = d.Token()
	return err
}

func mustDecodeScopes(data []byte) map[string]map[string]deviceAccess {
	table, err := decodeScopes(data)
	if err != nil {
		panic(err)
	}
	return table
}

func readScopesFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("--scopes-file must be an absolute clean path")
	}
	// Opened without blocking (a FIFO would block the start), then checked on the
	// descriptor that is read.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("scope file: %w", err)
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("--scopes-file must name a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxScopesFile+1))
	if err != nil {
		return nil, fmt.Errorf("scope file: %w", err)
	}
	if len(data) > maxScopesFile {
		return nil, errors.New("scope file exceeds 1 MiB")
	}
	return data, nil
}

func compiledBinding(binding string) bool {
	for _, scope := range compiledScopes {
		if _, known := scope[binding]; known {
			return true
		}
	}
	return false
}

// scopeTable resolves exactly one scope source: the grant flags, the scope
// file, or the compiled table.
func (c *config) scopeTable(set map[string]bool) (map[string]map[string]deviceAccess, error) {
	switch {
	case len(c.storagePrefixes) != 0:
		if set["scopes-file"] || len(c.grants) != 0 || len(c.bindings) != 0 || !validNamespace(c.namespace) {
			return nil, errors.New("--storage-generated-binding is an independent namespace-scoped source")
		}
		for binding := range c.storagePrefixes {
			prefix, container, ok := strings.Cut(binding, "=")
			if !ok || !strings.HasSuffix(prefix, "-") || len(prefix) > 48 ||
				!dnsLabel.MatchString(strings.TrimSuffix(prefix, "-")) ||
				!strings.HasPrefix(container, "nebula-storage-") || len(container) > 63 || !dnsLabel.MatchString(container) {
				return nil, errors.New("generated binding requires profile-=nebula-storage-name")
			}
		}
		c.source = "generated"
		return map[string]map[string]deviceAccess{c.namespace: {}}, nil
	case set["scopes-file"] && len(c.grants) != 0:
		return nil, errors.New("--scopes-file and the grant flags are alternative scope sources")
	case len(c.grants) != 0:
		if len(c.bindings) != 0 {
			return nil, errors.New("--binding selects from a scope table; the grant flags declare every recipient")
		}
		if !validNamespace(c.namespace) {
			return nil, errors.New("--namespace must be a namespace name")
		}
		c.source, c.bindings = "flags", make(bindings, len(c.grants))
		for binding := range c.grants {
			c.bindings[binding] = true
		}
		return map[string]map[string]deviceAccess{c.namespace: c.grants}, nil
	case set["scopes-file"]:
		data, err := readScopesFile(c.scopesFile)
		if err != nil {
			return nil, err
		}
		table, err := decodeScopes(data)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		c.source, c.scopesSHA256 = "file", hex.EncodeToString(sum[:])
		return table, nil
	case compiledScopes == nil:
		return nil, errors.New("no compiled scope table: use --scopes-file or the grant flags")
	default:
		c.source = "compiled"
		return compiledScopes, nil
	}
}

func parseConfig(args []string, output io.Writer) (config, error) {
	var c config
	f := flag.NewFlagSet("snp-key-injector", flag.ContinueOnError)
	f.SetOutput(output)
	f.StringVar(&c.index, "idx", "", "unused two-digit NRI plugin index (required)")
	f.StringVar(&c.socketPath, "socket-path", api.DefaultSocketPath, "host NRI Unix socket, inside the host NRI directory mounted into this container")
	f.StringVar(&c.namespace, "namespace", "", "exact reviewed namespace (required)")
	f.StringVar(&c.runtimeHandler, "runtime-handler", "", "exact kata-qemu-snp runtime handler (required)")
	f.Int64Var(&c.major, "device-major", -1, "guest /dev/sev-guest major, verified by every guest init (required)")
	f.Int64Var(&c.minor, "device-minor", -1, "guest /dev/sev-guest minor, verified by every guest init (required)")
	f.Var(&c.bindings, "binding", "exact reviewed pod=container recipient; repeat for each selected role")
	f.Var(&c.storagePrefixes, "storage-generated-binding", "profile-=nebula-storage-name for generated Pods in this namespace (requires --own-namespace)")
	f.StringVar(&c.scopesFile, "scopes-file", "", "reviewed scope table replacing the compiled one (absolute path; requires --own-namespace)")
	f.Var(&grantFlag{storageDevices, &c.grants}, "storage-binding", "pod=container granted /dev/sev-guest and /dev/mapper/control, without a scope table (requires --own-namespace)")
	f.Var(&grantFlag{peerDevices, &c.grants}, "attest-binding", "pod=container granted /dev/sev-guest, without a scope table (requires --own-namespace)")
	f.StringVar(&c.ownNamespace, "own-namespace", "", "this Pod's namespace (downward API metadata.namespace); --namespace must equal it")
	f.StringVar(&c.healthAddress, "health-address", ":8080", "HTTP health listener; contains no configuration or NRI API")
	err := f.Parse(args)
	set := map[string]bool{}
	f.Visit(func(given *flag.Flag) { set[given.Name] = true })
	if errors.Is(err, flag.ErrHelp) && compiledScopes != nil && !set["scopes-file"] && len(c.grants) == 0 {
		// A binding the compiled table does not name failed parsing before the
		// other scope sources existed, so -h after it still exits 1.
		for _, binding := range slices.Sorted(maps.Keys(c.bindings)) {
			if !compiledBinding(binding) {
				return c, fmt.Errorf("invalid value %q for flag -binding: unsupported device binding %q", binding, binding)
			}
		}
	}
	if err != nil {
		return c, err
	}
	if f.NArg() != 0 {
		return c, errors.New("unexpected positional arguments")
	}
	if !regexp.MustCompile(`^[0-9]{2}$`).MatchString(c.index) {
		return c, errors.New("an unused two-digit --idx is required")
	}
	table, err := c.scopeTable(set)
	if err != nil {
		return c, err
	}
	scope, allowed := table[c.namespace]
	if !allowed || c.runtimeHandler != runtimeHandler {
		return c, errors.New("only reviewed namespaces and the kata-qemu-snp runtime are supported")
	}
	// The injector serves only the namespace it runs in. With the compiled table
	// the declaration is optional: arguments written for that table omit it.
	if !set["own-namespace"] && c.source != "compiled" {
		return c, errors.New("--own-namespace is required with --scopes-file or the grant flags")
	}
	if set["own-namespace"] && c.ownNamespace != c.namespace {
		return c, errors.New("--namespace must be the injector's own namespace")
	}
	if len(c.bindings) == 0 && len(c.storagePrefixes) == 0 {
		return c, errors.New("at least one explicit --binding is required")
	}
	for binding := range c.bindings {
		if _, allowed := scope[binding]; !allowed {
			return c, errors.New("binding does not belong to the selected namespace")
		}
	}
	c.scope = scope
	if !filepath.IsAbs(c.socketPath) || filepath.Clean(c.socketPath) != c.socketPath {
		return c, errors.New("--socket-path must be an absolute clean path")
	}
	if _, port, err := net.SplitHostPort(c.healthAddress); err != nil || port != "8080" {
		return c, errors.New("--health-address must use port 8080")
	}
	// This storage intentionally supports only the reviewed guest tuple.
	// The measured init must independently fail if its own sysfs tuple differs.
	if c.major != 10 || c.minor != 258 {
		return c, errors.New("this storage requires explicit guest device numbers 10:258")
	}
	return c, nil
}

const (
	nriRegistered uint32 = 1 << iota
	nriSynchronized
	nriDisconnected
)

type plugin struct {
	config    config
	readiness *atomic.Uint32
}

// Configure refuses runtime-supplied configuration: immutable process arguments
// are the only configuration source. Only CreateContainer is subscribed.
func (p *plugin) Configure(_ context.Context, config, _, _ string) (api.EventMask, error) {
	if strings.TrimSpace(config) != "" {
		return 0, errors.New("runtime-supplied plugin configuration is unsupported")
	}
	var events api.EventMask
	events.Set(api.Event_CREATE_CONTAINER)
	return events, nil
}

// NRI Start completes configuration before initial synchronization. Observe the
// explicit callback as well before reporting readiness; never update existing
// containers during synchronization. The stub collects all chunks first.
func (p *plugin) Synchronize(_ context.Context, _ []*api.PodSandbox, _ []*api.Container) ([]*api.ContainerUpdate, error) {
	p.readiness.Or(nriSynchronized)
	log.Print("SCOPED_SNP_SYNCHRONIZED: initial runtime state received; no existing containers adjusted")
	return nil, nil
}

func (p *plugin) CreateContainer(_ context.Context, pod *api.PodSandbox, ctr *api.Container) (*api.ContainerAdjustment, []*api.ContainerUpdate, error) {
	c := p.config
	if pod == nil || ctr == nil || pod.Namespace != c.namespace || pod.RuntimeHandler != c.runtimeHandler {
		return nil, nil, nil
	}
	binding := pod.Name + "=" + ctr.Name
	access, allowed := c.scope[binding]
	allowed = allowed && c.bindings[binding]
	for binding := range c.storagePrefixes {
		prefix, container, _ := strings.Cut(binding, "=")
		if ctr.Name == container && strings.HasPrefix(pod.Name, prefix) &&
			regexp.MustCompile(`^[bcdfghjklmnpqrstvwxz2456789]{5}$`).MatchString(strings.TrimPrefix(pod.Name, prefix)) {
			access, allowed = storageDevices, true
		}
	}
	if !allowed {
		return nil, nil, nil
	}
	// Ignore ALL pod/container annotations, including upstream injector keys.
	// No mounts, cgroups, CDI, sysctls, or other adjustments are requested.
	adjust := &api.ContainerAdjustment{}
	adjust.AddDevice(&api.LinuxDevice{
		Path: "/dev/sev-guest", Type: "c", Major: c.major, Minor: c.minor,
		// NRI accepts os.FileMode or uint32; an untyped integer becomes int
		// at this interface boundary and silently produces an absent mode.
		FileMode: api.FileMode(os.FileMode(0600)),
	})
	if access == storageDevices {
		adjust.AddDevice(&api.LinuxDevice{
			Path: "/dev/mapper/control", Type: "c", Major: 10, Minor: 236,
			FileMode: api.FileMode(os.FileMode(0600)),
		})
	}
	// As in the audited upstream path, omitted UID/GID mean root. This preserves
	// the exact AddDevice shape accepted by the measured Kata policy.
	log.Printf("SCOPED_SNP_INJECT namespace=%s pod=%s pod_uid=%s sandbox_id=%s container=%s runtime=%s device=%d:%d", pod.Namespace, pod.Name, pod.Uid, pod.Id, ctr.Name, pod.RuntimeHandler, c.major, c.minor)
	return adjust, nil, nil
}

// scopeLine records a non-default scope source; the compiled table without
// --own-namespace logs nothing extra.
func scopeLine(c config) string {
	if c.source == "compiled" && c.ownNamespace == "" {
		return ""
	}
	line := "SCOPED_SNP_SCOPE source=" + c.source
	if c.source == "file" {
		line += " path=" + c.scopesFile + " sha256=" + c.scopesSHA256
	}
	return line + " own_namespace=" + c.ownNamespace
}

func healthHandler(readiness *atomic.Uint32) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if readiness.Load() != nriRegistered|nriSynchronized {
			http.Error(w, "NRI is not registered", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready\n")
	})
	return mux
}

func run(ctx context.Context, c config) error {
	var readiness atomic.Uint32
	listener, err := net.Listen("tcp", c.healthAddress)
	if err != nil {
		return fmt.Errorf("health listener: %w", err)
	}
	server := &http.Server{Handler: healthHandler(&readiness), ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	defer server.Close()
	healthErrors := make(chan error, 1)
	go func() { healthErrors <- server.Serve(listener) }()
	s, err := stub.New(&plugin{config: c, readiness: &readiness}, stub.WithPluginName("snp-key-injector"), stub.WithPluginIdx(c.index), stub.WithSocketPath(c.socketPath), stub.WithOnClose(func() { readiness.Or(nriDisconnected) }))
	if err != nil {
		return err
	}
	if line := scopeLine(c); line != "" {
		log.Print(line)
	}
	log.Printf("SCOPED_SNP_START namespace=%s bindings=%s runtime=%s device=%d:%d", c.namespace, &c.bindings, c.runtimeHandler, c.major, c.minor)
	if err := s.Start(ctx); err != nil {
		return err
	}
	readiness.Or(nriRegistered)
	log.Print("SCOPED_SNP_REGISTERED: readiness additionally requires initial runtime synchronization")
	done := make(chan struct{})
	go func() { s.Wait(); close(done) }()
	defer func() {
		readiness.Or(nriDisconnected)
		s.Stop()
		<-done
	}()
	select {
	case <-ctx.Done():
		return nil
	case <-done:
		return errors.New("NRI connection closed; restarting injector is required")
	case err := <-healthErrors:
		return fmt.Errorf("health server stopped: %w", err)
	}
}

func main() {
	c, err := parseConfig(os.Args[1:], os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, c); err != nil {
		log.Fatal(err)
	}
	log.Print("SCOPED_SNP_STOP: NRI connection closed")
}
