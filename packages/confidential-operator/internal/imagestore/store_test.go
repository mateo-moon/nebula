package imagestore

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const repository = "test-namespace/test-workload"
const prefix = "/v2/" + repository

func testStore(t *testing.T, maximum int64) (*Store, Config) {
	t.Helper()
	config := Config{Directory: t.TempDir(), Repository: repository, MaxBytes: maximum}
	s, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, config
}
func request(h http.Handler, method, path string, raw []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(raw))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body.String())
	}
}
func uploadBlob(t *testing.T, s *Store, raw []byte) string {
	t.Helper()
	h := s.Writer()
	w := request(h, "POST", prefix+"/blobs/uploads/", nil)
	expect(t, w, 202)
	location := w.Header().Get("Location")
	mid := len(raw) / 2
	expect(t, request(h, "PATCH", location, raw[:mid]), 202)
	w = request(h, "PUT", location+"?digest="+url.QueryEscape(digest(raw)), raw[mid:])
	expect(t, w, 201)
	if w.Header().Get("Docker-Content-Digest") != digest(raw) {
		t.Fatal("wrong committed digest")
	}
	return digest(raw)
}
func fixture() ([]byte, []byte, []byte) {
	// Opaque synthetic ciphertext and standard OCIcrypt metadata. This fixture
	// exercises registry transport, not decryption or application execution.
	layer := bytes.Repeat([]byte{0x87, 0x00, 0x41, 0xfa}, 4096)
	config := []byte(`{"architecture":"amd64","os":"linux","config":{"Cmd":["/bin/true"]},"rootfs":{"type":"layers","diff_ids":["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]},"history":[{}]}`)
	annotation := base64.StdEncoding.EncodeToString([]byte(`{"kid":"kbs:///default/image/test","wrap_type":"A256GCM","iv":"AAAAAAAAAAAAAAAA","wrapped_data":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`))
	pubopts := base64.StdEncoding.EncodeToString([]byte(`{"cipher":"AES_256_CTR_HMAC_SHA256","cipheroptions":{},"hmac":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`))
	raw, _ := json.Marshal(manifest{SchemaVersion: 2, MediaType: manifestType, Config: descriptor{MediaType: configType, Digest: digest(config), Size: int64(len(config))}, Layers: []descriptor{{MediaType: "application/vnd.oci.image.layer.v1.tar+encrypted", Digest: digest(layer), Size: int64(len(layer)), Annotations: map[string]string{keyAnnotation: annotation, "org.opencontainers.image.enc.pubopts": pubopts}}}})
	return config, layer, raw
}
func populate(t *testing.T, s *Store) ([]byte, []byte, []byte) {
	t.Helper()
	config, layer, raw := fixture()
	uploadBlob(t, s, config)
	uploadBlob(t, s, layer)
	expect(t, request(s.Writer(), "PUT", prefix+"/manifests/release", raw), 201)
	return config, layer, raw
}

func TestConfigurationIsOptInAndBounded(t *testing.T) {
	get := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	if config, err := ConfigFromEnv(get(nil)); err != nil || config != nil {
		t.Fatal("legacy configuration activated image store")
	}
	for _, values := range []map[string]string{{"IMAGE_STORE_DIRECTORY": "/var/lib/images"}, {"IMAGE_STORE_REPOSITORY": repository}, {"IMAGE_STORE_MAX_BYTES": "8589934592"}, {"IMAGE_STORE_DIRECTORY": "/x", "IMAGE_STORE_REPOSITORY": "namespace/../other"}, {"IMAGE_STORE_DIRECTORY": "/x", "IMAGE_STORE_REPOSITORY": repository, "IMAGE_STORE_MAX_BYTES": "68719476737"}, {"IMAGE_STORE_DIRECTORY": "relative", "IMAGE_STORE_REPOSITORY": repository}} {
		if _, err := ConfigFromEnv(get(values)); err == nil {
			t.Fatal("invalid configuration accepted", values)
		}
	}
	config, err := ConfigFromEnv(get(map[string]string{"IMAGE_STORE_DIRECTORY": "/var/lib/nebula-images", "IMAGE_STORE_REPOSITORY": repository}))
	if err != nil || config.MaxBytes != 8<<30 {
		t.Fatal(config, err)
	}
}

