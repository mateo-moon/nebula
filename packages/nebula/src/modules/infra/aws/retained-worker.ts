/** Bind a replacement native AWSMachine to an existing named address/data disk.
 * Missing or ambiguous bindings fail bootstrap. No resources are allocated. */
export function awsRetainedWorkerCommands(config: {
  region: string;
  eipName: string;
  dataVolumeName?: string;
  volumeGroup?: string;
  sshPublicKey?: string;
}): string[] {
  for (const value of [config.region, config.eipName, config.dataVolumeName, config.volumeGroup].filter(Boolean)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value!)) throw new Error("invalid retained worker binding");
  }
  if (Boolean(config.dataVolumeName) !== Boolean(config.volumeGroup)) throw new Error("retained disk requires its existing volume group");
  if (config.sshPublicKey && !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [a-zA-Z0-9._-]+)?$/.test(config.sshPublicKey)) throw new Error("invalid worker SSH key");
  const script = `set -eu
export DEBIAN_FRONTEND=noninteractive
retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -lt 90 ] || return 1; sleep 10; done; }
retry apt-get update -qq
retry apt-get install -y -qq --no-install-recommends awscli${config.dataVolumeName ? " lvm2" : ""}
TOKEN=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
IID=$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
EIP=$(aws ec2 describe-addresses --region ${config.region} --filters Name=tag:Name,Values=${config.eipName} --query 'Addresses[].AllocationId' --output text)
set -- $EIP
[ "$#" -eq 1 ] && [ "$1" != None ] || { echo 'Expected exactly one retained worker address' >&2; exit 1; }
retry aws ec2 associate-address --region ${config.region} --allocation-id "$EIP" --instance-id "$IID" --allow-reassociation
retry aws ec2 modify-instance-attribute --region ${config.region} --instance-id "$IID" --no-source-dest-check
${config.sshPublicKey ? `install -d -m 700 -o admin -g admin /home/admin/.ssh
printf '%s\\n' '${config.sshPublicKey}' >> /home/admin/.ssh/authorized_keys
chown admin:admin /home/admin/.ssh/authorized_keys
chmod 600 /home/admin/.ssh/authorized_keys` : ""}
${config.dataVolumeName ? `VOL=$(aws ec2 describe-volumes --region ${config.region} --filters Name=tag:Name,Values=${config.dataVolumeName} --query 'Volumes[].VolumeId' --output text)
set -- $VOL
[ "$#" -eq 1 ] && [ "$1" != None ] || { echo 'Expected exactly one retained data disk' >&2; exit 1; }
attached() {
  STATE=$(aws ec2 describe-volumes --region ${config.region} --volume-ids "$VOL" --query "Volumes[0].Attachments[?InstanceId=='$IID'].State | [0]" --output text)
  [ "$STATE" = attached ] && return 0
  [ "$STATE" != None ] || aws ec2 attach-volume --region ${config.region} --instance-id "$IID" --volume-id "$VOL" --device /dev/sdf >/dev/null
  return 1
}
retry attached
retry aws ec2 modify-instance-attribute --region ${config.region} --instance-id "$IID" --block-device-mappings '[{"DeviceName":"/dev/sdf","Ebs":{"DeleteOnTermination":false}}]'
SERIAL=$(printf '%s' "$VOL" | tr -d '-')
ROOT=$(findmnt -no SOURCE /)
ROOT_DISK=/dev/$(lsblk -no PKNAME "$ROOT")
find_disk() {
  DEV=$(lsblk -dnpo NAME,SERIAL | awk -v serial="$SERIAL" '$2==serial{print $1}')
  [ -n "$DEV" ] && [ "$(printf '%s\\n' "$DEV" | wc -l)" -eq 1 ] && [ "$DEV" != "$ROOT_DISK" ]
}
retry find_disk
[ "$(pvs --noheadings -o vg_name "$DEV" | xargs)" = ${config.volumeGroup} ] || { echo 'Retained disk has an unexpected volume group' >&2; exit 1; }
[ "$(vgs --noheadings -o pv_count ${config.volumeGroup} | xargs)" = 1 ] || { echo 'Expected volume group spans other disks' >&2; exit 1; }
vgchange -ay ${config.volumeGroup}
pvresize "$DEV"
printf '#!/bin/sh\\nset -eu\\nSERIAL=%s\\n' "$SERIAL" > /usr/local/bin/pvresize-all
cat >> /usr/local/bin/pvresize-all <<'PVEOF'
DEV=$(lsblk -dnpo NAME,SERIAL | awk -v serial="$SERIAL" '$2==serial{print $1}')
[ -n "$DEV" ] && [ "$(printf '%s\\n' "$DEV" | wc -l)" -eq 1 ]
[ "$(pvs --noheadings -o vg_name "$DEV" | xargs)" = '${config.volumeGroup}' ]
pvresize "$DEV"
PVEOF
chmod +x /usr/local/bin/pvresize-all
cat > /etc/systemd/system/pvresize.service <<'PVEOF'
[Unit]
Description=resize the retained worker EBS physical volume
[Service]
Type=oneshot
ExecStart=/usr/local/bin/pvresize-all
PVEOF
cat > /etc/systemd/system/pvresize.timer <<'PVEOF'
[Unit]
Description=periodic EBS physical volume resize
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
[Install]
WantedBy=timers.target
PVEOF
systemctl daemon-reload
systemctl enable --now pvresize.timer` : ""}
`;
  return [`sh -ec '${script.replace(/'/g, "'\\''")}'`];
}
