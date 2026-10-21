//! Public configuration bound by the guest's native agent policy.
//! Keys, arbitrary devices and network endpoints are deliberately absent.
use anyhow::{ensure, Result};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Volume {
    pub version: u8,
    pub name: String,
    pub size_bytes: u64,
    pub key_resource: String,
    pub initialization: Initialization,
    pub clients: Vec<Client>,
}

#[derive(Debug, Deserialize)]
pub enum Initialization {
    Never,
    IfEmpty,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Client {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launcher {
    pub version: u8,
    pub uid: u32,
    pub gid: u32,
    pub mounts: Vec<Mount>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mount {
    pub socket: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceBroker {
    pub version: u8,
    pub clients: Vec<ResourceClient>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceClient {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub resources: Vec<String>,
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn identity(uid: u32, gid: u32) -> bool {
    (11000..=65534).contains(&uid) && (11000..=65534).contains(&gid)
}

fn target(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && path.len() <= 256
        && path.split('/').skip(1).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        })
        && ![
            "/dev", "/proc", "/sys", "/run", "/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64",
        ]
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
}

impl Volume {
    pub fn parse(json: &str) -> Result<Self> {
        ensure!(json.len() <= 8192, "volume configuration too large");
        let value: Self = serde_json::from_str(json)?;
        ensure!(
            value.version == 1 && name(&value.name),
            "invalid volume identity"
        );
        ensure!(
            value.size_bytes >= 64 * 1024 * 1024
                && value.size_bytes <= (1_u64 << 50)
                && value.size_bytes.is_multiple_of(512),
            "invalid explicit block size"
        );
        let parts: Vec<_> = value.key_resource.split('/').collect();
        ensure!(
            parts.len() == 3
                && parts.iter().all(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && (s.as_bytes()[0].is_ascii_alphanumeric()
                            || b"_-".contains(&s.as_bytes()[0]))
                        && s.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                }),
            "invalid local Trustee resource"
        );
        ensure!(
            !value.clients.is_empty() && value.clients.len() <= 8,
            "invalid client count"
        );
        let mut names = BTreeSet::new();
        let mut users = BTreeSet::new();
        for client in &value.clients {
            ensure!(
                name(&client.name)
                    && identity(client.uid, client.gid)
                    && names.insert(&client.name)
                    && users.insert(client.uid),
                "invalid or duplicate mount recipient"
            );
        }
        Ok(value)
    }
}

impl Launcher {
    pub fn parse(json: &str) -> Result<Self> {
        ensure!(json.len() <= 8192, "launcher configuration too large");
        let value: Self = serde_json::from_str(json)?;
        ensure!(
            value.version == 1 && identity(value.uid, value.gid),
            "invalid client identity"
        );
        ensure!(value.mounts.len() <= 8, "invalid mount count");
        let mut sockets = BTreeSet::new();
        for mount in &value.mounts {
            let storage = mount
                .socket
                .strip_prefix("/run/nebula-mounts/")
                .and_then(|path| path.strip_suffix("/mount.sock"));
            ensure!(
                storage.is_some_and(name) && sockets.insert(&mount.socket),
                "invalid mount socket"
            );
            ensure!(target(&mount.path), "invalid application mount target");
            ensure!(
                value
                    .mounts
                    .iter()
                    .filter(|other| {
                        mount.path == other.path
                            || mount.path.starts_with(&format!("{}/", other.path))
                    })
                    .count()
                    == 1,
                "overlapping mount targets"
            );
        }
        Ok(value)
    }
}

impl ResourceBroker {
    pub fn parse(json: &str) -> Result<Self> {
        ensure!(json.len() <= 16384, "broker configuration too large");
        let value: Self = serde_json::from_str(json)?;
        ensure!(
            value.version == 1 && !value.clients.is_empty() && value.clients.len() <= 8,
            "invalid resource broker configuration"
        );
        let mut names = BTreeSet::new();
        let mut users = BTreeSet::new();
        for client in &value.clients {
            ensure!(
                name(&client.name)
                    && identity(client.uid, client.gid)
                    && names.insert(&client.name)
                    && users.insert(client.uid)
                    && !client.resources.is_empty()
                    && client.resources.len() <= 64,
                "invalid resource client"
            );
            let mut resources = BTreeSet::new();
            for resource in &client.resources {
                let parts: Vec<_> = resource.split('/').collect();
                ensure!(
                    parts.len() == 3
                        && parts.iter().all(|part| !part.is_empty()
                            && part.len() <= 128
                            && (part.as_bytes()[0].is_ascii_alphanumeric()
                                || b"_-".contains(&part.as_bytes()[0]))
                            && part
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)))
                        && resources.insert(resource),
                    "invalid resource path"
                );
            }
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn volume() -> Value {
        json!({"version":1,"name":"data","sizeBytes":1073741824,
            "keyResource":"default/volume/data","initialization":"Never",
            "clients":[{"name":"app","uid":11000,"gid":11000}]})
    }

    #[test]
    fn no_network_device_or_key_override_is_accepted() {
        assert!(Volume::parse(&volume().to_string()).is_ok());
        for (field, value) in [
            ("endpoint", json!("http://host/kbs")),
            ("key", json!("secret")),
            ("device", json!("/dev/other")),
            ("version", json!(2)),
            ("initialization", json!("Always")),
            ("keyResource", json!("default/key/../admin")),
            ("sizeBytes", json!(1)),
        ] {
            let mut config = volume();
            config[field] = value;
            assert!(Volume::parse(&config.to_string()).is_err(), "{field}");
        }
        let mut config = volume();
        config["clients"][0]["uid"] = json!(0);
        assert!(Volume::parse(&config.to_string()).is_err());
        config = volume();
        let duplicate = config["clients"][0].clone();
        config["clients"].as_array_mut().unwrap().push(duplicate);
        assert!(Volume::parse(&config.to_string()).is_err());
    }

    #[test]
    fn launcher_rejects_privileged_identity_and_path_substitution() {
        let config = json!({"version":1,"uid":11000,"gid":11000,
            "mounts":[{"socket":"/run/nebula-mounts/data/mount.sock","path":"/data"}]});
        assert!(Launcher::parse(&config.to_string()).is_ok());
        for path in [
            "/",
            "/etc",
            "/run/key",
            "/dev/x",
            "/data/../etc",
            "/data//x",
            "/data/",
        ] {
            let mut changed = config.clone();
            changed["mounts"][0]["path"] = json!(path);
            assert!(Launcher::parse(&changed.to_string()).is_err(), "{path}");
        }
        let mut changed = config.clone();
        changed["mounts"][0]["socket"] = json!("/run/nebula-mounts/../mount.sock");
        assert!(Launcher::parse(&changed.to_string()).is_err());
        changed = config;
        changed["uid"] = json!(0);
        assert!(Launcher::parse(&changed.to_string()).is_err());
    }

    #[test]
    fn resource_broker_rejects_unmeasured_clients_and_paths() {
        let sample = json!({"version":1,"clients":[{"name":"app","uid":11000,"gid":11000,
            "resources":["default/proof/session"]}]});
        assert!(ResourceBroker::parse(&sample.to_string()).is_ok());
        for path in [
            "default/volume/../data",
            "default/proof/session?key=1",
            "default/proof/session\nGET default/volume/data",
        ] {
            let mut changed = sample.clone();
            changed["clients"][0]["resources"][0] = json!(path);
            assert!(
                ResourceBroker::parse(&changed.to_string()).is_err(),
                "{path}"
            );
        }
        let mut changed = sample.clone();
        changed["clients"][0]["uid"] = json!(0);
        assert!(ResourceBroker::parse(&changed.to_string()).is_err());
        changed = sample.clone();
        changed["clients"]
            .as_array_mut()
            .unwrap()
            .push(sample["clients"][0].clone());
        assert!(ResourceBroker::parse(&changed.to_string()).is_err());
    }
}
