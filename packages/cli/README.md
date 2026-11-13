# Sign-in kubeconfig for an OIDC cluster

`nebula oidc-kubeconfig` writes an operator's sign-in kubeconfig from local
inputs, using the same `KubernetesOidcIdentity` module that renders the
control-plane authenticator. It contacts no cluster, so it works before the
first login, on a new machine, and when no administrator kubeconfig is at hand.

Bootstrap is unchanged: it still writes `~/.nebula/<cluster>/kubeconfig` for
administration. Create the sign-in profile at any time; signing in works once
the cluster's API endpoint for OIDC users is reachable.

## Identity

The command takes the cluster's `KubernetesOidcIdentityConfig` as JSON:

```json
{
  "cluster": "mgmt",
  "hostname": "api.management.example.test",
  "workforce": {
    "url": "https://identity.example.test",
    "jwksUrl": "https://identity.example.test/keys",
    "audience": "management-desktop-client",
    "emailDomain": "example.test",
    "groups": ["access:operators"],
    "login": {
      "grantType": "authcode",
      "extraScopes": ["email"],
      "clientAuthentication": "none"
    }
  }
}
```

Keep one definition of the identity. If the deployment defines it in TypeScript,
print it and pipe it in; no second copy is needed:

```sh
npx tsx -e 'import { identity } from "./access"; console.log(JSON.stringify(identity))' \
  | nebula oidc-kubeconfig --config -
```

If the deployment loads it from a JSON file, pass that file with `--config`.

## Run and sign in

```sh
nebula oidc-kubeconfig --config ./management-oidc.json

export KUBECONFIG="$HOME/.nebula/mgmt/kubeconfig-oidc"
kubectl auth whoami
```

`kubectl auth whoami` opens the provider sign-in flow when needed; later requests
use the login plugin's keyring cache and renewal. The command itself never signs in.

A public client needs `kubectl` and its `oidc-login` plugin. If the provider
requires a native/Desktop app credential, set
`workforce.login.clientAuthentication` to `"client-secret"` and install the
[`nebula-oidc-login` adapter](../../tools/oidc-login/README.md) instead. Provide
a local JSON file with exactly `issuer`, `client_id` and `client_secret`, owned
by the current user, mode 0400 or 0600, and at most 16 KiB. Its issuer and client
ID must match the identity. Keep this registration outside source control.

| Option | Input or default |
| --- | --- |
| `--config` | Local JSON `KubernetesOidcIdentityConfig`, or `-` for standard input. Required. |
| `--client-config` | Protected native registration JSON; defaults to `~/.config/nebula/oidc/<cluster>.json` in client-secret mode. |
| `--output` | Output path; defaults to `~/.nebula/<cluster>/kubeconfig-oidc`. |
| `--ca-file` | Optional local PEM certificate bundle for the API endpoint; otherwise system trust. |
| `--rendered` | Directory of synthesized manifests. The command fails unless the identity produces exactly the authentication configuration of that cluster's rendered control plane. |

## Checking against a render

`--rendered` guards against handing out a profile for an identity the control
plane does not enforce. Point it at the synthesized output of the module that
declares the cluster:

```sh
nebula oidc-kubeconfig --config ./management-oidc.json --rendered ./dist
```

## What is written

The profile contains an exec configuration, with no user token, client
certificate or private key. A native registration is referenced by absolute local
path; its app credential is not copied into the profile. The output uses mode
0600. An identical protected output is reused; any other existing file is
refused, so an administrator kubeconfig or another profile is never replaced.
Generating a profile grants no access: RBAC comes from the cluster.

# Rendering a repository and comparing renders

`nebula render-tree` renders every `index.ts` entry of one or more repository
trees, and every plugin Application those renders declare, using the init and
generate scripts of the tree's own Argo CD ConfigManagementPlugin. It runs with
tool locations and the extras you state, never the caller's credentials.

`nebula render-diff` compares two such outputs object by object. Differences
are informational. It fails when an entry does not render, or a golden digest
does not hold at head.

```sh
nebula render-tree --plugin-entry infra/meta/argocd --entries infra \
  --side ./base:./out/base:"$BASE_SHA" --side ./head:./out/head:"$HEAD_SHA"
nebula render-diff --base ./out/base --head ./out/head
```

| `render-tree` option | Meaning |
| --- | --- |
| `--side ROOT:OUT:REVISION` | A tree, its output directory and the revision to report. Repeat per tree. |
| `--entries DIR` | Directory under each root to search for entries; default the root. Repeatable. |
| `--plugin FILE` / `--plugin-entry DIR` | The plugin file, or the entry that renders its ConfigMap. One is required. |
| `--env NAME=VALUE` | Extra environment for every render, for example public fixtures. Repeatable. |
| `--allow-plugin-env NAME` | Plugin environment variable Applications may set besides `ENTRY_FILE`. Repeatable. |
| `--bin DIR`, `--image-env FILE`, `--registry-config DIR`, `--jobs N` | Tool directory, the renderer image's environment, a read-only registry config and concurrency. |

A repository that depends on `nebula-cdk8s` can run the same code without the CLI:

```sh
node --import tsx node_modules/nebula-cdk8s/src/tools/render.ts tree --side ...
node --import tsx node_modules/nebula-cdk8s/src/tools/render.ts diff --base ... --head ...
```

| `render-diff` option | Meaning |
| --- | --- |
| `--goldens FILE` | JSON of entry key to digests that must hold at head. |
| `--volatile FILE` | Lines of `<entry> <apiVersion> <kind> <namespace>/<name> <json pointer>` for fields generated anew by every render; compared as present or absent only. |
| `--unrendered FILE` | Entry keys that may stay uncompared while they already fail at base. |
