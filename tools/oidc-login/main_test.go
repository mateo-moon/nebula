//go:build linux || darwin

package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func saveCredential(t *testing.T, values map[string]any) string {
	t.Helper()
	data, err := json.Marshal(values)
	if err != nil {
		t.Fatal("fixture encoding failed")
	}
	path := filepath.Join(t.TempDir(), "client.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal("fixture write failed")
	}
	return path
}

func TestProtectedCredential(t *testing.T) {
	good := func() map[string]any {
		return map[string]any{"issuer": "https://issuer.example.test", "client_id": "fixture-client", "client_secret": "fixture-value", "expires_unix": time.Now().Add(time.Hour).Unix()}
	}
	for _, name := range []string{"good", "read-only", "no-expiry", "expired", "null-expiry", "foreign-issuer", "foreign-client", "missing-secret", "group-readable", "symlink", "directory", "oversized", "malformed", "trailing-json"} {
		t.Run(name, func(t *testing.T) {
			values := good()
			switch name {
			case "no-expiry":
				delete(values, "expires_unix")
			case "expired":
				values["expires_unix"] = time.Now().Add(-time.Minute).Unix()
			case "null-expiry":
				values["expires_unix"] = nil
			case "foreign-issuer":
				values["issuer"] = "https://foreign.example.test"
			case "foreign-client":
				values["client_id"] = "another-client"
			case "missing-secret":
				delete(values, "client_secret")
			}
			path := saveCredential(t, values)
			switch name {
			case "read-only":
				if err := os.Chmod(path, 0400); err != nil {
					t.Fatal("fixture chmod failed")
				}
			case "group-readable":
				if err := os.Chmod(path, 0640); err != nil {
					t.Fatal("fixture chmod failed")
				}
			case "symlink":
				link := filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(path, link); err != nil {
					t.Fatal("fixture link failed")
				}
				path = link
			case "directory":
				path = t.TempDir()
			case "oversized":
				if err := os.WriteFile(path, bytes.Repeat([]byte("x"), 16385), 0600); err != nil {
					t.Fatal("fixture write failed")
				}
			case "malformed":
				if err := os.WriteFile(path, []byte("not json"), 0600); err != nil {
					t.Fatal("fixture write failed")
				}
			case "trailing-json":
				f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
				if err != nil {
					t.Fatal("fixture open failed")
				}
				_, _ = f.WriteString("{}")
				_ = f.Close()
			}
			_, err := readCredential(path, "https://issuer.example.test", "fixture-client")
			wantSuccess := name == "good" || name == "read-only" || name == "no-expiry"
			if (err == nil) != wantSuccess {
				t.Fatal("credential boundary did not enforce the expected decision")
			}
		})
	}
	if os.Geteuid() == 0 {
		t.Run("foreign-owner", func(t *testing.T) {
			path := saveCredential(t, good())
			if os.Chown(path, 65532, 65532) != nil {
				t.Fatal("fixture chown failed")
			}
			if _, err := readCredential(path, "https://issuer.example.test", "fixture-client"); err == nil {
				t.Fatal("foreign owner accepted")
			}
		})
	}
}

func TestPublicArguments(t *testing.T) {
	base := []string{"fixture", "get-token", "--oidc-client-secret-file=/fixture/client.json", "--oidc-issuer-url=https://issuer.example.test", "--oidc-client-id=fixture-client"}
	for _, extra := range [][]string{{"--oidc-client-secret=forbidden"}, {"--oidc-client-id=another"}, {"--grant-type=client-credentials"}, {"--oidc-pkce-method=no"}, {"--oidc-use-access-token"}, {"--insecure-skip-tls-verify"}, {"--oidc-auth-request-extra-params=code_challenge_method=plain"}, {"--oidc-auth-request-extra-params=client_secret=forbidden"}} {
		if _, _, _, _, err := publicArguments(append(append([]string(nil), base...), extra...)); err == nil {
			t.Fatal("unsafe or ambiguous options accepted")
		}
	}
	args, _, _, _, err := publicArguments(base)
	if err != nil || !strings.Contains(strings.Join(args, " "), "--oidc-pkce-method=S256") || !strings.Contains(strings.Join(args, " "), "--grant-type=authcode") {
		t.Fatal("explicit human PKCE defaults missing")
	}
}

