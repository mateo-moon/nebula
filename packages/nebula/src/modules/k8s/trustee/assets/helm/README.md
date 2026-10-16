# Official Trustee chart with confidential deployment extensions

`trustee/` contains the official `deployment/helm-chart` from
https://github.com/confidential-containers/trustee at commit
`3e160008ef3e5d8ce82e59c729d56e2d0175dba0` (chart 0.21.0), with the changes in
`upstream.patch` including `templates/validate.yaml`. Upstream defaults are
preserved. The chart is bundled so package consumers render this exact source
without a separate chart-preparation step or a network fetch during synthesis.

The generic extensions add runtimeClass, sidecars, digest image references,
command/args, probe/security overrides, service targetPort, and explicit
disabling of chart-managed config/keys and separate AS/RVPS workloads. They let
Nebula run built-in AS/RVPS and TNG in one PodVM without Kubernetes-held keys.
These extensions are carried here pending upstream support; this is not an
assertion that the unextended official chart offers this mode.

Locked PostgreSQL and Valkey subcharts are included to preserve Helm dependency
validation and upstream defaults. Both are disabled in the confidential module.
The original chart license, templates, values, lockfile and documentation are
retained; upstream e2e scripts are not distributed in the npm package.

The provenance diff uses zero context (`git apply --unidiff-zero` against the
pinned source). Consumers use the bundled files directly.
