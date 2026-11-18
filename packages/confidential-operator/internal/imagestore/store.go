// Package imagestore is an optional, untrusted ciphertext transport. Neither
// registry contents nor a successful publication authorize a key release.
package imagestore

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	ReadAddress            = ":8084"
	WriteAddress           = ":8085"
	DefaultMaxBytes  int64 = 8 << 30
	maxManifestBytes int64 = 4 << 20
	maxUploads             = 32
	maxObjects             = 1024
	uploadLifetime         = time.Hour
	manifestType           = "application/vnd.oci.image.manifest.v1+json"
	configType             = "application/vnd.oci.image.config.v1+json"
	keyAnnotation          = "org.opencontainers.image.enc.keys.provider.attestation-agent"
)

var (
	repositoryRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	digestRE     = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	uploadRE     = regexp.MustCompile(`^[a-f0-9]{32}$`)
	rangeRE      = regexp.MustCompile(`^([0-9]+)-([0-9]+)$`)
	errQuota     = errors.New("ciphertext store capacity exceeded")
)

type Config struct {
	Directory, Repository string
	MaxBytes              int64
}

// ConfigFromEnv leaves existing installations completely disabled. Partial or
// invalid configuration never starts a listener with a guessed scope.
func ConfigFromEnv(get func(string) string) (*Config, error) {
	directory, repository, maximum := get("IMAGE_STORE_DIRECTORY"), get("IMAGE_STORE_REPOSITORY"), get("IMAGE_STORE_MAX_BYTES")
	if directory == "" && repository == "" && maximum == "" {
		return nil, nil
	}
	config := Config{Directory: directory, Repository: repository, MaxBytes: DefaultMaxBytes}
	if maximum != "" {
		if !regexp.MustCompile(`^[0-9]{1,12}$`).MatchString(maximum) {
			return nil, errors.New("invalid image store byte limit")
		}
		value, err := strconv.ParseInt(maximum, 10, 64)
		if err != nil {
			return nil, errors.New("invalid image store byte limit")
		}
		config.MaxBytes = value
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	return &config, nil
}

func (c Config) validate() error {
	if c.Directory == "" || !filepath.IsAbs(c.Directory) || filepath.Clean(c.Directory) != c.Directory || c.Directory == "/" || len(c.Directory) > 1024 || !repositoryRE.MatchString(c.Repository) || c.MaxBytes < 1<<20 || c.MaxBytes > 64<<30 {
		return errors.New("image store needs an absolute directory, exact namespace/workload repository and bounded byte limit")
	}
	return nil
}

type upload struct {
	mu      sync.Mutex
	name    string
	size    int64
	touched time.Time
	done    bool
}

type Store struct {
	config    Config
	root      *os.Root
	lock      *os.File
	mu        sync.Mutex
	commit    sync.Mutex
	used      int64
	objects   int
	uploads   map[string]*upload
	closeOnce sync.Once
}

// New opens a single-writer store on the ordinary operator PVC. A root-relative
// descriptor and O_NOFOLLOW protect file access even if untrusted storage is
// populated with links. User URL strings are never used as filesystem paths.
func New(config Config) (*Store, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(config.Directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("image store directory must be an existing real directory")
	}
	base, err := os.OpenRoot(config.Directory)
	if err != nil {
		return nil, errors.New("cannot open image store directory")
	}
	defer base.Close()
	if err := base.Mkdir("v1", 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, errors.New("cannot initialize image store directory")
	}
	info, err = base.Lstat("v1")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("invalid image store directory")
	}
	root, err := base.OpenRoot("v1")
	if err != nil {
		return nil, errors.New("cannot open image store data")
	}
	s := &Store{config: config, root: root, uploads: map[string]*upload{}}
	fail := func() (*Store, error) {
		s.Close()
		return nil, errors.New("image store data or exclusive lock is unavailable")
	}
	s.lock, err = s.open("lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return fail()
	}
	if syscall.Flock(int(s.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return fail()
	}
	dir, err := root.Open(".")
	if err != nil {
		return fail()
	}
	entries, err := dir.ReadDir(maxObjects + maxUploads + 1)
	dir.Close()
	if (err != nil && err != io.EOF) || len(entries) > maxObjects+maxUploads {
		return fail()
	}
	for _, entry := range entries {
		name := entry.Name()
		info, err := root.Lstat(name)
		if err != nil || !info.Mode().IsRegular() {
			return fail()
		}
		if strings.HasPrefix(name, "upload-") || strings.HasPrefix(name, "pending-") {
			if err := root.Remove(name); err != nil {
				return fail()
			}
			continue
		}
		if name != "lock" && name != "release" && !(strings.HasPrefix(name, "blob-") && digestRE.MatchString("sha256:"+strings.TrimPrefix(name, "blob-"))) && !(strings.HasPrefix(name, "manifest-") && digestRE.MatchString("sha256:"+strings.TrimPrefix(name, "manifest-"))) {
			return fail()
		}
		s.used += info.Size()
		s.objects++
		if s.used > config.MaxBytes || s.objects > maxObjects {
			return fail()
		}
	}
	return s, nil
}

func (s *Store) open(name string, flags int, mode os.FileMode) (*os.File, error) {
	if info, err := s.root.Lstat(name); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("image store file is not regular")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// NONBLOCK also prevents an injected FIFO from blocking between Lstat and
	// open. Regular files ignore the flag; the descriptor is checked again.
	f, err := s.root.OpenFile(name, flags|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, mode)
	if err != nil {
		return nil, err
	}
	i, err := f.Stat()
	if err != nil || !i.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("image store file is not regular")
	}
	return f, nil
}
func (s *Store) reserve(size int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if size < 0 || size > s.config.MaxBytes-s.used {
		return errQuota
	}
	s.used += size
	return nil
}
func (s *Store) release(size int64) { s.mu.Lock(); defer s.mu.Unlock(); s.used -= size }
func (s *Store) reserveObject() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.objects >= maxObjects {
		return errQuota
	}
	s.objects++
	return nil
}
func (s *Store) releaseObject() { s.mu.Lock(); defer s.mu.Unlock(); s.objects-- }
func identifier() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
func digest(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}
func blobName(value string) string     { return "blob-" + strings.TrimPrefix(value, "sha256:") }
func manifestName(value string) string { return "manifest-" + strings.TrimPrefix(value, "sha256:") }

