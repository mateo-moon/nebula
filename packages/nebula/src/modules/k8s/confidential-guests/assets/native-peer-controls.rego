
# Only a role explicitly measured with this single SNP control receives it.
# Applications with an empty device list cannot use this rule.
allow_linux_devices(p_devices, i_devices) if {
    p_devices == [{"Path": "/dev/sev-guest", "Type": "c", "Major": 10, "Minor": 258, "FileMode": 384, "UID": 0, "GID": 0}]
    i_devices == p_devices
}
