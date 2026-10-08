//! The pinned CAA cloud-config is a transport envelope, never guest configuration.
//! Its credentials authenticate an untrusted worker to APF, not a workload to KBS.
use crate::startup::{Stage, at};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{io::Write, net::IpAddr, path::Path, time::Duration};
use zeroize::Zeroizing;

pub const DIRECTORY: &str = "/run/peerpod";
pub const CONFIG: &str = "/run/peerpod/apf.json";
const METADATA: &str = "http://169.254.169.254/latest";
const LIMIT: usize = 16 * 1024;
const ENVELOPE: &str =
    "#cloud-config\n\nwrite_files:\n  - path: /run/peerpod/apf.json\n    content: |\n";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
struct Forwarder {
    pod_network: Network,
    pod_namespace: String,
    pod_name: String,
    tls_server_key: String,
    tls_server_cert: String,
    tls_client_ca: String,
    tls_min_version: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
struct Network {
    podip: String,
    pod_hw_addr: String,
    interface: String,
    worker_node_ip: String,
    tunnel_type: String,
    routes: Option<Vec<Route>>,
    neighbors: Option<Vec<Neighbor>>,
    mtu: u16,
    index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vxlan_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vxlan_id: Option<u32>,
    dedicated: bool,
    external_net_via_pod_vm: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Route {
    // Go netip's zero value is encoded as an empty string, even with omitempty.
    dst: String,
    gw: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
struct Neighbor {
    ip: String,
    hw_addr: String,
    dev: String,
    state: String,
}

fn prefix(value: &str) -> bool {
    let Some((ip, bits)) = value.split_once('/') else {
        return false;
    };
    match (ip.parse::<IpAddr>(), bits.parse::<u8>()) {
        (Ok(ip), Ok(bits)) => bits <= if ip.is_ipv4() { 32 } else { 128 },
        _ => false,
    }
}

fn interface(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 15
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

fn mac(value: &str) -> bool {
    let fields: Vec<_> = value.split(':').collect();
    fields.len() == 6
        && fields
            .iter()
            .all(|field| field.len() == 2 && field.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn pem(value: &str, kinds: &[&str]) -> bool {
    value.len() <= 8192
        && kinds.iter().any(|kind| {
            value.starts_with(&format!("-----BEGIN {kind}-----\n"))
                && value.trim_end().ends_with(&format!("-----END {kind}-----"))
        })
}

impl Forwarder {
    fn validate(&self) -> Result<()> {
        ensure!(
            crate::label(&self.pod_namespace)
                && self.pod_name.len() <= 253
                && self.pod_name.split('.').all(crate::label),
            "invalid pod labels"
        );
        ensure!(self.tls_min_version == "VersionTLS13", "TLS 1.3 required");
        // APF performs certificate/key parsing and matching before opening its listener.
        // These checks bound inputs; they do not grant trust to host-issued credentials.
        ensure!(
            pem(
                &self.tls_server_key,
                &["PRIVATE KEY", "EC PRIVATE KEY", "RSA PRIVATE KEY"]
            ) && pem(&self.tls_server_cert, &["CERTIFICATE"])
                && pem(&self.tls_client_ca, &["CERTIFICATE"]),
            "transport credentials required"
        );
        let network = &self.pod_network;
        ensure!(
            prefix(&network.podip)
                && prefix(&network.worker_node_ip)
                && mac(&network.pod_hw_addr)
                && interface(&network.interface),
            "invalid network identity"
        );
        ensure!(
            network.tunnel_type == "vxlan"
                && !network.external_net_via_pod_vm
                && (576..=9001).contains(&network.mtu)
                && network.index <= 0xffffff
                && network.vxlan_port != Some(0)
                && network
                    .vxlan_id
                    .is_none_or(|id| (1..=0xffffff).contains(&id)),
            "unsupported network configuration"
        );
        let routes = network.routes.as_deref().unwrap_or_default();
        let neighbors = network.neighbors.as_deref().unwrap_or_default();
        ensure!(
            routes.len() <= 128 && neighbors.len() <= 128,
            "too many network entries"
        );
        for route in routes {
            ensure!(
                (route.dst.is_empty() || prefix(&route.dst))
                    && (route.gw.is_empty() || route.gw.parse::<IpAddr>().is_ok())
                    && route.dev.as_deref().is_none_or(interface)
                    && route
                        .protocol
                        .as_deref()
                        .is_none_or(|p| ["static", "boot", "dhcp", "kernel"].contains(&p))
                    && route
                        .scope
                        .as_deref()
                        .is_none_or(
                            |s| ["universe", "site", "link", "host", "nowhere"].contains(&s)
                        ),
                "invalid route"
            );
        }
        for neighbor in neighbors {
            ensure!(
                neighbor.ip.parse::<IpAddr>().is_ok()
                    && mac(&neighbor.hw_addr)
                    && interface(&neighbor.dev)
                    && [
                        "none",
                        "incomplete",
                        "reachable",
                        "stale",
                        "delay",
                        "probe",
                        "failed",
                        "noarp",
                        "permanent"
                    ]
                    .contains(&neighbor.state.as_str()),
                "invalid neighbor"
            );
        }
        Ok(())
    }
}

/// Decode only the exact single-file envelope produced by CAA v0.23.0's
/// CloudConfig.Generate. This is intentionally not a general YAML interpreter:
/// no anchors, tags, extra files, MIME, commands or cloud-init modules execute.
pub fn configuration(user_data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(user_data.len() <= LIMIT, "oversize user data");
    let text = std::str::from_utf8(user_data)?;
    let body = text
        .strip_prefix(ENVELOPE)
        .context("unsupported CAA envelope")?;
    let mut json = Zeroizing::new(String::new());
    for line in body.lines() {
        json.push_str(
            line.strip_prefix("      ")
                .context("only APF content permitted")?,
        );
        json.push('\n');
    }
    let config: Forwarder = serde_json::from_str(&json)?;
    config.validate()?;
    Ok(Zeroizing::new(serde_json::to_vec(&config)?))
}

async fn bounded_body(mut response: reqwest::Response, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(response.status().is_success(), "metadata request rejected");
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= limit,
            "oversize metadata response"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn user_data(http: &reqwest::Client, metadata: &str) -> Result<Zeroizing<Vec<u8>>> {
    let token = bounded_body(
        http.put(format!("{metadata}/api/token"))
            .header("X-aws-ec2-metadata-token-ttl-seconds", "60")
            .send()
            .await?,
        4096,
    )
    .await?;
    ensure!(
        !token.is_empty() && token.iter().all(|b| (0x21..=0x7e).contains(b)),
        "invalid IMDSv2 token"
    );
    bounded_body(
        http.get(format!("{metadata}/user-data"))
            .header("X-aws-ec2-metadata-token", std::str::from_utf8(&token)?)
            .send()
            .await?,
        LIMIT,
    )
    .await
}

fn write_configuration(directory: &Path, bytes: &[u8]) -> Result<()> {
    crate::require_memory_directory(directory)?;
    // tempfile creates a private 0600 file. Refuse replacement (including symlinks)
    // so a completed transport configuration cannot change during this boot.
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    pending.write_all(bytes)?;
    pending.as_file().sync_all()?;
    pending.persist_noclobber(directory.join("apf.json"))?;
    Ok(())
}

pub async fn provision() -> Result<()> {
    at(
        Stage::TransportFilesystem,
        crate::require_memory_directory(Path::new(DIRECTORY)),
    )?;
    let http = at(
        Stage::TransportMetadata,
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build(),
    )?;
    // No IMDSv1 fallback, configurable endpoint, proxy or response redirect.
    let data = at(Stage::TransportMetadata, user_data(&http, METADATA).await)?;
    let config = at(Stage::TransportConfiguration, configuration(&data))?;
    at(
        Stage::TransportPersist,
        write_configuration(Path::new(DIRECTORY), &config),
    )
}

/// Fixed IMDSv2 origin, no proxies/redirects. Metadata selects public boot
/// intent and routing only; it never supplies a signing key or an approval.
pub(crate) async fn metadata(path: &str, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(
        path == "user-data"
            || path == "meta-data/local-ipv4"
            || path == "meta-data/placement/region"
            || path == "meta-data/iam/security-credentials/"
            || path
                .strip_prefix("meta-data/iam/security-credentials/")
                .is_some_and(|name| !name.is_empty()
                    && name.len() <= 64
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+=,.@_-".contains(&b)))
            || ["nebula-coco-bucket", "nebula-coco-deployment"]
                .iter()
                .any(|tag| path == format!("meta-data/tags/instance/{tag}")),
        "unsupported metadata field"
    );
    ensure!(limit <= 16384, "metadata bound too large");
    let http = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()?;
    let token = bounded_body(
        http.put(format!("{METADATA}/api/token"))
            .header("X-aws-ec2-metadata-token-ttl-seconds", "60")
            .send()
            .await?,
        4096,
    )
    .await?;
    ensure!(
        !token.is_empty() && token.iter().all(|b| (0x21..=0x7e).contains(b)),
        "invalid IMDSv2 token"
    );
    bounded_body(
        http.get(format!("{METADATA}/{path}"))
            .header("X-aws-ec2-metadata-token", std::str::from_utf8(&token)?)
            .send()
            .await?,
        limit,
    )
    .await
}

pub(crate) fn pod_identity() -> Result<(String, String)> {
    let data = std::fs::read(CONFIG)?;
    ensure!(data.len() <= LIMIT, "oversize CAA transport");
    let config: Forwarder = serde_json::from_slice(&data)?;
    config.validate()?;
    Ok((config.pod_namespace, config.pod_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::io::{Read, Write};

    fn input() -> String {
        // APF validates real certificates before listening. These PEM bodies
        // deliberately contain only the base64 word "fixture", not private keys.
        let text = include_str!("../tests/fixtures/caa-cloud-config.txt");
        let mut text = text.to_owned();
        for (marker, kind) in [
            ("TEST_SERVER_KEY", "PRIVATE KEY"),
            ("TEST_SERVER_CERT", "CERTIFICATE"),
            ("TEST_CLIENT_CA", "CERTIFICATE"),
        ] {
            let encoded = serde_json::to_string(&format!(
                "-----BEGIN {kind}-----\nZml4dHVyZQ==\n-----END {kind}-----\n"
            ))
            .unwrap();
            text = text.replace(&format!("\"{marker}\""), &encoded);
        }
        text
    }

    fn changed(edit: impl FnOnce(&mut Value)) -> String {
        let text = input();
        let body: String = text
            .strip_prefix(ENVELOPE)
            .unwrap()
            .lines()
            .map(|line| format!("{}\n", &line[6..]))
            .collect();
        let mut value: Value = serde_json::from_str(&body).unwrap();
        edit(&mut value);
        format!(
            "{ENVELOPE}      {}\n",
            serde_json::to_string(&value).unwrap()
        )
    }

    #[test]
    fn pinned_caa_envelope_retains_transport_only() {
        let config: Value =
            serde_json::from_slice(&configuration(input().as_bytes()).unwrap()).unwrap();
        assert_eq!(config["tls-min-version"], "VersionTLS13");
        assert_eq!(config["pod-network"]["routes"][0]["protocol"], "boot");
        assert_eq!(config["pod-network"]["vxlan-id"], 42);
        assert_eq!(config.as_object().unwrap().len(), 7);
    }

    #[test]
    fn first_caa_pod_uses_zero_based_vxlan_index() {
        // CAA's worker allocator starts at zero. Its index is an offset from
        // the configured VXLAN minimum, not an OS network-interface index.
        let data = changed(|v| {
            v["pod-network"]["index"] = json!(0);
            v["pod-network"]["vxlan-id"] = json!(555000);
            v["pod-network"]["mtu"] = json!(9001);
        });
        let config: Value =
            serde_json::from_slice(&configuration(data.as_bytes()).unwrap()).unwrap();
        assert_eq!(config["pod-network"]["index"], 0);
        assert_eq!(config["pod-network"]["vxlan-id"], 555000);
    }

    #[test]
    fn mutable_guest_configuration_and_extra_files_are_rejected() {
        for suffix in [
            "  - path: /run/peerpod/initdata\n    content: |\n      policy\n",
            "  - path: /run/peerpod/auth.json\n    content: |\n      {}\n",
            "  - path: /run/peerpod/scratch-space.marker\n",
            "runcmd:\n  - echo command\n",
            "---\nwrite_files: []\n",
        ] {
            assert!(configuration(format!("{}{suffix}", input()).as_bytes()).is_err());
        }
        for (key, value) in [
            ("policy", json!("allow-all")),
            ("tls-skip-verify", json!(true)),
            ("tls-cipher-suites", json!([])),
            ("sc-pp-prv", json!("private")),
            ("command", json!(["sh"])),
        ] {
            assert!(configuration(changed(|v| v[key] = value).as_bytes()).is_err());
        }
    }

    #[test]
    fn alternate_yaml_encodings_and_paths_do_not_execute() {
        let valid = input();
        for (from, to) in [
            ("content: |", "content: !!binary |"),
            ("content: |", "content: >"),
            ("/run/peerpod/apf.json", "/usr/share/nebula/policy.rego"),
            ("/run/peerpod/apf.json", "/run/peerpod/../apf.json"),
            ("write_files:", "write_files: &files"),
            ("    content:", "    owner: nobody\n    content:"),
        ] {
            assert!(configuration(valid.replace(from, to).as_bytes()).is_err());
        }
    }

    #[test]
    fn duplicate_fields_oversize_data_and_missing_tls_fail_closed() {
        let valid = input();
        assert!(
            configuration(
                valid
                    .replace(
                        "\"tls-min-version\":",
                        "\"tls-min-version\": \"VersionTLS12\", \"tls-min-version\":"
                    )
                    .as_bytes()
            )
            .is_err()
        );
        assert!(configuration(&vec![b' '; LIMIT + 1]).is_err());
        for version in ["", "VersionTLS12", "VersionTLS10"] {
            assert!(
                configuration(changed(|v| v["tls-min-version"] = json!(version)).as_bytes())
                    .is_err()
            );
        }
        for key in ["tls-client-ca", "tls-server-cert", "tls-server-key"] {
            assert!(
                configuration(
                    changed(|v| {
                        v.as_object_mut().unwrap().remove(key);
                    })
                    .as_bytes()
                )
                .is_err()
            );
        }
    }

    #[test]
    fn invalid_network_data_and_expanded_network_scope_are_rejected() {
        for (key, value) in [
            ("podip", json!("192.0.2.4/99")),
            ("worker-node-ip", json!("metadata.invalid")),
            ("interface", json!("eth0;command")),
            ("pod-hw-addr", json!("invalid")),
            ("tunnel-type", json!("unsupported")),
            ("mtu", json!(0)),
            ("index", json!(-1)),
            ("index", json!(0x1000000)),
            ("vxlan-id", json!(0x1000000)),
            ("vxlan-port", json!(0)),
            ("external-net-via-pod-vm", json!(true)),
            ("policy", json!("allow-all")),
        ] {
            assert!(configuration(changed(|v| v["pod-network"][key] = value).as_bytes()).is_err());
        }
        assert!(
            configuration(
                changed(|v| v["pod-network"]["routes"][0]["command"] = json!("exec")).as_bytes()
            )
            .is_err()
        );
        assert!(
            configuration(
                changed(|v| v["pod-network"]["neighbors"][0]["state"] = json!("unknown"))
                    .as_bytes()
            )
            .is_err()
        );
        assert!(
            configuration(
                changed(|v| v["pod-network"]["routes"] =
                    json!(vec![v["pod-network"]["routes"][0].clone(); 129]))
                .as_bytes()
            )
            .is_err()
        );
    }

    #[test]
    fn optional_network_collections_and_ipv6_are_accepted() {
        let data = changed(|v| {
            let net = &mut v["pod-network"];
            net["routes"] = Value::Null;
            net["neighbors"] = Value::Null;
            net["podip"] = json!("2001:db8::4/64");
            net["worker-node-ip"] = json!("2001:db8:1::2/64");
        });
        assert!(configuration(data.as_bytes()).is_ok());
    }

    // A loopback server exercises the HTTP protocol without a metadata endpoint
    // override in the executable. A read timeout prevents a bad client from hanging.
    fn server(responses: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/latest", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "missing metadata request"
                            );
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    assert_eq!(stream.read(&mut byte).unwrap(), 1);
                    request.extend(byte);
                    assert!(request.len() < 8192);
                }
                requests.push(String::from_utf8(request).unwrap());
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (url, handle)
    }

    #[tokio::test]
    async fn metadata_requires_imdsv2_and_carries_token_only_in_header() {
        let data = input();
        let (url, server) = server(vec![(200, "test-token".into()), (200, data.clone())]);
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        assert_eq!(
            user_data(&client, &url).await.unwrap().as_slice(),
            data.as_bytes()
        );
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("PUT /latest/api/token HTTP/1.1"));
        assert!(requests[0].contains("x-aws-ec2-metadata-token-ttl-seconds: 60\r\n"));
        assert!(requests[1].starts_with("GET /latest/user-data HTTP/1.1"));
        assert!(requests[1].contains("x-aws-ec2-metadata-token: test-token\r\n"));
    }

    #[tokio::test]
    async fn missing_invalid_oversize_or_redirected_metadata_is_rejected() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for responses in [
            vec![(404, String::new())],
            vec![(302, String::new())],
            vec![(200, String::new())],
            vec![(200, "token\ninjection".into())],
            vec![(200, "t".repeat(4097))],
            vec![(200, "token".into()), (200, "x".repeat(LIMIT + 1))],
        ] {
            let (url, server) = server(responses);
            assert!(user_data(&client, &url).await.is_err());
            server.join().unwrap();
        }
    }

    #[test]
    fn transport_cannot_be_written_to_an_ordinary_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert!(write_configuration(directory.path(), b"{}").is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires private root-owned no-swap tmpfs at /run/nebula/secrets"]
    fn private_transport_is_atomic_and_cannot_be_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir_in(crate::SECRETS).unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let destination = directory.path().join("apf.json");
        write_configuration(directory.path(), b"first").unwrap();
        assert_eq!(
            std::fs::metadata(&destination)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(write_configuration(directory.path(), b"second").is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"first");
        std::fs::remove_file(&destination).unwrap();
        std::os::unix::fs::symlink("/not-written", &destination).unwrap();
        assert!(write_configuration(directory.path(), b"second").is_err());
        assert!(
            std::fs::symlink_metadata(&destination)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
