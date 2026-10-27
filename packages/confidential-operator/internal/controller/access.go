package controller

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	api "github.com/mateo-moon/nebula/packages/confidential-operator/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const discoveryPath = "/.well-known/nebula/confidential"
const accessSecretType corev1.SecretType = "confidential.nebula.dev/access-link"

type AccessLink struct {
	URL             string `json:"url"`
	SecretName      string `json:"secretName"`
	OwnerPort       int    `json:"ownerPort"`
	VCEKCertificate string `json:"vcekCertificate,omitempty"`
}

func accessLink(w *api.ConfidentialWorkload) (*AccessLink, error) {
	var spec struct {
		AccessLink *AccessLink `json:"accessLink"`
	}
	if json.Unmarshal(w.Spec.Raw, &spec) != nil {
		return nil, errors.New("invalid access configuration")
	}
	if spec.AccessLink == nil {
		return nil, nil
	}
	a := spec.AccessLink
	u, err := url.Parse(a.URL)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/" ||
		(u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "127.0.0.1")) ||
		u.Hostname() == "" || a.SecretName == "" || a.OwnerPort < 1 || a.OwnerPort > 65535 {
		return nil, errors.New("invalid access endpoint")
	}
	return a, nil
}

// AccessManager handles disposable invitation authority and public metadata.
// It never receives a Trustee JWT, an owner private key or a workload key.
type AccessManager struct {
	Client     client.Client
	Reader     client.Reader
	Namespaces []string
}

func (m AccessManager) secret(ctx context.Context, w *api.ConfidentialWorkload, a *AccessLink, create bool) (*corev1.Secret, error) {
	key := types.NamespacedName{Namespace: w.Namespace, Name: a.SecretName}
	var secret corev1.Secret
	err := m.Reader.Get(ctx, key, &secret)
	if apierrors.IsNotFound(err) && create {
		if w.Status.AccessTokenSHA256 != "" || w.Status.PodUID != "" {
			return nil, errors.New("access Secret is missing; existing invitation and guest were preserved")
		}
		var random [32]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, errors.New("cannot generate access credentials")
		}
		token := hex.EncodeToString(random[:])
		digest := sha256.Sum256(random[:])
		secret = corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: a.SecretName, Namespace: w.Namespace,
			OwnerReferences: []metav1.OwnerReference{ownerReference(w)}}, Type: accessSecretType,
			Data: map[string][]byte{"token": []byte(token), "url": []byte(a.URL + "#" + token),
				"endpoint": []byte(a.URL), "commitment": []byte(hex.EncodeToString(digest[:]))}}
		if err := m.Client.Create(ctx, &secret); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return nil, kubeFailure("AccessSecretFailed", "access credentials could not be created", err)
			}
			if err := m.Reader.Get(ctx, key, &secret); err != nil {
				return nil, kubeFailure("AccessSecretFailed", "access credentials are unavailable", err)
			}
		}
	} else if err != nil {
		return nil, kubeFailure("AccessSecretFailed", "access credentials are unavailable", err)
	}
	commitment := string(secret.Data["commitment"])
	decoded, err := hex.DecodeString(commitment)
	if secret.Type != accessSecretType || !ownedBy(&secret, w) || len(decoded) != 32 || err != nil ||
		string(secret.Data["endpoint"]) != a.URL || (w.Status.AccessTokenSHA256 != "" && w.Status.AccessTokenSHA256 != commitment) {
		return nil, errors.New("access credentials conflict with the existing workload; owner intervention required")
	}
	if len(secret.Data["owner-public-key.pem"]) == 0 {
		raw, err := hex.DecodeString(string(secret.Data["token"]))
		sum := sha256.Sum256(raw)
		if err != nil || len(raw) != 32 || subtle.ConstantTimeCompare(sum[:], decoded) != 1 ||
			string(secret.Data["url"]) != a.URL+"#"+string(secret.Data["token"]) {
			return nil, errors.New("invalid bootstrap credentials")
		}
	} else if _, err := accessPublicKey(secret.Data["owner-public-key.pem"]); err != nil {
		return nil, errors.New("invalid access owner")
	}
	return &secret, nil
}