func TestLoggerDoesNotDiscloseCredentials(t *testing.T) {
	var output bytes.Buffer
	l := &safeLogger{out: &output}
	l.Printf("error: %s", "fixture-secret fixture-token invalid_client")
	l.Printf("Please visit the following URL in your browser: %s", "http://127.0.0.1:8000/?code=fixture-code")
	l.Printf("Please visit the following URL in your browser: %s", "http://127.0.0.1:8000/")
	l.V(3).Infof("fixture-secret fixture-token")
	if strings.Contains(output.String(), "fixture-") || l.IsEnabled(3) {
		t.Fatal("sensitive diagnostics escaped")
	}
	if !strings.Contains(output.String(), "http://127.0.0.1:8000/") {
		t.Fatal("safe local sign-in link missing")
	}
}

type fixtureBrowser struct {
	client *http.Client
	calls  int
}

type promptWriter struct {
	bytes.Buffer
	browser *fixtureBrowser
	err     error
}

func (w *promptWriter) Write(data []byte) (int, error) {
	n, err := w.Buffer.Write(data)
	const prefix = "Open this local sign-in link in your browser: "
	if text := string(data); strings.HasPrefix(text, prefix) {
		w.err = w.browser.Open(strings.TrimSpace(strings.TrimPrefix(text, prefix)))
	}
	return n, err
}

func (b *fixtureBrowser) Open(raw string) error {
	b.calls++
	r, err := b.client.Get(raw)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, r.Body)
	return r.Body.Close()
}
func (b *fixtureBrowser) OpenCommand(context.Context, string, string) error {
	return fmt.Errorf("custom browser is unavailable in this fixture")
}

