//go:build linux || darwin

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type credentialFile struct {
	Issuer       string          `json:"issuer"`
	ClientID     string          `json:"client_id"`
	ClientSecret string          `json:"client_secret"`
	ExpiresUnix  json.RawMessage `json:"expires_unix,omitempty"`
	expiry       time.Time
}

func readCredential(filename, issuer, clientID string) (*credentialFile, error) {
	invalid := fmt.Errorf("invalid protected credential")
	if strings.HasPrefix(filename, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, invalid
		}
		filename = filepath.Join(home, filename[2:])
	}
	if !filepath.IsAbs(filename) {
		return nil, invalid
	}
	fd, err := syscall.Open(filename, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, invalid
	}
	f := os.NewFile(uintptr(fd), "protected-oidc-credential")
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || (info.Mode().Perm() != 0600 && info.Mode().Perm() != 0400) || info.Size() < 1 || info.Size() > 16384 {
		return nil, invalid
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, invalid
	}
	data, err := io.ReadAll(io.LimitReader(f, 16385))
	if err != nil || len(data) > 16384 {
		return nil, invalid
	}
	defer clear(data)
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var value credentialFile
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, invalid
	}
	parsed, err := url.Parse(issuer)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		value.Issuer != issuer || value.ClientID != clientID || value.ClientSecret == "" || len(value.ClientSecret) > 4096 {
		return nil, invalid
	}
	if len(value.ExpiresUnix) != 0 {
		var expiry int64
		if json.Unmarshal(value.ExpiresUnix, &expiry) != nil || expiry <= time.Now().Unix() {
			return nil, invalid
		}
		value.expiry = time.Unix(expiry, 0)
	}
	return &value, nil
}
