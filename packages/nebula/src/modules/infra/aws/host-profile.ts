/** Host settings belong to an explicitly selected AMI, never a fleet default. */
export interface AwsHostProfile {
  architecture: "amd64" | "arm64";
  sshUser: string;
  rootDeviceName: "/dev/sda1" | "/dev/xvda";
  useSudo?: boolean;
  debian?: {
    suite: string;
    /** Debian package version, not the uname release or installed metapackage. */
    minimumKernelVersion: string;
    requireSsmAgent?: boolean;
  };
}

const fail = (message: string): never => { throw new Error(`AWS host profile: ${message}`); };
export function validateAwsHostProfile(profile?: AwsHostProfile): void {
  if (profile === undefined) return;
  if (!profile || typeof profile !== "object") fail("expected an object");
  if (!["amd64", "arm64"].includes(profile.architecture)) fail("invalid architecture");
  if (typeof profile.sshUser !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(profile.sshUser)) fail("invalid SSH user");
  if (!["/dev/sda1", "/dev/xvda"].includes(profile.rootDeviceName)) fail("invalid root device");
  if (profile.useSudo !== undefined && typeof profile.useSudo !== "boolean") fail("invalid sudo setting");
  const debian = profile.debian;
  if (debian === undefined) return;
  if (!debian || typeof debian !== "object") fail("invalid Debian policy");
  if (typeof debian.suite !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(debian.suite)) fail("invalid Debian suite");
  if (typeof debian.minimumKernelVersion !== "string" || debian.minimumKernelVersion.length > 128
    || !/^(?:[0-9]+:)?[0-9][A-Za-z0-9.+~]*(?:-[A-Za-z0-9.+~]+)?$/.test(debian.minimumKernelVersion)) fail("invalid minimum kernel package version");
  if (debian.requireSsmAgent !== undefined && typeof debian.requireSsmAgent !== "boolean") fail("invalid SSM setting");
}

const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

/** Read-only enrollment gate. Updating a metapackage cannot satisfy a boot check. */
export function awsHostPreK0sCommands(profile?: AwsHostProfile): string[] {
  validateAwsHostProfile(profile);
  if (!profile?.debian) return [];
  const { debian } = profile;
  const script = `set -eu
. /etc/os-release
[ "\${ID:-}" = debian ] && [ "\${VERSION_CODENAME:-}" = ${quote(debian.suite)} ] || {
  echo 'Host does not match the selected Debian suite' >&2; exit 1;
}
[ "$(dpkg --print-architecture)" = ${quote(profile.architecture)} ] || {
  echo 'Host architecture does not match the selected image' >&2; exit 1;
}
kernel_package="linux-image-$(uname -r)"
kernel_state=$(dpkg-query -W '-f=\${db:Status-Status} \${Version}' "$kernel_package")
set -- $kernel_state
[ "$#" = 2 ] && [ "$1" = installed ] || {
  echo 'Running kernel package is not installed' >&2; exit 1;
}
dpkg --compare-versions "$2" ge ${quote(debian.minimumKernelVersion)} || {
  echo 'Running kernel package is below the required minimum' >&2; exit 1;
}
${debian.requireSsmAgent ? `systemctl is-enabled --quiet amazon-ssm-agent
systemctl is-active --quiet amazon-ssm-agent
` : ""}`;
  return ["/bin/sh -eu -c " + quote(script)];
}

/** Use the AMI account's actual home and primary group. Called only on opt-in. */
export function awsHostSshKeySetup(profile: AwsHostProfile, publicKey: string): string {
  validateAwsHostProfile(profile);
  return `login_user=${quote(profile.sshUser)}
login_home=$(getent passwd "$login_user" | cut -d: -f6)
case "$login_home" in /*) ;; *) echo 'Image login account is missing' >&2; exit 1;; esac
[ "$login_home" != / ] && [ -d "$login_home" ] || exit 1
login_group=$(id -gn "$login_user")
install -d -m 700 -o "$login_user" -g "$login_group" "$login_home/.ssh"
cat >> "$login_home/.ssh/authorized_keys" <<'KEYEOF'
${publicKey}
KEYEOF
chown "$login_user:$login_group" "$login_home/.ssh/authorized_keys"
chmod 600 "$login_home/.ssh/authorized_keys"
`;
}
