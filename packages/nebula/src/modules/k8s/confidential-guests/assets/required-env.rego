
allow_@@ENV_RULE@@(p_oci, i_oci) if {
    p_oci.Annotations["io.kubernetes.cri.container-type"] == "sandbox"
}
allow_@@ENV_RULE@@(p_oci, i_oci) if {
    name := p_oci.Annotations["io.kubernetes.cri.container-name"]
    every required in policy_data.@@ENV_RULE@@[name] {
        prefix := concat("", [split(required, "=")[0], "="])
        [v | v := i_oci.Process.Env[_]; startswith(v, prefix)] == [required]
    }
}
