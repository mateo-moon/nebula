# Gitea branch protection

`GiteaBranchProtection` reconciles one branch-protection rule through the existing
Crossplane HTTP provider. It observes and patches an existing rule, or posts a
missing rule. The API token is read from a Kubernetes Secret by provider-http;
the token value is never embedded in the Request manifest.

```ts
new GiteaBranchProtection(chart, "infrastructure-main", {
  origin: "https://git.example.com",
  owner: "platform",
  repository: "infrastructure",
  branch: "main",
  rule: {
    enable_push: false,
    enable_force_push: false,
    enable_status_check: true,
    status_check_contexts: ["render", "tests"],
    block_on_outdated_branch: true,
    block_admin_merge_override: true,
  },
  tokenSecretRef: { name: "repository-admin", namespace: "crossplane-system", key: "token" },
  httpProviderConfigName: "repository-http",
});
```

Supply a token authorized to administer the selected repository. Install
provider-http and the named ProviderConfig separately. The declaration manages
only the supplied fields; API metadata and unspecified settings are ignored.
Checks include false and empty values, and list order is immaterial.

Deletion is orphaned, management policies exclude Delete, and no REMOVE mapping
exists. Deleting the Kubernetes declaration cannot remove repository protection.
Changing its branch or repository creates another retained rule rather than
deleting the old rule.

The implementation follows Gitea's [branch-protection PATCH API](https://docs.gitea.com/api/next/operations/repo-edit-branch-protection/)
and [provider-http Request mappings](https://github.com/crossplane-contrib/provider-http/tree/v1.0.14/examples).
