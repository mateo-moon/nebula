# Guest-pull image identity is bound to the selected container, not just an
# unchecked CRI annotation. Pause uses the measured guest's built-in image.
allow_pinned_image(p_oci, i_oci, i_storages) if {
    p_oci.Annotations["io.kubernetes.cri.container-type"] == "container"
    expected := p_oci.Annotations["io.kubernetes.cri.image-name"]
    i_oci.Annotations["io.kubernetes.cri.image-name"] == expected
    allow_pinned_pull(expected, i_oci, i_storages)
}
allow_pinned_image(p_oci, i_oci, i_storages) if {
    p_oci.Annotations["io.kubernetes.cri.container-type"] == "sandbox"
    allow_pinned_pull("pause", i_oci, i_storages)
}
allow_pinned_pull(expected, i_oci, i_storages) if {
    pulls := [s | s := i_storages[_]; s.driver == "image_guest_pull"]
    count(pulls) == 1
    pull := pulls[0]
    pull.source == expected
    pull.mount_point == i_oci.Root.Path
    count(pull.driver_options) == 1
    startswith(pull.driver_options[0], "image_guest_pull=")
    payload := json.unmarshal(trim_prefix(pull.driver_options[0], "image_guest_pull="))
    payload == {"metadata": i_oci.Annotations}
}
