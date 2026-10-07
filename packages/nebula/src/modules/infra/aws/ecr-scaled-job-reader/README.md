# ECR credentials for a selected runner job

`addAwsEcrScaledJobReader(scope, scaledJob, config)` attaches the existing
per-job credential exchange to a generated KEDA `ScaledJob`. It creates a named
ServiceAccount and ConfigMap and adds two init containers to that job. It does
not create a job, timer, credential relay, IAM role or ECR repository.

The caller supplies account, region, namespace, service-account and role names,
the code ConfigMap name, role-session name, error label and read-only credential
path. Use `registryReaderRunnerConfig({ credentialsPath, environmentVariable })`
for the matching act_runner config fragment. The opt-in environment key keeps
the runner's ordinary writable Docker configuration separate.

The existing job must have `fsGroup: 1000`, volumes and first-container mounts,
an explicit deadline and no existing init containers or colliding registry
volume names. The default four-hour minimum credential lifetime supports a
three-hour job deadline; a custom `minimumCredentialLifetimeSeconds` must leave
at least one hour beyond the deadline and cannot exceed ECR's twelve hours.

The token container receives only a projected JWT and performs one explicit
unsigned STS WebIdentity exchange, then requests an ECR token with those
temporary credentials. Raw JWT/STS credentials are never mounted into the
runner or printed on failures. The next container rejects a wrong endpoint,
multiple authorization records, insufficient lifetime and malformed credentials
before writing the single-registry Docker config. The runner gets only that
directory, read-only. Both init containers run as UID/GID 1000 with a read-only
root filesystem and no Linux capabilities; the two working memory volumes
remain 2 MiB each. Pinned tool images and the existing resource requests/limits
are preserved; callers can supply different immutable image digests explicitly.

Moving an existing implementation to this helper can preserve every rendered
resource, script byte and checksum by passing its current names and paths.
There is no change to job count, scheduling, per-job AWS calls or capacity.