func (s *Store) Close() error {
	var result error
	s.closeOnce.Do(func() {
		if s.lock != nil {
			_ = syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN)
			_ = s.lock.Close()
		}
		if s.root != nil {
			result = s.root.Close()
		}
	})
	return result
}

func (s *Store) Reader() http.Handler { return s.handler(false) }
func (s *Store) Writer() http.Handler { return s.handler(true) }

func registryError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if r.Method != "HEAD" {
		_ = json.NewEncoder(w).Encode(map[string]any{"errors": []map[string]string{{"code": code, "message": message}}})
	}
}
func (s *Store) handler(write bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.EscapedPath() != r.URL.Path || strings.ContainsAny(r.URL.Path, "\\\x00") || strings.Contains(r.URL.Path, "..") {
			registryError(w, r, 400, "NAME_INVALID", "invalid registry path")
			return
		}
		if !write && r.Method != "GET" && r.Method != "HEAD" {
			registryError(w, r, 405, "DENIED", "read-only image endpoint")
			return
		}
		if r.URL.Path == "/v2/" || r.URL.Path == "/v2" {
			if r.Method != "GET" && r.Method != "HEAD" {
				registryError(w, r, 405, "DENIED", "unsupported registry operation")
				return
			}
			w.WriteHeader(200)
			return
		}
		prefix := "/v2/" + s.config.Repository + "/"
		if !strings.HasPrefix(r.URL.Path, prefix) {
			registryError(w, r, 404, "NAME_UNKNOWN", "unknown image repository")
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, prefix)
		if strings.HasPrefix(rest, "blobs/uploads/") && write {
			s.uploadRequest(w, r, strings.TrimPrefix(rest, "blobs/uploads/"))
			return
		}
		if r.Method == "GET" || r.Method == "HEAD" {
			if r.URL.RawQuery != "" {
				registryError(w, r, 400, "DENIED", "unexpected registry query")
				return
			}
			if strings.HasPrefix(rest, "blobs/") {
				s.readBlob(w, r, strings.TrimPrefix(rest, "blobs/"))
				return
			}
			if strings.HasPrefix(rest, "manifests/") {
				s.readManifest(w, r, strings.TrimPrefix(rest, "manifests/"))
				return
			}
		}
		if write && r.Method == "PUT" && strings.HasPrefix(rest, "manifests/") && r.URL.RawQuery == "" {
			s.putManifest(w, r, strings.TrimPrefix(rest, "manifests/"))
			return
		}
		registryError(w, r, 405, "DENIED", "unsupported registry operation")
	})
}