func TestObjectAndUploadSessionCountsAreBounded(t *testing.T) {
	s, _ := testStore(t, 1<<20)
	locations := make([]string, 0, maxUploads)
	for i := 0; i < maxUploads; i++ {
		w := request(s.Writer(), "POST", prefix+"/blobs/uploads/", nil)
		expect(t, w, 202)
		locations = append(locations, w.Header().Get("Location"))
	}
	expect(t, request(s.Writer(), "POST", prefix+"/blobs/uploads/", nil), 413)
	for _, location := range locations {
		expect(t, request(s.Writer(), "DELETE", location, nil), 204)
	}
	if s.objects != 1 || s.used != 0 {
		t.Fatal("cancelled sessions retained object capacity")
	}
	config := Config{Directory: t.TempDir(), Repository: repository, MaxBytes: 1 << 20}
	if err := os.Mkdir(filepath.Join(config.Directory, "v1"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxObjects+1; i++ {
		if err := os.WriteFile(filepath.Join(config.Directory, "v1", fmt.Sprintf("blob-%064x", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if excessive, err := New(config); err == nil {
		excessive.Close()
		t.Fatal("unbounded durable object listing accepted")
	}
}

func TestPublicationIsCompleteImmutableAndRestartable(t *testing.T) {
	s, cfg := testStore(t, 1<<20)
	config, layer, raw := fixture()
	h := s.Writer()
	expect(t, request(h, "PUT", prefix+"/manifests/release", raw), 400)
	expect(t, request(s.Reader(), "GET", prefix+"/manifests/release", nil), 404)
	uploadBlob(t, s, config)
	expect(t, request(h, "PUT", prefix+"/manifests/release", raw), 400)
	uploadBlob(t, s, layer)
	expect(t, request(h, "PUT", prefix+"/manifests/release", raw), 201)
	used := s.used
	expect(t, request(h, "PUT", prefix+"/manifests/release", raw), 201)
	if s.used != used {
		t.Fatal("idempotent retry consumes quota")
	}
	changed := bytes.Replace(raw, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":2,"annotations":{"test":"different"}`), 1)
	expect(t, request(h, "PUT", prefix+"/manifests/release", changed), 409)
	expect(t, request(h, "PUT", prefix+"/manifests/sha256:"+strings.Repeat("b", 64), raw), 400)
	partial := request(h, "POST", prefix+"/blobs/uploads/", nil).Header().Get("Location")
	expect(t, request(h, "PATCH", partial, []byte("incomplete")), 202)
	s.Close()
	again, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if again.used != used {
		t.Fatal("restart retained abandoned-upload capacity")
	}
	w := request(again.Reader(), "GET", prefix+"/manifests/release", nil)
	expect(t, w, 200)
	if !bytes.Equal(w.Body.Bytes(), raw) || w.Header().Get("Docker-Content-Digest") != digest(raw) {
		t.Fatal("committed release changed after restart")
	}
	expect(t, request(again.Writer(), "GET", partial, nil), 404)
	w = request(again.Reader(), "HEAD", prefix+"/blobs/"+digest(layer), nil)
	expect(t, w, 200)
	if w.Body.Len() != 0 || w.Header().Get("Content-Length") != "16384" {
		t.Fatal("incorrect HEAD response")
	}
	r := httptest.NewRequest("GET", prefix+"/blobs/"+digest(layer), nil)
	r.Header.Set("Range", "bytes=11-100")
	w = httptest.NewRecorder()
	again.Reader().ServeHTTP(w, r)
	expect(t, w, 206)
	if !bytes.Equal(w.Body.Bytes(), layer[11:101]) {
		t.Fatal("range bytes differ")
	}
}

func TestDigestFailuresNeverCommitAndQuotaIsRecovered(t *testing.T) {
	s, _ := testStore(t, 1<<20)
	h := s.Writer()
	w := request(h, "POST", prefix+"/blobs/uploads/", nil)
	location := w.Header().Get("Location")
	expect(t, request(h, "PATCH", location, bytes.Repeat([]byte("a"), 600000)), 202)
	expect(t, request(h, "PUT", location+"?digest=sha256:"+strings.Repeat("0", 64), nil), 400)
	if s.used != 0 {
		t.Fatal("wrong-digest upload retained quota")
	}
	expect(t, request(s.Reader(), "GET", prefix+"/blobs/sha256:"+strings.Repeat("0", 64), nil), 404)
	w = request(h, "POST", prefix+"/blobs/uploads/", nil)
	location = w.Header().Get("Location")
	expect(t, request(h, "PATCH", location, bytes.Repeat([]byte("a"), 1100000)), 413)
	if s.used != 0 {
		t.Fatal("oversize upload retained quota")
	}
	expect(t, request(h, "GET", location, nil), 404)
	uploadBlob(t, s, []byte("a subsequent valid upload succeeds"))
}

func TestReaderCannotWriteOrCrossRepositoryAndPathsCannotEscape(t *testing.T) {
	s, _ := testStore(t, 1<<20)
	_, _, raw := populate(t, s)
	for _, method := range []string{"POST", "PATCH", "PUT", "DELETE"} {
		expect(t, request(s.Reader(), method, prefix+"/manifests/release", raw), 405)
	}
	for _, path := range []string{"/v2/other/workload/manifests/release", "/v2/test-namespace/other/manifests/release"} {
		expect(t, request(s.Reader(), "GET", path, nil), 404)
		expect(t, request(s.Writer(), "PUT", path, raw), 404)
	}
	for _, path := range []string{prefix + "/blobs/../../lock", prefix + "/blobs/%2e%2e%2flock", prefix + "/blobs/sha256%3a" + strings.Repeat("0", 64)} {
		expect(t, request(s.Reader(), "GET", path, nil), 400)
	}
	expect(t, request(s.Writer(), "POST", prefix+"/blobs/uploads/?from=other%2Frepository&mount=sha256:"+strings.Repeat("0", 64), nil), 403)
	expect(t, request(s.Writer(), "PUT", prefix+"/manifests/another-tag", raw), 400)
}

func TestSymlinksAndConcurrentWritersAreRefused(t *testing.T) {
	s, cfg := testStore(t, 1<<20)
	if extra, err := New(cfg); err == nil {
		extra.Close()
		t.Fatal("second writer acquired store")
	}
	outside := filepath.Join(t.TempDir(), "private")
	if err := os.WriteFile(outside, []byte("not an image"), 0600); err != nil {
		t.Fatal(err)
	}
	value := digest([]byte("not an image"))
	if err := os.Symlink(outside, filepath.Join(cfg.Directory, "v1", blobName(value))); err != nil {
		t.Fatal(err)
	}
	w := request(s.Reader(), "GET", prefix+"/blobs/"+value, nil)
	expect(t, w, 404)
	if bytes.Contains(w.Body.Bytes(), []byte("not an image")) {
		t.Fatal("symlink target was exposed")
	}
	s.Close()
	if bad, err := New(cfg); err == nil {
		bad.Close()
		t.Fatal("store with injected symlink reopened")
	}
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "store")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if bad, err := New(Config{Directory: link, Repository: repository, MaxBytes: 1 << 20}); err == nil {
		bad.Close()
		t.Fatal("symlink store root accepted")
	}
}

func TestInjectedFifoCannotBlockAReader(t *testing.T) {
	s, cfg := testStore(t, 1<<20)
	value := "sha256:" + strings.Repeat("c", 64)
	if err := syscall.Mkfifo(filepath.Join(cfg.Directory, "v1", blobName(value)), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- request(s.Reader(), "GET", prefix+"/blobs/"+value, nil) }()
	select {
	case result := <-done:
		expect(t, result, 404)
	case <-time.After(time.Second):
		t.Fatal("non-regular file blocked image reader")
	}
}

func TestUnknownLengthHugeStreamIsStoppedWithoutBufferingOrRetainingQuota(t *testing.T) {
	s, _ := testStore(t, 1<<20)
	h := s.Writer()
	begin := request(h, "POST", prefix+"/blobs/uploads/", nil)
	source := &generatedReader{remaining: 1 << 40}
	r := httptest.NewRequest("PATCH", begin.Header().Get("Location"), nil)
	r.Body = io.NopCloser(source)
	r.ContentLength = -1
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	expect(t, w, 413)
	if source.read > 1<<20+64*1024 || source.maximum > 64*1024 || s.used != 0 {
		t.Fatal("stream exceeded bounded quota/copy buffer", source.read, source.maximum, s.used)
	}
}

type generatedReader struct {
	remaining, read int64
	maximum         int
}

func (r *generatedReader) Read(p []byte) (int, error) {
	if len(p) > r.maximum {
		r.maximum = len(p)
	}
	if r.remaining == 0 {
		return 0, io.EOF
	}
	n := int64(len(p))
	if n > r.remaining {
		n = r.remaining
	}
	clear(p[:n])
	r.remaining -= n
	r.read += n
	return int(n), nil
}

func TestChangedBlobAndPlaintextManifestDoNotBecomeRelease(t *testing.T) {
	s, cfg := testStore(t, 1<<20)
	config, layer, raw := fixture()
	uploadBlob(t, s, config)
	uploadBlob(t, s, layer)
	if err := os.WriteFile(filepath.Join(cfg.Directory, "v1", blobName(digest(layer))), bytes.Repeat([]byte{0}, len(layer)), 0600); err != nil {
		t.Fatal(err)
	}
	expect(t, request(s.Writer(), "PUT", prefix+"/manifests/release", raw), 400)
	expect(t, request(s.Reader(), "GET", prefix+"/manifests/release", nil), 404)
	plain := bytes.Replace(raw, []byte(".tar+encrypted"), []byte(".tar"), 1)
	expect(t, request(s.Writer(), "PUT", prefix+"/manifests/release", plain), 400)
}

func TestConcurrentUploadsCannotOvercommitAndExpiredUploadsReleaseCapacity(t *testing.T) {
	s, _ := testStore(t, 1<<20)
	h := s.Writer()
	locations := []string{request(h, "POST", prefix+"/blobs/uploads/", nil).Header().Get("Location"), request(h, "POST", prefix+"/blobs/uploads/", nil).Header().Get("Location")}
	var group sync.WaitGroup
	codes := make(chan int, 2)
	for _, location := range locations {
		group.Add(1)
		go func(path string) {
			defer group.Done()
			codes <- request(h, "PATCH", path, bytes.Repeat([]byte{2}, 700000)).Code
		}(location)
	}
	group.Wait()
	close(codes)
	for code := range codes {
		if code != 202 && code != 413 {
			t.Fatal("unexpected quota response", code)
		}
	}
	if s.used > s.config.MaxBytes {
		t.Fatal("concurrent quota overcommit")
	}
	for _, u := range s.uploads {
		u.mu.Lock()
		u.touched = time.Now().Add(-2 * time.Hour)
		u.mu.Unlock()
	}
	s.expireUploads()
	if s.used != 0 || len(s.uploads) != 0 {
		t.Fatal("expired uploads retained capacity")
	}
}

func TestSkopeoPushInspectAndPull(t *testing.T) {
	tool := os.Getenv("CONFIDENTIAL_IMAGE_STORE_SKOPEO")
	if tool == "" {
		t.Skip("set CONFIDENTIAL_IMAGE_STORE_SKOPEO to run the real Skopeo protocol fixture")
	}
	s, _ := testStore(t, 4<<20)
	writer := httptest.NewServer(s.Writer())
	defer writer.Close()
	reader := httptest.NewServer(s.Reader())
	defer reader.Close()
	authority := func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if host := os.Getenv("CONFIDENTIAL_IMAGE_STORE_TEST_HOST"); host != "" {
			return host + ":" + u.Port()
		}
		return u.Host
	}
	source, output := t.TempDir(), t.TempDir()
	_ = os.Chmod(source, 0755)
	_ = os.Chmod(output, 0777)
	config, layer, raw := fixture()
	for name, data := range map[string][]byte{"manifest.json": raw, strings.TrimPrefix(digest(config), "sha256:"): config, strings.TrimPrefix(digest(layer), "sha256:"): layer} {
		if err := os.WriteFile(filepath.Join(source, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	auth := filepath.Join(source, "fixture-auth.json")
	if err := os.WriteFile(auth, []byte(`{"auths":{}}`), 0644); err != nil {
		t.Fatal(err)
	}
	registries := filepath.Join(source, "fixture-registries.conf")
	configuration := "unqualified-search-registries = []\n"
	for _, address := range []string{authority(writer.URL), authority(reader.URL)} {
		exact := address + "/" + repository
		configuration += "[[registry]]\nprefix = \"" + exact + "\"\nlocation = \"" + exact + "\"\ninsecure = true\n"
	}
	if err := os.WriteFile(registries, []byte(configuration), 0644); err != nil {
		t.Fatal(err)
	}
	invoke := func(args ...string) []byte {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, tool, append([]string{"--registries-conf", registries}, args...)...)
		cmd.WaitDelay = 2 * time.Second
		cmd.Env = append(os.Environ(), "REGISTRY_AUTH_FILE="+auth)
		value, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("Skopeo fixture failed: %v: %s", err, value)
		}
		return value
	}
	dest := authority(writer.URL) + "/" + repository + ":release"
	invoke("--insecure-policy", "copy", "--preserve-digests", "dir:"+source, "docker://"+dest)
	inspect := invoke("inspect", "--raw", "docker://"+authority(reader.URL)+"/"+repository+":release")
	if !bytes.Equal(bytes.TrimSpace(inspect), raw) {
		t.Fatal("Skopeo manifest inspection changed bytes")
	}
	invoke("--insecure-policy", "copy", "--preserve-digests", "docker://"+authority(reader.URL)+"/"+repository+"@"+digest(raw), "dir:"+output)
	for name, expected := range map[string][]byte{"manifest.json": raw, strings.TrimPrefix(digest(config), "sha256:"): config, strings.TrimPrefix(digest(layer), "sha256:"): layer} {
		actual, err := os.ReadFile(filepath.Join(output, name))
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatal("Skopeo roundtrip changed ciphertext or metadata", name, err)
		}
	}
	// The same HTTP server must still be contacted with HTTPS for a repository
	// outside the two exact configured prefixes. No global TLS bypass is used.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool, "--registries-conf", registries, "inspect", "--raw", "docker://"+authority(reader.URL)+"/other/workload:release")
	cmd.Env = append(os.Environ(), "REGISTRY_AUTH_FILE="+auth)
	response, err := cmd.CombinedOutput()
	if err == nil || !bytes.Contains(response, []byte("HTTPS client")) {
		t.Fatalf("registry configuration applied outside exact repository: %v: %s", err, response)
	}
}

func TestBrokenRequestBodyDoesNotLeakQuota(t *testing.T) {
	s, _ := testStore(t, 1<<20)
	h := s.Writer()
	w := request(h, "POST", prefix+"/blobs/uploads/", nil)
	r := httptest.NewRequest("PATCH", w.Header().Get("Location"), nil)
	r.Body = io.NopCloser(&brokenReader{})
	out := httptest.NewRecorder()
	h.ServeHTTP(out, r)
	expect(t, out, 413)
	if s.used != 0 {
		t.Fatal("interrupted request retained quota")
	}
}

type brokenReader struct{ sent bool }

func (r *brokenReader) Read(buffer []byte) (int, error) {
	if !r.sent {
		r.sent = true
		return copy(buffer, []byte("partial ciphertext")), nil
	}
	return 0, io.ErrUnexpectedEOF
}
