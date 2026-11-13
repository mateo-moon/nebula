# Bootstrap with OIDC

The self-managed AWS bootstrap uses `KubernetesOidcIdentity` to generate the
operator's sign-in kubeconfig from local inputs. It checks the identity against
the rendered management authenticator before creating cloud or cluster resources.
It never needs a registration ConfigMap from the new cluster.

## Shared identity

Use the same `KubernetesOidcIdentityConfig` for the control plane and the CLI.
For example, keep the policy in `management-oidc.json`:

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

Load this JSON in the deployment module and pass it as
`controlPlane.authentication.identity`. The cluster name must match
`config.aws.clusterName`. Keep any workload issuer and identity restrictions in
this shared policy too; the CLI checks the complete authenticator. Supply RBAC
through the module's `bootstrapManifests`; generating a profile grants no access.
See [OIDC module composition and RBAC](../nebula/src/modules/k8s/kubernetes-access/README.md).

Install `kubectl` and the `oidc-login` plugin for a public client. If the provider
requires a native/Desktop app credential, set
`workforce.login.clientAuthentication` to `"client-secret"` and install the
existing [`nebula-oidc-login` adapter](../../tools/oidc-login/README.md) instead.
Provide a local JSON file with exactly `issuer`, `client_id` and `client_secret`,
owned by the current user, mode 0400 or 0600, and at most 16 KiB. Its issuer and
client ID must match the identity policy. Keep
this registration outside source control; user tokens belong in the login cache.

## Run and sign in

```sh
nebula bootstrap --provider aws --gitops-dir ./aws \
  --oidc-config ./management-oidc.json

export KUBECONFIG="$HOME/.nebula/mgmt/kubeconfig-oidc"
kubectl auth whoami
kubectl get nodes
```

For native/Desktop credentials, add
`--oidc-client-config ~/.config/nebula/oidc/mgmt.json`, or use that default path.
`kubectl auth whoami` opens the provider sign-in flow when needed; subsequent
requests use the existing plugin's keyring cache and renewal. Bootstrap generates
the profile without signing in as the operator.

| Option | Input or default |
| --- | --- |
| `--oidc-config` | Local JSON `KubernetesOidcIdentityConfig`; required when the management render enables OIDC. |
| `--oidc-client-config` | Protected native registration JSON; defaults to `~/.config/nebula/oidc/<cluster>.json` in client-secret mode. |
| `--oidc-kubeconfig` | Output path; defaults to `~/.nebula/<cluster>/kubeconfig-oidc`. |
| `--oidc-ca-file` | Optional local PEM certificate bundle for the API endpoint; otherwise system trust. |

The sign-in profile contains an exec configuration, with no user token, client
certificate or private key. A native registration is referenced by absolute local
path; its app credential is not copied into the profile. Outputs use mode 0600.
An identical protected output can be reused; other existing files are refused.

Bootstrap continues to use and retain `~/.nebula/<cluster>/kubeconfig` for its
internal administration and handoff. These options do not revoke credentials
or change pause policy. This handoff integration applies to the self-managed AWS
provider; the GCP/GKE bootstrap does not accept these options.
