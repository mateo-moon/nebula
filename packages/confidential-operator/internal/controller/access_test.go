package controller

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

func TestBrowserInvitationComesFromGuestAndRemainsStableUntilGuestRestart(t *testing.T) {
	token := bytes.Repeat([]byte{0x42}, 32)
	commitment := sha256.Sum256(token)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(out http.ResponseWriter, in *http.Request) {
		calls++
		if in.Header.Get("Authorization") != "" {
			t.Error("credentials sent to invitation exporter")
		}
		json.NewEncoder(out).Encode(map[string]string{"token": hex.EncodeToString(token), "commitment": hex.EncodeToString(commitment[:])})
	}))
	defer server.Close()
	w, _, _ := fixture("qualified", "browser")
	c := fake.NewClientBuilder().WithScheme(testScheme()).WithObjects(w).Build()
	manager := AccessManager{Client: c, Reader: c}
	a := &AccessLink{URL: "https://stack.example/", SecretName: "browser-access", OwnerPort: 8443,
		Browser: &BrowserAccess{InvitationEndpoint: server.URL, WorkloadEndpoint: "https://preparation.example/", LoaderURL: "https://release.example/client/"}}
	secret, err := manager.secret(context.Background(), w, a, true)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(secret.Data["token"], []byte(hex.EncodeToString(token))) {
		t.Fatal("operator replaced the guest invitation")
	}
	link, err := url.Parse(string(secret.Data["url"]))
	if err != nil {
		t.Fatal(err)
	}
	fragment, _ := url.ParseQuery(link.Fragment)
	if fragment.Get("token") != string(secret.Data["token"]) || fragment.Get("endpoint") != a.Browser.WorkloadEndpoint || fragment.Get("stack") != a.URL || link.RawQuery != "" {
		t.Fatal("browser capability must be carried only in the generated fragment")
	}
	if _, err := manager.secret(context.Background(), w, a, true); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("unclaimed preparation invitation was not rechecked")
	}
	w.Spec.Raw = []byte(`{"accessLink":{"url":"https://stack.example/","ownerPort":8443,"secretName":"browser-access","browser":{"invitationEndpoint":"http://metadata.internal/latest/","workloadEndpoint":"https://preparation.example/","loaderUrl":"https://release.example/"}}}`)
	if _, err := accessLink(w); err == nil {
		t.Fatal("invitation exporter accepted an arbitrary infrastructure URL")
	}
}

