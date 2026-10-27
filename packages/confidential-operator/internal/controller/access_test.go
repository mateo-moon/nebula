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
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

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
