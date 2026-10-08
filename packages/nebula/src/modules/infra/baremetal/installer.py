"""Render a private Debian Installer initramfs for SSH-only OS replacement."""
import hashlib
import ipaddress
import json
import re
import shlex
import secrets


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def fingerprint(spec):
    # Changing k0s configuration must never authorize another OS installation.
    fields = ("address", "hostname", "ssh", "installation", "ipv6PodCidr", "workloadKubeconfigSecretName")
    return hashlib.sha256(canonical({key: spec.get(key) for key in fields}).encode()).hexdigest()


def validate_spec(spec):
    from urllib.parse import urlparse
    if ipaddress.ip_address(spec["address"]).version != 4:
        raise ValueError("installer requires IPv4 SSH access")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", spec["hostname"]):
        raise ValueError("invalid hostname")
    ssh = spec["ssh"]
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", ssh["user"]) or not 1 <= ssh["port"] <= 65535:
        raise ValueError("invalid SSH settings")
    if bool(ssh.get("knownHostsSecretName")) == bool(ssh.get("trustOnFirstUse")):
        raise ValueError("select pinned host keys or explicit first-use trust")
    p = spec["installation"]
    for artifact in (p["kernel"], p["initrd"]):
        url = urlparse(artifact["url"])
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
            raise ValueError("installer artifacts require credential-free HTTPS")
        if not re.fullmatch("[a-f0-9]{64}", artifact["sha256"]):
            raise ValueError("installer artifacts require SHA256 pins")
    if not re.fullmatch(r"[a-z][a-z0-9-]*", p["suite"]):
        raise ValueError("invalid Debian suite")
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", p["volumeGroup"]):
        raise ValueError("invalid volume group")
    if (type(p["rootSizeGiB"]) is not int or type(p["disk"]["minSizeGiB"]) is not int
            or p["rootSizeGiB"] < 8 or p["disk"]["minSizeGiB"] < p["rootSizeGiB"] + 4):
        raise ValueError("insufficient disk/root allocation")
    if type(p.get("timeoutSeconds", 3600)) is not int or p.get("timeoutSeconds", 3600) < 300:
        raise ValueError("installation deadline must be at least 300 seconds")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", p["mirror"]["hostname"]) or not re.fullmatch(r"/[A-Za-z0-9/._-]*", p["mirror"]["directory"]):
        raise ValueError("invalid Debian mirror")
    for address in p.get("dnsServers", []):
        if ipaddress.ip_address(address).is_loopback:
            raise ValueError("loopback resolvers cannot be transferred to the installer")
    if bool(spec.get("ipv6PodCidr")) != bool(spec.get("workloadKubeconfigSecretName")):
        raise ValueError("pod allocation requires workload access")
    if spec.get("ipv6PodCidr"):
        net = ipaddress.ip_network(spec["ipv6PodCidr"])
        if net.version != 6 or net.prefixlen != 64:
            raise ValueError("IPv6 pod allocation must be a /64")
    expected = {"PooledRemoteMachine", "RemoteMachineTemplate", "K0sWorkerConfigTemplate", "MachineDeployment"}
    if len(spec["enrollment"]) != 4 or {r["kind"] for r in spec["enrollment"]} != expected:
        raise ValueError("enrollment must contain exactly the four pooled CAPI resources")
    if any(r["metadata"]["name"] != spec["hostname"] for r in spec["enrollment"]):
        raise ValueError("enrollment names must match the installed hostname")


def select_disk(disks, root_disks, policy):
    eligible = [d for d in disks if d.get("type") == "disk" and not d.get("ro") and not d.get("rm")]
    if policy.get("serial"):
        eligible = [d for d in eligible if (d.get("serial") or "").strip() == policy["serial"]]
    else:
        eligible = [d for d in eligible if d["path"] in root_disks]
    if len(eligible) != 1:
        raise ValueError("root disk is ambiguous; configure an exact disk serial in the installation profile")
    disk = eligible[0]
    if int(disk["size"]) < policy["minSizeGiB"] * 1024**3:
        raise ValueError("selected disk is below the minimum size")
    return disk


def validate_volume_groups(selected_disk, volume_groups, requested_name):
    for name, disks in volume_groups.items():
        if selected_disk in disks and disks != {selected_disk}:
            raise ValueError("selected disk shares an LVM group with another disk; refusing to dismantle it")
        if name == requested_name and disks != {selected_disk}:
            raise ValueError("requested volume group already exists on another disk")


