
allow_volume_transport(p_container, devices) if {
    p_container.devices == []
    devices == []
}
allow_volume_transport(p_container, devices) if {
    count(p_container.devices) == 1
    p_container.devices[0].container_path == @@DATA_DEVICE@@
    count(devices) == 1
    devices[0].container_path == @@DATA_DEVICE@@
    devices[0].type_ in {"blk", "scsi"}
    devices[0].options == []
}