func resolveAccess(w *api.ConfidentialWorkload, secret *corev1.Secret) (*api.ConfidentialWorkload, error) {
	var spec map[string]json.RawMessage
	if json.Unmarshal(w.Spec.Raw, &spec) != nil {
		return nil, errors.New("invalid declaration")
	}
	if spec["ownerClaimSha256"] != nil || spec["ownerPublicKeyPem"] != nil {
		return nil, errors.New("conflicting owner configuration")
	}
	delete(spec, "accessLink")
	spec["ownerClaimSha256"], _ = json.Marshal(string(secret.Data["commitment"]))
	clean := w.DeepCopy()
	clean.Spec.Raw, _ = json.Marshal(spec)
	return clean, nil
}

func accessPublicKey(data []byte) (*ecdsa.PublicKey, error) {
	block, rest := pem.Decode(data)
	if block == nil || block.Type != "PUBLIC KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("invalid public key")
	}
	value, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := value.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("P-256 required")
	}
	return key, nil
}

func accessAudience(endpoint string) string {
	sum := sha256.Sum256([]byte(endpoint))
	return "nebula-discovery:" + hex.EncodeToString(sum[:])
}

// Discovery JWTs have a distinct audience and role. They cannot authorize a
// single KBS or guest-owner operation even if this metadata service is hostile.
func verifyAccessJWT(token string, public []byte, endpoint string) bool {
	if len(token) > 4096 {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	head, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	if json.Unmarshal(head, &header) != nil || header.Alg != "ES256" || header.Typ != "JWT" {
		return false
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Aud  string `json:"aud"`
		Role string `json:"role"`
		Iat  int64  `json:"iat"`
		Exp  int64  `json:"exp"`
	}
	now := time.Now().Unix()
	if json.Unmarshal(body, &claims) != nil || claims.Aud != accessAudience(endpoint) || claims.Role != "discovery" ||
		claims.Iat > now+15 || claims.Exp <= now || claims.Exp > now+120 || claims.Exp-claims.Iat > 120 || claims.Exp <= claims.Iat {
		return false
	}
	key, err := accessPublicKey(public)
	if err != nil {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		return false
	}
	hash := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	return ecdsa.Verify(key, hash[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

func bootstrapAuthorized(header string, secret *corev1.Secret) bool {
	if len(secret.Data["owner-public-key.pem"]) != 0 || !strings.HasPrefix(header, "Bootstrap ") {
		return false
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(header, "Bootstrap "))
	if err != nil || len(raw) != 32 {
		return false
	}
	sum := sha256.Sum256(raw)
	expected, err := hex.DecodeString(string(secret.Data["commitment"]))
	return err == nil && subtle.ConstantTimeCompare(sum[:], expected) == 1
}

func (m AccessManager) ServeHTTP(out http.ResponseWriter, in *http.Request) {
	out.Header().Set("Cache-Control", "no-store")
	out.Header().Set("Referrer-Policy", "no-referrer")
	out.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
	out.Header().Set("X-Content-Type-Options", "nosniff")
	if in.URL.Path == "/" && in.Method == http.MethodGet {
		out.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(out, "Nebula Confidential\nOpen confidential-client ui on your computer and paste this access link.\nKeep the #token private. This endpoint never accepts image or storage keys.\n")
		return
	}
	if in.URL.RawQuery != "" || (in.URL.Path != discoveryPath && in.URL.Path != discoveryPath+"/claim") {
		out.WriteHeader(404)
		return
	}
	ctx, cancel := context.WithTimeout(in.Context(), 10*time.Second)
	defer cancel()
	var workload *api.ConfidentialWorkload
	var config *AccessLink
	for _, namespace := range m.Namespaces {
		var list api.ConfidentialWorkloadList
		if err := m.Client.List(ctx, &list, client.InNamespace(namespace)); err != nil {
			out.WriteHeader(503)
			return
		}
		for i := range list.Items {
			candidate := &list.Items[i]
			a, err := accessLink(candidate)
			if err != nil || a == nil || !candidate.DeletionTimestamp.IsZero() {
				continue
			}
			u, _ := url.Parse(a.URL)
			if strings.EqualFold(u.Host, in.Host) {
				if workload != nil {
					out.WriteHeader(409)
					return
				}
				workload = candidate.DeepCopy()
				config = a
			}
		}
	}
	if workload == nil {
		out.WriteHeader(404)
		return
	}
	secret, err := m.secret(ctx, workload, config, false)
	if err != nil {
		out.WriteHeader(503)
		return
	}
	header := in.Header.Get("Authorization")
	owner := secret.Data["owner-public-key.pem"]
	ownerAuthorized := len(owner) > 0 && strings.HasPrefix(header, "Bearer ") && verifyAccessJWT(strings.TrimPrefix(header, "Bearer "), owner, config.URL)
	if in.URL.Path == discoveryPath+"/claim" && in.Method == http.MethodPost {
		if ownerAuthorized {
			out.WriteHeader(200)
			return
		}
		if !bootstrapAuthorized(header, secret) {
			out.WriteHeader(403)
			return
		}
		var value struct {
			PublicKey string `json:"ownerPublicKeyPem"`
			Proof     string `json:"proof"`
		}
		decoder := json.NewDecoder(io.LimitReader(in.Body, 8193))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&value) != nil || len(value.PublicKey) > 2048 || !verifyAccessJWT(value.Proof, []byte(value.PublicKey), config.URL) {
			out.WriteHeader(403)
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			out.WriteHeader(400)
			return
		}
		secret.Data["owner-public-key.pem"] = []byte(value.PublicKey)
		secret.Data["claimed-at"] = []byte(time.Now().UTC().Format(time.RFC3339))
		delete(secret.Data, "token")
		delete(secret.Data, "url")
		if err := m.Client.Update(ctx, secret); err != nil {
			out.WriteHeader(409)
			return
		}
		out.WriteHeader(200)
		return
	}
	if in.URL.Path != discoveryPath || in.Method != http.MethodGet {
		out.WriteHeader(405)
		return
	}
	if !ownerAuthorized && !bootstrapAuthorized(header, secret) {
		out.WriteHeader(403)
		return
	}
	clean, err := resolveAccess(workload, secret)
	if err != nil {
		out.WriteHeader(503)
		return
	}
	clean.ObjectMeta = metav1.ObjectMeta{Name: workload.Name, Namespace: workload.Namespace}
	clean.TypeMeta = metav1.TypeMeta{APIVersion: api.GroupVersion.String(), Kind: "ConfidentialWorkload"}
	clean.Status = api.Status{}
	var spec workloadRouting
	if json.Unmarshal(clean.Spec.Raw, &spec) != nil {
		out.WriteHeader(503)
		return
	}
	storages := []api.ConfidentialStorage{}
	seen := map[string]bool{}
	for _, binding := range spec.Storage {
		if seen[binding.Resource] {
			continue
		}
		seen[binding.Resource] = true
		var storage api.ConfidentialStorage
		if err := m.Client.Get(ctx, types.NamespacedName{Namespace: workload.Namespace, Name: binding.Resource}, &storage); err != nil {
			out.WriteHeader(503)
			return
		}
		storage.ObjectMeta = metav1.ObjectMeta{Name: storage.Name, Namespace: storage.Namespace}
		storage.TypeMeta = metav1.TypeMeta{APIVersion: api.GroupVersion.String(), Kind: "ConfidentialStorage"}
		storage.Status = api.Status{}
		storages = append(storages, storage)
	}
	u, _ := url.Parse(config.URL)
	connection := map[string]any{"version": 1, "endpoint": map[string]any{"host": u.Hostname(), "port": config.OwnerPort}, "workload": clean, "storages": storages}
	if config.VCEKCertificate != "" {
		connection["vcekCertificate"] = config.VCEKCertificate
	}
	out.Header().Set("Content-Type", "application/json")
	json.NewEncoder(out).Encode(map[string]any{"version": 1, "connection": connection, "status": workload.Status, "claimed": len(owner) > 0})
}