func TestPinnedUpstreamExchangeCacheAndRefreshKeepSecretOutOfProcessArguments(t *testing.T) {
	t.Setenv("KUBERNETES_EXEC_INFO", `{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","spec":{"interactive":true}}`)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal("fixture key generation failed")
	}
	secret := fmt.Sprintf("fixture-%d", time.Now().UnixNano())
	const clientID = "fixture-client"
	var issuer, challenge, nonce string
	var tokenCalls, refreshCalls int
	var mu sync.Mutex
	sign := func(refreshed bool) string {
		claims := map[string]any{"iss": issuer, "aud": clientID, "sub": "fixture-person", "email": "employee@example.test", "email_verified": true, "hd": "example.test", "azp": clientID, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix()}
		if !refreshed {
			claims["nonce"] = nonce
		}
		header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "fixture"})
		body, _ := json.Marshal(claims)
		payload := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
		digest := sha256.Sum256([]byte(payload))
		signature, e := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
		if e != nil {
			t.Error("fixture signing failed")
		}
		return payload + "." + base64.RawURLEncoding.EncodeToString(signature)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/auth", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}, "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "code_challenge_methods_supported": []string{"S256"}})
		case "/keys":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "fixture", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())}}})
		case "/auth":
			mu.Lock()
			challenge = r.URL.Query().Get("code_challenge")
			nonce = r.URL.Query().Get("nonce")
			mu.Unlock()
			if r.URL.Query().Get("client_id") != clientID || r.URL.Query().Get("code_challenge_method") != "S256" || challenge == "" {
				t.Error("human PKCE request changed")
			}
			callback, e := url.Parse(r.URL.Query().Get("redirect_uri"))
			if e != nil {
				t.Error("invalid fixture callback")
				http.Error(w, "invalid", 400)
				return
			}
			q := callback.Query()
			q.Set("code", "fixture-code")
			q.Set("state", r.URL.Query().Get("state"))
			callback.RawQuery = q.Encode()
			http.Redirect(w, r, callback.String(), http.StatusFound)
		case "/token":
			_ = r.ParseForm()
			id, value := r.Form.Get("client_id"), r.Form.Get("client_secret")
			if value == "" {
				id, value, _ = r.BasicAuth()
			}
			if id != clientID || value != secret {
				t.Error("protected credential not supplied to upstream exchange")
				http.Error(w, "invalid_client", 401)
				return
			}
			if runtime.GOOS == "linux" {
				argv, _ := os.ReadFile("/proc/self/cmdline")
				if bytes.Contains(argv, []byte(secret)) {
					t.Error("credential leaked into OS argv")
				}
			}
			if strings.Contains(strings.Join(os.Args, " "), secret) || strings.Contains(strings.Join(os.Environ(), " "), secret) {
				t.Error("credential leaked outside memory")
			}
			mu.Lock()
			defer mu.Unlock()
			tokenCalls++
			refreshed := r.Form.Get("grant_type") == "refresh_token"
			if refreshed {
				refreshCalls++
				if r.Form.Get("refresh_token") != "fixture-refresh" {
					t.Error("upstream refresh changed")
				}
			} else {
				sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
				if base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
					t.Error("PKCE verification failed")
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-access", "token_type": "Bearer", "expires_in": 3600, "id_token": sign(refreshed), "refresh_token": "fixture-refresh"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	issuer = server.URL
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600) != nil {
		t.Fatal("fixture CA write failed")
	}
	file := saveCredential(t, map[string]any{"issuer": issuer, "client_id": clientID, "client_secret": secret, "expires_unix": time.Now().Add(time.Hour).Unix()})
	args := []string{"fixture", "get-token", "--oidc-client-secret-file=" + file, "--oidc-issuer-url=" + issuer, "--oidc-client-id=" + clientID, "--certificate-authority=" + ca, "--token-cache-storage=disk", "--token-cache-dir=" + t.TempDir(), "--listen-address=127.0.0.1:0", "--skip-open-browser"}
	args = append(args, "--oidc-extra-scope=email", "--oidc-auth-request-extra-params=hd=example.test", "--oidc-auth-request-extra-params=access_type=offline", "--oidc-auth-request-extra-params=prompt=consent")
	originalArgs := append([]string(nil), os.Args...)
	browserClient := &fixtureBrowser{client: server.Client()}
	for attempt := 0; attempt < 21; attempt++ {
		force := attempt == 20
		callArgs := append([]string(nil), args...)
		if force {
			callArgs = append(callArgs, "--force-refresh")
		}
		var stdout bytes.Buffer
		stderr := promptWriter{browser: browserClient}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		code := run(ctx, callArgs, strings.NewReader(""), &stdout, &stderr, browserClient)
		cancel()
		if code != 0 || stderr.err != nil {
			t.Fatalf("pinned upstream fixture login failed: %s", stderr.String())
		}
		var credential struct {
			Status struct {
				Token string `json:"token"`
			} `json:"status"`
		}
		if json.Unmarshal(stdout.Bytes(), &credential) != nil || credential.Status.Token == "" {
			t.Fatal("ExecCredential output missing")
		}
		if strings.Contains(stderr.String(), secret) || strings.Contains(stderr.String(), credential.Status.Token) || strings.Contains(stdout.String(), secret) || strings.Contains(stdout.String(), "fixture-refresh") {
			t.Fatal("credential disclosure outside ExecCredential ID token")
		}
	}
	if tokenCalls != 2 || refreshCalls != 1 || browserClient.calls != 1 {
		t.Fatal("cached use or forced refresh bypassed upstream behavior")
	}
	if !reflect.DeepEqual(os.Args, originalArgs) {
		t.Fatal("os.Args changed")
	}
	var stdout, stderr bytes.Buffer
	missing := strings.ReplaceAll(strings.Join(args, "\x00"), "--oidc-client-secret-file="+file, "--oidc-client-secret-file=/missing/credential.json")
	if run(context.Background(), strings.Split(missing, "\x00"), strings.NewReader(""), &stdout, &stderr, browserClient) == 0 || browserClient.calls != 1 {
		t.Fatal("missing credential did not fail before browser launch")
	}
}
