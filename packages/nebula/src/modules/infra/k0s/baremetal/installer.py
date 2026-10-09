"""Render a private Debian Installer initramfs for SSH-only OS replacement."""

import ipaddress
import re
import secrets
import shlex

from models import DiskPolicy, JsonObject, Receipt, WorkerSpec
from runtime import ProvisioningError, canonical
from runtime import fingerprint as fingerprint
from validation import validate_spec


def select_disk(disks: list[JsonObject], root_disks: set[str], policy: DiskPolicy) -> JsonObject:
    eligible = [d for d in disks if d.get("type") == "disk" and not d.get("ro") and not d.get("rm")]
    if policy.get("serial"):
        eligible = [d for d in eligible if (d.get("serial") or "").strip() == policy["serial"]]
    else:
        eligible = [d for d in eligible if d["path"] in root_disks]
    if len(eligible) != 1:
        raise ProvisioningError(
            "root disk is ambiguous; configure an exact disk serial in the installation profile"
        )
    disk = eligible[0]
    if int(disk["size"]) < policy["minSizeGiB"] * 1024**3:
        raise ProvisioningError("selected disk is below the minimum size")
    return disk


def validate_volume_groups(
    selected_disk: str, volume_groups: dict[str, set[str]], requested_name: str
) -> None:
    for name, disks in volume_groups.items():
        if selected_disk in disks and disks != {selected_disk}:
            raise ProvisioningError(
                "selected disk shares an LVM group with another disk; refusing to dismantle it"
            )
        if name == requested_name and disks != {selected_disk}:
            raise ProvisioningError("requested volume group already exists on another disk")


def network_config(facts: JsonObject) -> str:
    network = facts["network"]
    lines = [
        "[Match]",
        "MACAddress=" + network["mac"],
        "",
        "[Network]",
        "DHCP=no",
        "IPv6AcceptRA=no",
        "LinkLocalAddressing=ipv6",
    ]
    for address in network["addresses"]:
        lines.append("Address=" + str(ipaddress.ip_interface(address)))
    for address in network["dns"]:
        lines.append("DNS=" + str(ipaddress.ip_address(address)))
    for route in network["routes"]:
        lines.extend(
            [
                "",
                "[Route]",
                "Destination=" + route["destination"],
                "Gateway=" + route["gateway"],
                "GatewayOnLink=yes",
            ]
        )
    return "\n".join(lines) + "\n"


def workload_volume_script(spec: WorkerSpec, facts: JsonObject) -> str:
    """Add only the extra erased disks to the installed OS's existing VG."""
    expected = spec["installation"]["disk"].get("workloadSerials", [])
    disks = facts.get("workloadDisks", [])
    if len(disks) != len(expected) or {disk["serial"] for disk in disks} != set(expected):
        raise ProvisioningError("workload disk discovery differs from the declared serials")
    lines = []
    for disk in disks:
        lines.extend(
            [
                "disk=$(readlink -f " + shlex.quote(disk["byId"]) + ")",
                '[ -b "$disk" ]',
                '[ "$(blockdev --getsize64 "$disk")" -eq ' + str(int(disk["size"])) + " ]",
                'in-target pvcreate --yes "$disk"',
                "in-target vgextend "
                + shlex.quote(spec["installation"]["volumeGroup"])
                + ' "$disk"',
            ]
        )
    return "\n".join(lines) + "\n"


