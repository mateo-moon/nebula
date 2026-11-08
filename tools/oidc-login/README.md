# Protected OIDC client credential input

`nebula-oidc-login` adds a protected local credential-file input to
int128/kubelogin **v1.36.4**, upstream commit
`4d0d2336a02cd9be2aee3a25e495a2478a423c74`. It imports the upstream exported
`di.NewCmdForHeadless(...).Run` entry point. OAuth, PKCE, nonce checking, ID token
verification, caching/keyring storage and refresh remain upstream behavior.
There is no token broker or alternative issuer.

Google's Desktop token endpoint has rejected an actual secretless PKCE exchange
with `client_secret is missing`, despite optional wording in its Desktop guide.
Keep the registered Desktop client ID, S256 and human Google identity. Supply that
client's own app credential locally; do not reuse a confidential web client.
The credential alone does not authenticate a Kubernetes user. Kubernetes still
requires the signed issuer/audience/domain/authorized-party claims and RBAC.

## Public configuration and protected input

Build/install the adapter on a trusted Linux or macOS client. Normal kubeconfigs
contain only public metadata and a reference such as:

```yaml
exec:
  apiVersion: client.authentication.k8s.io/v1
  command: nebula-oidc-login
  interactiveMode: IfAvailable
  args:
    - get-token
    - --oidc-issuer-url=https://accounts.google.com
    - --oidc-client-id=example-desktop-client-id
    - --oidc-client-secret-file=~/.config/nebula/oidc/example.json
    - --grant-type=authcode
    - --oidc-pkce-method=S256
    - --oidc-extra-scope=email
    - --oidc-auth-request-extra-params=access_type=offline
    - --oidc-auth-request-extra-params=prompt=consent
    - --oidc-auth-request-extra-params=hd=example.test
    - --token-cache-storage=keyring
```

Provision the file through an approved protected input mechanism on the trusted
client. Its JSON fields are `issuer`, `client_id`, `client_secret`, optional
`epoch`, and optional integer `expires_unix`. This is an input record, not a
Google web-client JSON document. The issuer and client must exactly match the
public arguments. The file must be regular, owned by the effective user, mode
0600 or 0400, at most 16 KiB, and not a symlink. Missing, mismatched, malformed or
expired input fails before the browser opens. An expiry also bounds the running
login request. `epoch` is optional public cleanup metadata.

The loader passes the value only to an in-memory upstream argument slice.
Cobra's `SetArgs` does not modify `os.Args` or OS argv. It launches no kubelogin
subprocess and exports no credential environment variable. The cache contains
user ID/refresh tokens. A small repository-interface adapter hashes the complete
original key using canonical JSON, avoiding v1.36.4's unordered-map/gob key
instability with multiple authorization hints. It reuses upstream storage,
locking and keyring behavior. The app credential contributes to the hash and
never enters a cache filename in plaintext. Rotating it changes the cache identity.

Only `get-token` and the adapter's `version` command are exposed. S256/authcode
are enforced, access-token mode/TLS bypass and protocol overrides are rejected.
Verbose HTTP/token dumps are disabled. Logs emit only a safe local browser link
or a bounded error category; raw provider errors and token responses are not
printed. Standard output is reserved for upstream ExecCredential JSON. This
does not promise secret erasure from process memory.

Native application registration may be stored durably by the
`KubernetesOidcClientConfiguration` ConfigMap construct. Export only its three
validated registration fields into the owner-only local input format. The local
file restrictions still provide integrity and issuer/client binding. User
ID/access/refresh tokens never belong in that ConfigMap; upstream token
cache/keyring behavior remains unchanged.

For a headless trusted host, use the existing loopback/SSH callback approach and
`--skip-open-browser`. Root-only tmpfs and an expiring input record are suitable
for temporary qualification. Keep application values out of command lines and
shell history. Confidential web-client secrets must not use the native
ConfigMap path. App-credential rotation follows the
provider and operator's accepted policy. Actual provider login and refresh remain
acceptance checks.

## Build and verify

The recorded qualification toolchain is Go **1.27.1**. `go.mod`/`go.sum` pin the
upstream module and dependencies. A trusted host should fetch official,
checksummed Go and module sources and independently rebuild the reviewed source.
Do not use an executable built on an untrusted workstation with real credentials.

```sh
go mod verify
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -buildvcs=false -o nebula-oidc-login .
```

Tests use disposable local TLS/OAuth fixtures. They exercise real upstream code
exchange, S256, cache use, refresh, expiry/ownership/file checks and output safety.
On Linux they inspect `/proc/self/cmdline` during exchange to verify no app
credential enters OS argv. No real Google credential, user account, kubeconfig or
deployed cluster is used. A foreign-owner fixture also runs when tests execute as
root; normal test runs remain unprivileged.

References: [upstream CLI entry point](https://github.com/int128/kubelogin/blob/v1.36.4/pkg/cmd/cmd.go),
[upstream dependency injection](https://github.com/int128/kubelogin/blob/v1.36.4/pkg/di/wire_gen.go),
[Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
and [Google client credential visibility/rotation](https://support.google.com/cloud/answer/15549257?hl=en-GB).