func TestBrowserInvitationRefreshPreservesOwnerAndFinalGuestBoundaries(t *testing.T) {
	for _, boundary := range []string{"unclaimed", "owner", "pod-uid", "pod-name", "spec-hash", "init-data", "existing-pod"} {
		t.Run(boundary, func(t *testing.T) {
			ctx := context.Background()
			var token atomic.Value
			token.Store(bytes.Repeat([]byte{0x42}, 32))
			var calls atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(out http.ResponseWriter, in *http.Request) {
				calls.Add(1)
				raw := token.Load().([]byte)
				sum := sha256.Sum256(raw)
				json.NewEncoder(out).Encode(map[string]string{"token": hex.EncodeToString(raw), "commitment": hex.EncodeToString(sum[:])})
			}))
			defer server.Close()
			w, _, _ := fixture("qualified", "refresh")
			c := fake.NewClientBuilder().WithScheme(testScheme()).WithObjects(w).WithInterceptorFuncs(interceptor.Funcs{
				Patch: func(context.Context, client.WithWatch, client.Object, client.Patch, ...client.PatchOption) error {
					return errors.New("the named Secret Role permits update, not patch")
				},
			}).Build()
			manager := AccessManager{Client: c, Reader: c}
			a := &AccessLink{URL: "https://stack.example/", SecretName: "refresh-access", OwnerPort: 8443,
				Browser: &BrowserAccess{InvitationEndpoint: server.URL, WorkloadEndpoint: "https://preparation.example/", LoaderURL: "https://192.0.2.1:9443/", ManualTLS: true}}
			old, err := manager.secret(ctx, w, a, true)
			if err != nil {
				t.Fatal(err)
			}
			w.Status.AccessTokenSHA256 = string(old.Data["commitment"])
			switch boundary {
			case "owner":
				key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
				_, public := discoveryProof(t, key, a.URL, "discovery")
				old.Data["owner-public-key.pem"] = []byte(public)
				delete(old.Data, "token")
				delete(old.Data, "url")
				if err := c.Update(ctx, old); err != nil {
					t.Fatal(err)
				}
			case "pod-uid":
				w.Status.PodUID = "previous-instance"
			case "pod-name":
				w.Status.PodName = "previous-guest"
			case "spec-hash":
				w.Status.SpecSHA256 = strings.Repeat("a", 64)
			case "init-data":
				w.Status.InitDataSHA256 = strings.Repeat("b", 64)
			case "existing-pod":
				pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "existing", Namespace: w.Namespace,
					Labels: map[string]string{ownerLabel: string(w.UID)}, OwnerReferences: []metav1.OwnerReference{ownerReference(w)}}}
				if err := c.Create(ctx, pod); err != nil {
					t.Fatal(err)
				}
			}
			token.Store(bytes.Repeat([]byte{0x57}, 32))
			got, err := manager.secret(ctx, w, a, true)
			if err != nil {
				t.Fatal(err)
			}
			if boundary != "unclaimed" {
				if calls.Load() != 1 || !bytes.Equal(got.Data["commitment"], old.Data["commitment"]) ||
					!bytes.Equal(got.Data["owner-public-key.pem"], old.Data["owner-public-key.pem"]) ||
					!bytes.Equal(got.Data["token"], old.Data["token"]) {
					t.Fatal("refresh crossed an enrollment boundary")
				}
				return
			}
			fresh := token.Load().([]byte)
			sum := sha256.Sum256(fresh)
			if calls.Load() != 2 || string(got.Data["token"]) != hex.EncodeToString(fresh) ||
				string(got.Data["commitment"]) != hex.EncodeToString(sum[:]) || string(got.Data["url"]) != a.Browser.LoaderURL {
				t.Fatal("unclaimed invitation was not refreshed from the restarted guest")
			}
			// Simulate interruption before the workload status could be patched.
			retry, err := manager.secret(ctx, w, a, true)
			if err != nil || !bytes.Equal(retry.Data["commitment"], got.Data["commitment"]) {
				t.Fatal("interrupted refresh could not recover safely")
			}
			if _, err := manager.secret(ctx, w, a, false); err == nil {
				t.Fatal("metadata request changed or bypassed stale status")
			}
			w.Status.AccessTokenSHA256 = string(got.Data["commitment"])
			if _, err := manager.secret(ctx, w, a, false); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBrowserInvitationRefreshCannotRaceOwnerClaim(t *testing.T) {
	ctx := context.Background()
	w, _, _ := fixture("qualified", "claim-race")
	c := fake.NewClientBuilder().WithScheme(testScheme()).WithObjects(w).Build()
	manager := AccessManager{Client: c, Reader: c}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	_, public := discoveryProof(t, key, "https://stack.example/", "discovery")
	var claim atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(out http.ResponseWriter, in *http.Request) {
		raw := bytes.Repeat([]byte{0x42}, 32)
		if claim.Load() {
			var secret corev1.Secret
			if err := c.Get(ctx, client.ObjectKey{Namespace: w.Namespace, Name: "race-access"}, &secret); err != nil {
				t.Error(err)
				out.WriteHeader(500)
				return
			}
			secret.Data["owner-public-key.pem"] = []byte(public)
			delete(secret.Data, "token")
			delete(secret.Data, "url")
			if err := c.Update(ctx, &secret); err != nil {
				t.Error(err)
				out.WriteHeader(500)
				return
			}
			raw = bytes.Repeat([]byte{0x57}, 32)
		}
		sum := sha256.Sum256(raw)
		json.NewEncoder(out).Encode(map[string]string{"token": hex.EncodeToString(raw), "commitment": hex.EncodeToString(sum[:])})
	}))
	defer server.Close()
	a := &AccessLink{URL: "https://stack.example/", SecretName: "race-access", Browser: &BrowserAccess{
		InvitationEndpoint: server.URL, WorkloadEndpoint: "https://preparation.example/", LoaderURL: "https://192.0.2.1:9443/", ManualTLS: true}}
	old, err := manager.secret(ctx, w, a, true)
	if err != nil {
		t.Fatal(err)
	}
	w.Status.AccessTokenSHA256 = string(old.Data["commitment"])
	claim.Store(true)
	if _, err := manager.secret(ctx, w, a, true); !apierrors.IsConflict(err) {
		t.Fatalf("concurrent owner claim was not protected: %v", err)
	}
	var got corev1.Secret
	if err := c.Get(ctx, client.ObjectKeyFromObject(old), &got); err != nil {
		t.Fatal(err)
	}
	if string(got.Data["owner-public-key.pem"]) != public || len(got.Data["token"]) != 0 || len(got.Data["url"]) != 0 {
		t.Fatal("refresh restored access after the owner consumed the invitation")
	}
}