def render_files(
    spec: WorkerSpec, facts: JsonObject, worker_public_key: str, receipt: Receipt
) -> dict[str, bytes]:
    validate_spec(spec)
    if not re.fullmatch(
        r"(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?",
        worker_public_key.strip(),
    ):
        raise ProvisioningError("worker key must be an OpenSSH public key")
    installation, network = spec["installation"], facts["network"]
    v4 = next(
        ipaddress.ip_interface(a)
        for a in network["addresses"]
        if ipaddress.ip_interface(a).version == 4
    )
    gateway = next(r["gateway"] for r in network["routes"] if r["destination"] == "0.0.0.0/0")
    if not any(ipaddress.ip_address(dns).version == 4 for dns in network["dns"]):
        raise ProvisioningError("the installer needs at least one IPv4 DNS resolver")
    if ipaddress.ip_address(gateway) not in v4.network:
        raise ProvisioningError(
            "installer netcfg requires an on-link IPv4 gateway; off-link routes need a qualified installer profile"
        )
    boot = (
        "538 538 538 free $iflabel{ gpt } $reusemethod{ } method{ efi } format{ } . "
        if facts["uefi"]
        else "1 1 1 free $iflabel{ gpt } method{ biosgrub } . "
    )
    # partman recipe sizes are decimal MB, while the public profile uses GiB.
    root_mb = (installation["rootSizeGiB"] * 1024**3 + 999999) // 1000000
    recipe = (
        "nebula :: "
        + boot
        + "1024 1024 1024 ext4 $primary{ } method{ format } format{ } use_filesystem{ } filesystem{ ext4 } mountpoint{ /boot } . "
        + f"{root_mb} {root_mb} {root_mb} ext4 $lvmok{{ }} lv_name{{ root }} method{{ format }} format{{ }} use_filesystem{{ }} filesystem{{ ext4 }} mountpoint{{ / }} ."
    )
    # Initramfs is private and stays on this host. Debian hashes this one-time
    # random password; late setup replaces it and disables password SSH.
    root_password = secrets.token_urlsafe(48)
    entries = {
        "debian-installer/locale string": "en_US.UTF-8",
        "keyboard-configuration/xkb-keymap select": "us",
        "netcfg/disable_autoconfig boolean": "true",
        "netcfg/get_ipaddress string": str(v4.ip),
        "netcfg/get_netmask string": str(v4.netmask),
        "netcfg/get_gateway string": gateway,
        "netcfg/get_nameservers string": " ".join(network["dns"]),
        "netcfg/confirm_static boolean": "true",
        "netcfg/get_hostname string": spec["hostname"],
        "netcfg/hostname string": spec["hostname"],
        "netcfg/get_domain string": "local",
        "mirror/country string": "manual",
        "mirror/http/hostname string": installation["mirror"]["hostname"],
        "mirror/http/directory string": installation["mirror"]["directory"],
        "mirror/http/proxy string": "",
        "mirror/suite string": installation["suite"],
        "passwd/root-login boolean": "true",
        "passwd/root-password password": root_password,
        "passwd/root-password-again password": root_password,
        "passwd/make-user boolean": "false",
        "clock-setup/utc boolean": "true",
        "time/zone string": "UTC",
        "partman-auto/method string": "lvm",
        "partman-auto-lvm/new_vg_name string": installation["volumeGroup"],
        # With "max", partman explicitly gives the final LV every free extent,
        # even when its recipe has a maximum. Bound allocated space in the VG.
        "partman-auto-lvm/guided_size string": f"{root_mb} MB",
        "partman-auto/expert_recipe string": recipe,
        "partman-auto/choose_recipe select": "nebula",
        "partman-partitioning/default_label string": "gpt",
        "partman-partitioning/choose_label select": "gpt",
        "partman-lvm/device_remove_lvm boolean": "true",
        "partman-lvm/confirm boolean": "true",
        "partman-lvm/confirm_nooverwrite boolean": "true",
        "partman/confirm_write_new_label boolean": "true",
        "partman-partitioning/confirm_write_new_label boolean": "true",
        "partman/choose_partition select": "finish",
        "partman/confirm boolean": "true",
        "partman/confirm_nooverwrite boolean": "true",
        "partman-basicfilesystems/no_swap boolean": "false",
        "base-installer/install-recommends boolean": "false",
        "pkgsel/include string": "openssh-server ca-certificates curl lvm2 python3 systemd-resolved",
        "pkgsel/upgrade select": "none",
        "grub-installer/only_debian boolean": "true",
        "grub-installer/with_other_os boolean": "true",
        "grub-installer/force-efi-extra-removable boolean": "true",
        "finish-install/reboot_in_progress note": "",
        "preseed/early_command string": "/bin/sh /nebula/early.sh",
        "partman/early_command string": "/bin/sh /nebula/disk.sh",
        "preseed/late_command string": "/bin/sh /nebula/late.sh",
    }
    preseed = "\n".join(f"d-i {key} {value}" for key, value in entries.items())
    preseed += "\ntasksel tasksel/first multiselect\npopularity-contest popularity-contest/participate boolean false\n"
    early = f"""set -eu
iface=''
for p in /sys/class/net/*; do
  if [ "$(cat "$p/address")" = {shlex.quote(network["mac"])} ]; then iface=${{p##*/}}; fi
done
[ -n "$iface" ]
debconf-set netcfg/choose_interface "$iface"
"""
    disk = f"""set -eu
disk=$(readlink -f {shlex.quote(facts["disk"]["byId"])})
[ -b "$disk" ]
[ "$(blockdev --getsize64 "$disk")" -ge {installation["disk"]["minSizeGiB"] * 1024**3} ]
debconf-set partman-auto/disk "$disk"
debconf-set grub-installer/bootdev "$disk"
"""
    late = (
        "set -eu\n"
        + workload_volume_script(spec, facts)
        + """
install -d -m 0700 /target/root/.ssh /target/var/lib/nebula-baremetal
cp /nebula/authorized_keys /target/root/.ssh/authorized_keys
chmod 0600 /target/root/.ssh/authorized_keys
# Keep the server keys authenticated by the original SSH session.
cp /nebula/hostkeys/* /target/etc/ssh/
chmod 0600 /target/etc/ssh/ssh_host_*_key
mkdir -p /target/etc/ssh/sshd_config.d /target/etc/systemd/network
cp /nebula/sshd.conf /target/etc/ssh/sshd_config.d/00-nebula.conf
cp /nebula/uplink.network /target/etc/systemd/network/10-nebula.network
chmod 0644 /target/etc/systemd/network/10-nebula.network
printf 'auto lo\niface lo inet loopback\n' > /target/etc/network/interfaces
rm -f /target/etc/resolv.conf
ln -s /run/systemd/resolve/stub-resolv.conf /target/etc/resolv.conf
in-target systemctl enable systemd-networkd systemd-resolved ssh
in-target systemctl disable networking || true
# Keep an unlocked account for public-key SSH without an empty password.
# The random console password is never printed, returned or persisted outside shadow.
in-target /bin/sh -c 'printf "root:%s\\n" "$(head -c 48 /dev/urandom | base64)" | chpasswd'
cp /nebula/receipt.json /target/var/lib/nebula-baremetal/installed.json
chmod 0600 /target/var/lib/nebula-baremetal/installed.json
"""
    )
    return {
        "preseed.cfg": preseed.encode(),
        "nebula/early.sh": early.encode(),
        "nebula/disk.sh": disk.encode(),
        "nebula/late.sh": late.encode(),
        "nebula/authorized_keys": (worker_public_key.strip() + "\n").encode(),
        "nebula/sshd.conf": (
            f"Port {spec['ssh']['port']}\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\n"
        ).encode(),
        "nebula/uplink.network": network_config(facts).encode(),
        "nebula/receipt.json": canonical(receipt).encode(),
    }


def cpio(files: dict[str, bytes]) -> bytes:
    """Minimal newc archive. All files, including host private keys, are 0600."""
    result = bytearray()
    entries: dict[str, tuple[int, bytes]] = {}
    for name, data in files.items():
        parts = name.split("/")
        if name.startswith("/") or ".." in parts:
            raise ProvisioningError("unsafe initramfs path")
        for index in range(1, len(parts)):
            entries["/".join(parts[:index])] = (0o40700, b"")
        entries[name] = (0o100600, data)
    entries["TRAILER!!!"] = (0, b"")
    for inode, (name, (mode, data)) in enumerate(entries.items(), 1):
        encoded = name.encode() + b"\0"
        fields = (inode, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(encoded), 0)
        result.extend(b"070701" + "".join(f"{value:08x}" for value in fields).encode() + encoded)
        result.extend(b"\0" * (-len(result) % 4))
        result.extend(data)
        result.extend(b"\0" * (-len(result) % 4))
    result.extend(b"\0" * (-len(result) % 512))
    return bytes(result)
