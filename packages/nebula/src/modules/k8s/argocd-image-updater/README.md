# Argo CD image update policies

`ArgocdImageUpdater` installs the controller. To declare a digest policy for one
plugin-rendered Application, use `configureArgocdPluginImageUpdate(scope, id,
config)` with an exact Application name, policy name, image repository, tracking
tag, alias and CMP environment variable (`image.pluginSpec`).

The helper emits one ImageUpdater, a Role limited to patch/update of that exact
Application, and its RoleBinding. Defaults preserve the existing controller
service-account name and `argocd` namespace, wave 7 and `linux/amd64` platform;
each is configurable. It selects the digest update strategy and Argo writeback.
Application wildcards are rejected because they do not match the scoped grant.

Install the controller and CRD separately. This helper does not add a controller,
poll schedule or registry credentials. A deployment can retain its existing
policy and RBAC names and render the same resources while moving their generic
construction here.
