# OIDC login with protected client input

`nebula-oidc-login` adds protected credential-file input to
int128/kubelogin **v1.36.4**, upstream commit
`4d0d2336a02cd9be2aee3a25e495a2478a423c74`. It calls the exported
`di.NewCmdForHeadless(...).Run` entry point in process. Upstream handles OAuth,
PKCE, nonce checking, ID-token verification, token storage and refresh.

Use this adapter with an OIDC provider whose authorization-code flow requires
an app credential. Provider registration and human identity policy are configured
by the caller.

## Configuration

Install the adapter on a Linux or macOS client. The kubeconfig contains public
metadata and a local file reference:

```yaml
exec:
  apiVersion: client.authentication.k8s.io/v1
  command: nebula-oidc-login
  interactiveMode: IfAvailable
  args:
    - get-token
    - --oidc-issuer-url=https://issuer.example.test
    - --oidc-client-id=example-client
    - --oidc-client-secret-file=~/.config/nebula/oidc/example.json
    - --grant-type=authcode
    - --oidc-pkce-method=S256
    - --oidc-extra-scope=email
    - --token-cache-storage=keyring
```

Provision a JSON file containing `issuer`, `client_id` and `client_secret`, with
an optional integer `expires_unix`. Issuer and client ID must exactly match the
public arguments. The file must be regular, owned by the effective user, mode
0600 or 0400, at most 16 KiB, and not a symlink. Invalid or expired input fails
before the browser opens. An expiry also bounds the running request.

Provider-specific scopes and authorization hints use the upstream
`--oidc-extra-scope` and `--oidc-auth-request-extra-params` options. A headless
client can use `--skip-open-browser` and an SSH-forwarded loopback callback.

## Credential handling

The credential enters an in-memory argument slice passed to Cobra's `SetArgs`.
Process arguments, the environment and the public kubeconfig contain only its
file reference. The adapter runs upstream code in process without spawning a
kubelogin subprocess.

Token caches use upstream storage and locking. A repository adapter hashes the
complete cache identity using canonical JSON, avoiding unordered-map cache
misses with multiple authorization hints in the pinned upstream version.
Changing an app credential changes its cache identity.

Only `get-token` and `version` are exposed. S256/authcode are enforced;
access-token mode, TLS bypass and protocol overrides are rejected. Logs contain
a loopback browser link or a bounded error category. Verbose HTTP/token dumps
are disabled; standard output carries ExecCredential JSON. These controls do
not erase credentials from process memory.

## Build and verify

Use the Go version declared in `go.mod` or later. Dependencies are pinned in
`go.mod` and `go.sum`.

```sh
go mod verify
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -buildvcs=false -o nebula-oidc-login .
```

Local TLS/OAuth fixtures exercise the actual upstream code exchange, S256,
cache use, refresh, protected-file checks and output safety. Linux tests also
inspect `/proc/self/cmdline` during exchange. All credentials are synthetic.

References: [upstream CLI](https://github.com/int128/kubelogin/blob/v1.36.4/pkg/cmd/cmd.go),
[dependency injection](https://github.com/int128/kubelogin/blob/v1.36.4/pkg/di/wire_gen.go).
