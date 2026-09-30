
# Only the single explicit PVC can carry runtime-assigned block numbers.
# The native control devices retain exact shape, mode, identity and count.
allow_linux_devices(p_devices, i_devices) if {
    p_devices == []
    i_devices == []
}
allow_linux_devices(p_devices, i_devices) if {
    count(p_devices) == 3
    p_devices[0].Path == @@DATA_DEVICE@@
    count(i_devices) == 3
    blocks := [d | d := i_devices[_]; d.Path == @@DATA_DEVICE@@]
    count(blocks) == 1
    d := blocks[0]
    object.keys(d) == {"Path", "Type", "Major", "Minor", "FileMode", "UID", "GID"}
    d.Type == "b"
    is_number(d.Major)
    d.Major >= 0
    is_number(d.Minor)
    d.Minor >= 0
    d.FileMode == 432
    d.UID == 0
    d.GID == 6
    controls := [d | d := i_devices[_]; d.Path != @@DATA_DEVICE@@]
    count(controls) == 2
    {d | d := controls[_]} == {{"Path": "/dev/sev-guest", "Type": "c", "Major": 10, "Minor": 258, "FileMode": 384, "UID": 0, "GID": 0},{"Path": "/dev/mapper/control", "Type": "c", "Major": 10, "Minor": 236, "FileMode": 384, "UID": 0, "GID": 0}}
}
