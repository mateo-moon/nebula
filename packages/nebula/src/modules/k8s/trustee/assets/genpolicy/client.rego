# Application constraints added to the pinned native genpolicy rules profile.
# The guest policy engine supports these rules; no host enforcement is trusted.

trustee_creation(p, i) if {
    container_role(p) == container_role(i)
    name := object.get(p.Annotations, "io.kubernetes.cri.container-name", "sandbox")
    not data.pstate[concat("", ["trustee_started_", name])]
    trustee_image_annotation(p, i)
    every env in [value | value := p.Process.Env[_]; not contains(value, "$(")] {
        env in i.Process.Env
    }
}

trustee_image_annotation(p, i) if {
    container_role(p) == "sandbox"
}
trustee_image_annotation(p, i) if {
    container_role(p) == "container"
    p.Annotations["io.kubernetes.cri.container-name"] == i.Annotations["io.kubernetes.cri.container-name"]
    p.Annotations["io.kubernetes.cri.image-name"] == i.Annotations["io.kubernetes.cri.image-name"]
}

trustee_seal(ops, oci) := result if {
    name := object.get(oci.Annotations, "io.kubernetes.cri.container-name", "sandbox")
    result := concat_op_if_not_null(ops, state_allows(concat("", ["trustee_started_", name]), true))
}

# A restarted container must not replace a verifier or recover guest state.
# Names come only from native genpolicy's measured Kubernetes declaration.
trustee_workload_names contains name if {
    container := policy_data.containers[_]
    container_role(container.OCI) == "container"
    name := container.OCI.Annotations["io.kubernetes.cri.container-name"]
}
trustee_started if {
    some name in trustee_workload_names
    data.pstate[concat("", ["trustee_started_", name])]
}
trustee_sealed if {
    every name in trustee_workload_names {
        data.pstate[concat("", ["trustee_started_", name])]
    }
}

# Current upstream uses no driver options. Older CoCo transports the same OCI
# metadata to CDH. Accept only that exact encoding, never arbitrary options.
trustee_pull_options(storage) if { count(storage.driver_options) == 0 }
trustee_pull_options(storage) if {
    count(storage.driver_options) == 1
    startswith(storage.driver_options[0], "image_guest_pull=")
    payload := json.unmarshal(trim_prefix(storage.driver_options[0], "image_guest_pull="))
    payload == {"metadata": input.OCI.Annotations}
}

# Only bounded runtime metadata may cross the boundary, before its container
# exists. Keys, application config, links and later changes are always denied.
CopyFileRequest if {
    not trustee_sealed
    input.file_type == "Regular"
    input.offset == 0
    input.file_size >= 0
    input.file_size <= 65536
    regex.match("^/run/kata-containers/shared/containers(?:/passthrough)?/(watchable/)?[a-z0-9]{64}-[a-z0-9]{16}-(resolv[.]conf|hosts|hostname|termination-log)$", input.path)
    ids := regex.find_n("[a-z0-9]{64}", input.path, 1)
    count(ids) == 1
    not trustee_existing_container(ids[0])
}
trustee_existing_container(id) if {
    some key, value in data.pstate
    startswith(key, "p_container_")
    value == id
}

UpdateInterfaceRequest if {
    not trustee_started
    upstream_UpdateInterfaceRequest
    every ip in input.interface.IPAddresses { trustee_ip(ip) }
}
trustee_ip(ip) if {
    ip.family == 0
    ip.mask == "32"
    regex.match(trustee_network.ipv4AddressPattern, ip.address)
    regex.match("^[0-9]{1,3}([.][0-9]{1,3}){3}$", ip.address)
    parts := split(ip.address, ".")
    every part in parts { to_number(part) <= 255 }
    first := to_number(parts[0])
    first > 0
    first != 127
    first < 224
}
trustee_ip(ip) if {
    ip.family == 1
    ip.mask == "128"
    regex.match(trustee_network.ipv6AddressPattern, ip.address)
    # Global/ULA prefixes exclude loopback, mapped IPv4 and unspecified forms.
    regex.match("^(?:[23][0-9a-fA-F]{3}|[fF][cCdD][0-9a-fA-F]{2}):[0-9a-fA-F:]+$", ip.address)
}
trustee_ip(ip) if {
    ip.family == 1
    ip.mask == "64"
    regex.match("^fe80::[0-9a-f:]+$", ip.address)
}
UpdateRoutesRequest if {
    not trustee_started
    upstream_UpdateRoutesRequest
    every route in input.routes.Routes {
        not trustee_loopback(route.dest)
        not trustee_loopback(route.gateway)
    }
}
trustee_loopback(address) if { regex.match("^127[.]", address) }
trustee_loopback(address) if { regex.match("^(?:0{0,4}:){0,7}0{0,3}1(?:/|$)", address) }
trustee_loopback(address) if { regex.match("^(?:0{0,4}:){0,6}[fF]{4}:", address) }
AddARPNeighborsRequest if {
    not trustee_started
    upstream_AddARPNeighborsRequest
}