func TestBrowserInvitationRefusesUnboundTokenAndRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(out http.ResponseWriter, in *http.Request) {
		if in.URL.Path == "/redirect" {
			http.Redirect(out, in, "/invitation", 302)
			return
		}
		json.NewEncoder(out).Encode(map[string]string{"token": strings.Repeat("a", 64), "commitment": strings.Repeat("b", 64)})
	}))
	defer server.Close()
	a := &AccessLink{Browser: &BrowserAccess{InvitationEndpoint: server.URL + "/invitation"}}
	if _, err := browserInvitation(context.Background(), a); err == nil {
		t.Fatal("unbound token accepted")
	}
	a.Browser.InvitationEndpoint = server.URL + "/redirect"
	if _, err := browserInvitation(context.Background(), a); err == nil {
		t.Fatal("exporter redirect accepted")
	}
}

func TestManualTLSInvitationKeepsClaimTokenOutOfURL(t *testing.T) {
	token := strings.Repeat("a", 64)
	a := &AccessLink{URL: "https://stack.example/", SecretName: "manual-access", OwnerPort: 8443,
		Browser: &BrowserAccess{InvitationEndpoint: "http://preparation.qualified.svc:8089/invitation",
			WorkloadEndpoint: "https://preparation.example/", LoaderURL: "https://192.0.2.1:9443/", ManualTLS: true}}
	if actual := browserAccessURL(a, token); actual != a.Browser.LoaderURL || strings.Contains(actual, token) {
		t.Fatal("manual first page received a usable claim token")
	}
	w, _, _ := fixture("qualified", "manual")
	w.Spec.Raw, _ = json.Marshal(map[string]any{"accessLink": a})
	if _, err := accessLink(w); err != nil {
		t.Fatal(err)
	}
	a.Browser.LoaderURL = "https://192.0.2.1:9443/loader/"
	w.Spec.Raw, _ = json.Marshal(map[string]any{"accessLink": a})
	if _, err := accessLink(w); err == nil {
		t.Fatal("manual TLS accepted a shared path origin")
	}
}

