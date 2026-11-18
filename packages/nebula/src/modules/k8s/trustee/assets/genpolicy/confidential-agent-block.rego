# One agent owns every explicit block recipient. Device numbers are routing;
# paths, permissions and the two fixed guest control devices are constrained.
confidential_linux_devices(p, i) if {
    p == []
    i == []
}
confidential_linux_devices(p, i) if {
    count(p) >= 1
    count(p) <= 8
    paths := {d.Path | d := p[_]}
    count(paths) == count(p)
    every d in p {
        d.Type == ""
        regex.match("^/dev/nebula-volumes/[a-z][a-z0-9-]{0,39}$", d.Path)
    }
    count(i) == count(p) + 2
    blocks := [d | d := i[_]; d.Path in paths]
    count(blocks) == count(p)
    {d.Path | d := blocks[_]} == paths
    every d in blocks {
        object.keys(d) == {"Path", "Type", "Major", "Minor", "FileMode", "UID", "GID"}
        d.Type == "b"
        is_number(d.Major)
        d.Major >= 0
        is_number(d.Minor)
        d.Minor >= 0
        d.FileMode == 432
        d.UID == 0
        d.GID == 6
    }
    controls := [d | d := i[_]; not d.Path in paths]
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