func (s *Store) readBlob(w http.ResponseWriter, r *http.Request, value string) {
	if !digestRE.MatchString(value) {
		registryError(w, r, 404, "BLOB_UNKNOWN", "unknown blob")
		return
	}
	f, err := s.open(blobName(value), os.O_RDONLY, 0)
	if err != nil {
		registryError(w, r, 404, "BLOB_UNKNOWN", "unknown blob")
		return
	}
	defer f.Close()
	i, err := f.Stat()
	if err != nil || i.Size() > s.config.MaxBytes {
		registryError(w, r, 404, "BLOB_UNKNOWN", "unknown blob")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Docker-Content-Digest", value)
	w.Header().Set("ETag", `"`+value+`"`)
	http.ServeContent(w, r, "", time.Time{}, f)
}
func (s *Store) small(name string, maximum int64) ([]byte, error) {
	f, err := s.open(name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maximum+1))
	if err != nil || int64(len(raw)) > maximum {
		return nil, errors.New("image metadata exceeds limit")
	}
	return raw, nil
}
func (s *Store) readManifest(w http.ResponseWriter, r *http.Request, value string) {
	if value == "release" {
		raw, err := s.small("release", 71)
		if err != nil {
			registryError(w, r, 404, "MANIFEST_UNKNOWN", "manifest unknown")
			return
		}
		value = string(raw)
	}
	if !digestRE.MatchString(value) {
		registryError(w, r, 404, "MANIFEST_UNKNOWN", "manifest unknown")
		return
	}
	raw, err := s.small(manifestName(value), maxManifestBytes)
	if err != nil || digest(raw) != value {
		registryError(w, r, 404, "MANIFEST_UNKNOWN", "manifest unknown")
		return
	}
	if _, err := parseManifest(raw); err != nil {
		registryError(w, r, 404, "MANIFEST_UNKNOWN", "manifest unknown")
		return
	}
	w.Header().Set("Content-Type", manifestType)
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.Header().Set("Docker-Content-Digest", value)
	w.Header().Set("ETag", `"`+value+`"`)
	w.WriteHeader(200)
	if r.Method != "HEAD" {
		_, _ = w.Write(raw)
	}
}