def network_config(facts):
    net = facts["network"]
    lines = ["[Match]", "MACAddress=" + net["mac"], "", "[Network]", "DHCP=no", "IPv6AcceptRA=no", "LinkLocalAddressing=ipv6"]
    for address in net["addresses"]:
        lines.append("Address=" + str(ipaddress.ip_interface(address)))
    for address in net["dns"]:
        lines.append("DNS=" + str(ipaddress.ip_address(address)))
    for route in net["routes"]:
        lines.extend(["", "[Route]", "Destination=" + route["destination"], "Gateway=" + route["gateway"], "GatewayOnLink=yes"])
    return "\n".join(lines) + "\n"


def render_files(spec, facts, worker_public_key, receipt):
    validate_spec(spec)
    if not re.fullmatch(r"(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?", worker_public_key.strip()):
        raise ValueError("worker key must be an OpenSSH public key")
    p, net = spec["installation"], facts["network"]
    v4 = next(ipaddress.ip_interface(a) for a in net["addresses"] if ipaddress.ip_interface(a).version == 4)
    gateway = next(r["gateway"] for r in net["routes"] if r["destination"] == "0.0.0.0/0")
    if not any(ipaddress.ip_address(dns).version == 4 for dns in net["dns"]):
        raise ValueError("the installer needs at least one IPv4 DNS resolver")
    if ipaddress.ip_address(gateway) not in v4.network:
        raise ValueError("installer netcfg requires an on-link IPv4 gateway; off-link routes need a qualified installer profile")
    boot = ("538 538 538 free $iflabel{ gpt } $reusemethod{ } method{ efi } format{ } . "
            if facts["uefi"] else "1 1 1 free $iflabel{ gpt } method{ biosgrub } . ")
    # partman recipe sizes are decimal MB, while the public profile uses GiB.
    root_mb = (p["rootSizeGiB"] * 1024**3 + 999999) // 1000000
    recipe = ("nebula :: " + boot +
              "1024 1024 1024 ext4 $primary{ } method{ format } format{ } use_filesystem{ } filesystem{ ext4 } mountpoint{ /boot } . " +
              f"{root_mb} {root_mb} {root_mb} ext4 $lvmok{{ }} lv_name{{ root }} method{{ format }} format{{ }} use_filesystem{{ }} filesystem{{ ext4 }} mountpoint{{ / }} .")
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
        "netcfg/get_nameservers string": " ".join(net["dns"]),
        "netcfg/confirm_static boolean": "true",
        "netcfg/get_hostname string": spec["hostname"],
        "netcfg/hostname string": spec["hostname"],
        "netcfg/get_domain string": "local",
        "mirror/country string": "manual",
        "mirror/http/hostname string": p["mirror"]["hostname"],
        "mirror/http/directory string": p["mirror"]["directory"],
        "mirror/http/proxy string": "",
        "mirror/suite string": p["suite"],
        "passwd/root-login boolean": "true",
        "passwd/root-password password": root_password,
        "passwd/root-password-again password": root_password,
        "passwd/make-user boolean": "false",
        "clock-setup/utc boolean": "true",
        "time/zone string": "UTC",
        "partman-auto/method string": "lvm",
        "partman-auto-lvm/new_vg_name string": p["volumeGroup"],
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
  if [ "$(cat "$p/address")" = {shlex.quote(net['mac'])} ]; then iface=${{p##*/}}; fi
done
[ -n "$iface" ]
debconf-set netcfg/choose_interface "$iface"
"""
    disk = f"""set -eu
disk=$(readlink -f {shlex.quote(facts['disk']['byId'])})
[ -b "$disk" ]
[ "$(blockdev --getsize64 "$disk")" -ge {p['disk']['minSizeGiB'] * 1024**3} ]
debconf-set partman-auto/disk "$disk"
debconf-set grub-installer/bootdev "$disk"
"""
    late = """set -eu
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
    return {"preseed.cfg": preseed.encode(), "nebula/early.sh": early.encode(),
            "nebula/disk.sh": disk.encode(), "nebula/late.sh": late.encode(),
            "nebula/authorized_keys": (worker_public_key.strip() + "\n").encode(),
            "nebula/sshd.conf": (f"Port {spec['ssh']['port']}\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\n").encode(),
            "nebula/uplink.network": network_config(facts).encode(),
            "nebula/receipt.json": canonical(receipt).encode()}


def cpio(files):
    """Minimal newc archive. All files, including host private keys, are 0600."""
    result, entries = bytearray(), {}
    for name, data in files.items():
        parts = name.split("/")
        if name.startswith("/") or ".." in parts:
            raise ValueError("unsafe initramfs path")
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
