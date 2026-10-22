# Input profile for native genpolicy. Only the explicit block recipient can
# receive device-mapper controls. Host-assigned disk numbers are routing, not
# identity; LUKS key custody provides confidentiality for the block bytes.
confidential_linux_devices(p, i) if {
    p == []
    i == []
}
confidential_linux_devices(p, i) if {
    count(p) == 1
    p[0].Path == "/dev/coco-data"
    p[0].Type == ""
    count(i) == 3
    blocks := [d | d := i[_]; d.Path == "/dev/coco-data"]
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
    controls := [d | d := i[_]; d.Path != "/dev/coco-data"]
    count(controls) == 2
    {d | d := controls[_]} == {
        {"Path": "/dev/sev-guest", "Type": "c", "Major": 10, "Minor": 258, "FileMode": 384, "UID": 0, "GID": 0},
        {"Path": "/dev/mapper/control", "Type": "c", "Major": 10, "Minor": 236, "FileMode": 384, "UID": 0, "GID": 0}
    }
}

confidential_volume_devices(p, i) if {
    count(p) == count(i)
    {d.container_path | d := p[_]} == {d.container_path | d := i[_]}
}