func (s *Store) newUpload() (string, *upload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.uploads) >= maxUploads || s.objects >= maxObjects {
		return "", nil, errQuota
	}
	id, err := identifier()
	if err != nil {
		return "", nil, err
	}
	u := &upload{name: "upload-" + id, touched: time.Now()}
	f, err := s.open(u.name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", nil, err
	}
	f.Close()
	s.objects++
	s.uploads[id] = u
	return id, u, nil
}
func (s *Store) dropUpload(id string, u *upload) { // caller holds u.mu
	if u.done {
		return
	}
	u.done = true
	removed := s.root.Remove(u.name)
	s.mu.Lock()
	delete(s.uploads, id)
	if removed == nil {
		s.used -= u.size
		s.objects--
	}
	s.mu.Unlock()
}
func (s *Store) appendUpload(r *http.Request, u *upload) error { // caller holds u.mu
	f, err := s.open(u.name, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() != u.size {
		return errors.New("upload changed")
	}
	if header := r.Header.Get("Content-Range"); header != "" {
		match := rangeRE.FindStringSubmatch(header)
		if len(match) != 3 {
			return errors.New("invalid upload range")
		}
		start, startErr := strconv.ParseInt(match[1], 10, 64)
		end, endErr := strconv.ParseInt(match[2], 10, 64)
		if startErr != nil || endErr != nil || start != u.size || end < start || end-start == int64(^uint64(0)>>1) || r.ContentLength >= 0 && end-start+1 != r.ContentLength {
			return errors.New("invalid upload range")
		}
	}
	buffer := make([]byte, 64*1024)
	for {
		if err := r.Context().Err(); err != nil {
			return err
		}
		n, readErr := r.Body.Read(buffer)
		if n > 0 {
			if err := s.reserve(int64(n)); err != nil {
				return err
			}
			written, writeErr := f.Write(buffer[:n])
			u.size += int64(written)
			if written < n {
				s.release(int64(n - written))
			}
			if writeErr != nil {
				return writeErr
			}
			if written != n {
				return io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	u.touched = time.Now()
	return f.Sync()
}
func (s *Store) uploadHeaders(w http.ResponseWriter, id string, u *upload) {
	w.Header().Set("Location", "/v2/"+s.config.Repository+"/blobs/uploads/"+id)
	w.Header().Set("Docker-Upload-UUID", id)
	end := u.size - 1
	if end < 0 {
		end = 0
	}
	w.Header().Set("Range", fmt.Sprintf("0-%d", end))
	w.Header().Set("Content-Length", "0")
}
func (s *Store) uploadRequest(w http.ResponseWriter, r *http.Request, id string) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		registryError(w, r, 400, "DENIED", "invalid upload query")
		return
	}
	if id == "" && r.Method == "POST" {
		for key, values := range query {
			if len(values) != 1 || (key != "mount" && key != "from" && key != "digest") {
				registryError(w, r, 400, "DENIED", "unexpected upload query")
				return
			}
		}
		if from := query.Get("from"); from != "" && from != s.config.Repository {
			registryError(w, r, 403, "DENIED", "cross-repository mounting denied")
			return
		}
		if mount := query.Get("mount"); mount != "" {
			if !digestRE.MatchString(mount) {
				registryError(w, r, 400, "DIGEST_INVALID", "invalid digest")
				return
			}
			if f, e := s.open(blobName(mount), os.O_RDONLY, 0); e == nil {
				f.Close()
				w.Header().Set("Location", "/v2/"+s.config.Repository+"/blobs/"+mount)
				w.Header().Set("Docker-Content-Digest", mount)
				w.WriteHeader(201)
				return
			}
		}
		id, u, e := s.newUpload()
		if e != nil {
			registryError(w, r, 413, "SIZE_INVALID", "image store upload capacity exceeded")
			return
		}
		u.mu.Lock()
		defer u.mu.Unlock()
		if value := query.Get("digest"); value != "" {
			s.finishUpload(w, r, id, u, value)
			return
		}
		if e = s.appendUpload(r, u); e != nil {
			s.dropUpload(id, u)
			registryError(w, r, 413, "SIZE_INVALID", "image upload failed or exceeded capacity")
			return
		}
		s.uploadHeaders(w, id, u)
		w.WriteHeader(202)
		return
	}
	if !uploadRE.MatchString(id) {
		registryError(w, r, 404, "BLOB_UPLOAD_UNKNOWN", "unknown upload")
		return
	}
	s.mu.Lock()
	u := s.uploads[id]
	s.mu.Unlock()
	if u == nil {
		registryError(w, r, 404, "BLOB_UPLOAD_UNKNOWN", "unknown upload")
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		registryError(w, r, 404, "BLOB_UPLOAD_UNKNOWN", "unknown upload")
		return
	}
	if r.Method == "DELETE" && len(query) == 0 {
		s.dropUpload(id, u)
		w.WriteHeader(204)
		return
	}
	if (r.Method == "GET" || r.Method == "HEAD") && len(query) == 0 {
		s.uploadHeaders(w, id, u)
		w.WriteHeader(204)
		return
	}
	if r.Method == "PATCH" && len(query) == 0 {
		if e := s.appendUpload(r, u); e != nil {
			s.dropUpload(id, u)
			registryError(w, r, 413, "SIZE_INVALID", "image upload failed or exceeded capacity")
			return
		}
		s.uploadHeaders(w, id, u)
		w.WriteHeader(202)
		return
	}
	if r.Method == "PUT" && len(query) == 1 && len(query["digest"]) == 1 {
		s.finishUpload(w, r, id, u, query.Get("digest"))
		return
	}
	registryError(w, r, 405, "DENIED", "unsupported upload operation")
}
func (s *Store) verifyBlob(name, value string, size int64) error {
	f, err := s.open(name, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() != size {
		return errors.New("blob size differs")
	}
	h := sha256.New()
	n, err := io.CopyBuffer(h, io.LimitReader(f, size+1), make([]byte, 64*1024))
	if err != nil || n != size || "sha256:"+hex.EncodeToString(h.Sum(nil)) != value {
		return errors.New("blob digest differs")
	}
	return nil
}
func (s *Store) finishUpload(w http.ResponseWriter, r *http.Request, id string, u *upload, value string) {
	if !digestRE.MatchString(value) {
		s.dropUpload(id, u)
		registryError(w, r, 400, "DIGEST_INVALID", "invalid blob digest")
		return
	}
	if err := s.appendUpload(r, u); err != nil {
		s.dropUpload(id, u)
		registryError(w, r, 413, "SIZE_INVALID", "image upload failed or exceeded capacity")
		return
	}
	if err := s.verifyBlob(u.name, value, u.size); err != nil {
		s.dropUpload(id, u)
		registryError(w, r, 400, "DIGEST_INVALID", "uploaded blob digest differs")
		return
	}
	name := blobName(value)
	if err := s.root.Link(u.name, name); err != nil {
		if !errors.Is(err, os.ErrExist) || s.verifyBlob(name, value, u.size) != nil {
			s.dropUpload(id, u)
			registryError(w, r, 409, "DIGEST_INVALID", "existing blob differs")
			return
		}
		s.dropUpload(id, u)
	} else {
		_ = s.root.Remove(u.name)
		u.done = true
		s.mu.Lock()
		delete(s.uploads, id)
		s.mu.Unlock()
	}
	if err := s.syncDirectory(); err != nil {
		registryError(w, r, 503, "UNKNOWN", "image store sync failed")
		return
	}
	w.Header().Set("Location", "/v2/"+s.config.Repository+"/blobs/"+value)
	w.Header().Set("Docker-Content-Digest", value)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(201)
}

type descriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Annotations map[string]string `json:"annotations,omitempty"`
}
type manifest struct {
	SchemaVersion int          `json:"schemaVersion"`
	MediaType     string       `json:"mediaType"`
	Config        descriptor   `json:"config"`
	Layers        []descriptor `json:"layers"`
}

func parseManifest(raw []byte) (*manifest, error) {
	var value manifest
	if json.Unmarshal(raw, &value) != nil || value.SchemaVersion != 2 || value.MediaType != manifestType || value.Config.MediaType != configType || !digestRE.MatchString(value.Config.Digest) || value.Config.Size <= 0 || value.Config.Size > maxManifestBytes || len(value.Layers) < 1 || len(value.Layers) > 256 {
		return nil, errors.New("invalid encrypted OCI manifest")
	}
	for _, layer := range value.Layers {
		media := layer.MediaType == "application/vnd.oci.image.layer.v1.tar+encrypted" || layer.MediaType == "application/vnd.oci.image.layer.v1.tar+gzip+encrypted" || layer.MediaType == "application/vnd.oci.image.layer.v1.tar+zstd+encrypted"
		if !digestRE.MatchString(layer.Digest) || layer.Size <= 0 || !media || len(layer.Annotations[keyAnnotation]) == 0 || len(layer.Annotations[keyAnnotation]) > 8192 {
			return nil, errors.New("every layer must be encrypted")
		}
	}
	return &value, nil
}
func (s *Store) atomicMetadata(name string, raw []byte) error {
	if old, err := s.small(name, maxManifestBytes); err == nil {
		if string(old) == string(raw) {
			return s.syncDirectory()
		}
		return errors.New("immutable image metadata differs")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := s.reserve(int64(len(raw))); err != nil {
		return err
	}
	if err := s.reserveObject(); err != nil {
		s.release(int64(len(raw)))
		return err
	}
	id, err := identifier()
	if err != nil {
		s.release(int64(len(raw)))
		s.releaseObject()
		return err
	}
	temp := "pending-" + id
	f, err := s.open(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		s.release(int64(len(raw)))
		s.releaseObject()
		return err
	}
	written, writeErr := f.Write(raw)
	err = writeErr
	if err == nil && written != len(raw) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = s.root.Link(temp, name)
	}
	removed := s.root.Remove(temp)
	if err != nil {
		if removed == nil {
			s.release(int64(len(raw)))
			s.releaseObject()
		}
		return err
	}
	return s.syncDirectory()
}
func (s *Store) putManifest(w http.ResponseWriter, r *http.Request, reference string) {
	if reference != "release" && !digestRE.MatchString(reference) {
		registryError(w, r, 400, "TAG_INVALID", "only the immutable release tag or a digest is accepted")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxManifestBytes+1))
	if err != nil || int64(len(raw)) > maxManifestBytes {
		registryError(w, r, 413, "SIZE_INVALID", "manifest exceeds limit")
		return
	}
	value, err := parseManifest(raw)
	if err != nil {
		registryError(w, r, 400, "MANIFEST_INVALID", "only encrypted OCI image manifests are accepted")
		return
	}
	sum := digest(raw)
	if reference != "release" && reference != sum {
		registryError(w, r, 400, "DIGEST_INVALID", "manifest digest differs")
		return
	}
	s.commit.Lock()
	defer s.commit.Unlock()
	if reference == "release" {
		if old, e := s.small("release", 71); e == nil && string(old) != sum {
			registryError(w, r, 409, "DENIED", "release tag is immutable")
			return
		} else if e != nil && !errors.Is(e, os.ErrNotExist) {
			registryError(w, r, 503, "UNKNOWN", "release tag unavailable")
			return
		}
	}
	for _, item := range append([]descriptor{value.Config}, value.Layers...) {
		if item.Size > s.config.MaxBytes || s.verifyBlob(blobName(item.Digest), item.Digest, item.Size) != nil {
			registryError(w, r, 400, "MANIFEST_BLOB_UNKNOWN", "manifest references an absent or changed blob")
			return
		}
	}
	if err = s.atomicMetadata(manifestName(sum), raw); err == nil && reference == "release" {
		err = s.atomicMetadata("release", []byte(sum))
	}
	if err != nil {
		registryError(w, r, 409, "DENIED", "image commit failed or capacity exceeded")
		return
	}
	w.Header().Set("Docker-Content-Digest", sum)
	w.Header().Set("Location", "/v2/"+s.config.Repository+"/manifests/"+sum)
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(201)
}
func (s *Store) syncDirectory() error {
	f, e := s.root.Open(".")
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}

func (s *Store) expireUploads() {
	s.mu.Lock()
	copyUploads := make(map[string]*upload, len(s.uploads))
	for id, u := range s.uploads {
		copyUploads[id] = u
	}
	s.mu.Unlock()
	for id, u := range copyUploads {
		if u.mu.TryLock() {
			if time.Since(u.touched) > uploadLifetime {
				s.dropUpload(id, u)
			}
			u.mu.Unlock()
		}
	}
}

// Start runs both endpoints inside the existing manager process. Filesystem
// locking also prevents overlapping operator rollouts from becoming writers.
func (s *Store) Start(ctx context.Context) error {
	defer s.Close()
	read, err := net.Listen("tcp", ReadAddress)
	if err != nil {
		return err
	}
	write, err := net.Listen("tcp", WriteAddress)
	if err != nil {
		read.Close()
		return err
	}
	servers := []*http.Server{{Handler: s.Reader()}, {Handler: s.Writer()}}
	for _, server := range servers {
		server.ReadHeaderTimeout = 5 * time.Second
		server.ReadTimeout = 30 * time.Minute
		server.WriteTimeout = 30 * time.Minute
		server.IdleTimeout = 30 * time.Second
		server.MaxHeaderBytes = 16384
	}
	errorsChannel := make(chan error, 2)
	go func() { errorsChannel <- servers[0].Serve(read) }()
	go func() { errorsChannel <- servers[1].Serve(write) }()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	var result error
run:
	for {
		select {
		case <-ctx.Done():
			break run
		case result = <-errorsChannel:
			break run
		case <-ticker.C:
			s.expireUploads()
		}
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, server := range servers {
		_ = server.Shutdown(stop)
		_ = server.Close()
	}
	if result == http.ErrServerClosed {
		return nil
	}
	return result
}