func discoveryProof(t *testing.T, key *ecdsa.PrivateKey, endpoint, role string) (string, string) {
	t.Helper()
	encode := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	now := time.Now().Unix()
	unsigned := encode(map[string]any{"alg": "ES256", "typ": "JWT"}) + "." + encode(map[string]any{"aud": accessAudience(endpoint), "role": role, "iat": now, "exp": now + 90})
	digest := sha256.Sum256([]byte(unsigned))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(sig), string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func TestGeneratedAccessLinkIsOneUseAndMetadataProofCannotBecomeOwnerAuthority(t *testing.T) {
	ctx := context.Background()
	w, _, _ := fixture("qualified", "linked")
	w.Spec.Raw = []byte(`{"accessLink":{"url":"https://stack.example/","ownerPort":8443,"secretName":"linked-access"},"containers":[{"ports":[]}]}`)
	scheme := testScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(w).WithObjects(w).Build()
	r := &WorkloadReconciler{Client: c, Reader: c, Scheme: scheme, Renderer: &publicationRenderer{pending: true}}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	got := getWorkload(t, c, w)
	if got.Status.AccessTokenSHA256 == "" || got.Status.AccessSecretName != "linked-access" || got.Status.Phase != "AwaitingPublication" {
		t.Fatalf("access not ready before image: %+v", got.Status)
	}
	var secret corev1.Secret
	if err := c.Get(ctx, client.ObjectKey{Namespace: w.Namespace, Name: "linked-access"}, &secret); err != nil {
		t.Fatal(err)
	}
	token := string(secret.Data["token"])
	if len(token) != 64 || string(secret.Data["url"]) != "https://stack.example/#"+token {
		t.Fatal("missing generated link")
	}
	data, _ := json.Marshal(got)
	if bytes.Contains(data, []byte(token)) {
		t.Fatal("bootstrap token leaked into CR/status")
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	var stable corev1.Secret
	_ = c.Get(ctx, client.ObjectKeyFromObject(&secret), &stable)
	if !bytes.Equal(stable.Data["token"], secret.Data["token"]) {
		t.Fatal("reconcile rotated the token")
	}
	manager := AccessManager{Client: c, Reader: c, Namespaces: []string{w.Namespace}}
	call := func(method, path, header string, body any) *httptest.ResponseRecorder {
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, "https://stack.example"+path, bytes.NewReader(raw))
		req.Header.Set("Authorization", header)
		out := httptest.NewRecorder()
		manager.ServeHTTP(out, req)
		return out
	}
	if call("GET", discoveryPath, "", nil).Code != 403 {
		t.Fatal("unauthenticated settings allowed")
	}
	response := call("GET", discoveryPath, "Bootstrap "+token, nil)
	if response.Code != 200 || strings.Contains(response.Body.String(), token) || strings.Contains(response.Body.String(), "accessLink") {
		t.Fatal("invalid public discovery response")
	}
	owner, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	proof, public := discoveryProof(t, owner, "https://stack.example/", "discovery")
	wrongRole, _ := discoveryProof(t, owner, "https://stack.example/", "owner")
	if verifyAccessJWT(wrongRole, []byte(public), "https://stack.example/") {
		t.Fatal("Trustee owner role accepted for discovery")
	}
	if verifyAccessJWT(proof, []byte(public), "https://other.example/") {
		t.Fatal("metadata JWT replayed to another endpoint")
	}
	if call("POST", discoveryPath+"/claim", "Bootstrap "+token, map[string]string{"ownerPublicKeyPem": public, "proof": wrongRole}).Code != 403 {
		t.Fatal("wrong credential consumed invitation")
	}
	if call("POST", discoveryPath+"/claim", "Bootstrap "+token, map[string]string{"ownerPublicKeyPem": public, "proof": proof}).Code != 200 {
		t.Fatal("owner proof could not consume link")
	}
	if call("GET", discoveryPath, "Bootstrap "+token, nil).Code != 403 {
		t.Fatal("consumed token remained usable")
	}
	if call("GET", discoveryPath, "Bearer "+proof, nil).Code != 200 {
		t.Fatal("enrolled metadata owner refused")
	}
	adversary, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	impostor, _ := discoveryProof(t, adversary, "https://stack.example/", "discovery")
	if call("GET", discoveryPath, "Bearer "+impostor, nil).Code != 403 {
		t.Fatal("impostor read enrolled settings")
	}
	if call("POST", discoveryPath+"/claim", "Bearer "+proof, map[string]any{}).Code != 200 {
		t.Fatal("same owner retry is not idempotent")
	}
	_ = c.Get(ctx, client.ObjectKeyFromObject(&secret), &stable)
	if len(stable.Data["url"]) > 0 || len(stable.Data["token"]) > 0 || string(stable.Data["commitment"]) != got.Status.AccessTokenSHA256 {
		t.Fatal("consumed Secret retained bootstrap credential or lost measured commitment")
	}
	if err := run(t, r, w); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, &stable); err != nil {
		t.Fatal(err)
	}
	if err := run(t, r, w); err == nil {
		t.Fatal("missing issued credentials silently regenerated")
	}
	var absent corev1.Secret
	if c.Get(ctx, client.ObjectKeyFromObject(&secret), &absent) == nil {
		t.Fatal("deleted issued Secret was recreated")
	}
}
