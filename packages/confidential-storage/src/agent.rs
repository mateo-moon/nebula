//! A single private native module owns every declared volume and resource
//! recipient. It never returns stored keys or mount descriptors to the HTTP
//! agent. Authenticated owner provisioning still passes through the owner API.
use crate::{
    generic_config::{ResourceBroker, Volume},
    generic_storage, mount_handoff, volume,
};
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{atomic::Ordering, mpsc},
    thread,
};
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::FromRawFd,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    version: u8,
    volumes: Vec<serde_json::Value>,
    clients: Vec<serde_json::Value>,
    denied_resources: Vec<String>,
}

fn configuration(raw: &str) -> Result<(Vec<Volume>, Option<ResourceBroker>)> {
    ensure!(raw.len() <= 65536, "storage module configuration too large");
    let config: Configuration = serde_json::from_str(raw)?;
    ensure!(
        config.version == 1
            && config.volumes.len() <= 8
            && config.clients.len() <= 8
            && config.denied_resources.len() <= 64,
        "invalid storage modules"
    );
    let denied: BTreeSet<_> = config.denied_resources.iter().collect();
    ensure!(
        denied.len() == config.denied_resources.len(),
        "duplicate private resource"
    );
    let mut names = BTreeSet::new();
    let mut recipients = BTreeMap::new();
    let mut volumes = Vec::new();
    for value in config.volumes {
        let volume = Volume::parse(&value.to_string())?;
        ensure!(
            names.insert(volume.name.clone()) && denied.contains(&volume.key_resource),
            "invalid volume module"
        );
        for client in &volume.clients {
            if let Some(existing) = recipients.insert(client.name.clone(), (client.uid, client.gid))
            {
                ensure!(
                    existing == (client.uid, client.gid),
                    "inconsistent volume recipient"
                );
            }
        }
        volumes.push(volume);
    }
    let broker = if config.clients.is_empty() {
        None
    } else {
        let broker = ResourceBroker::parse(
            &serde_json::json!({"version":1,"clients":config.clients}).to_string(),
        )?;
        for client in &broker.clients {
            ensure!(
                client.resources.iter().all(|path| !denied.contains(path)),
                "private keys cannot be delegated"
            );
            if let Some(existing) = recipients.get(&client.name) {
                ensure!(
                    *existing == (client.uid, client.gid),
                    "inconsistent resource recipient"
                );
            }
        }
        Some(broker)
    };
    ensure!(
        !volumes.is_empty() || broker.is_some(),
        "no native storage modules"
    );
    Ok((volumes, broker))
}

pub(crate) fn run(raw: &str) -> Result<()> {
    let (volumes, broker) = configuration(raw)?;
    mount_handoff::storage_credentials()?;
    mount_handoff::signals()?;
    unsafe {
        libc::umask(0o077);
    }
    // The HTTP parent permanently drops UID, so it cannot signal this root
    // helper. Its inherited stdin is a private shutdown channel. EOF also
    // closes every module if that parent dies. No key or command is read here.
    ensure!(
        unsafe { libc::fcntl(0, libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
        "private shutdown channel unavailable"
    );
    let mut shutdown = unsafe { File::from_raw_fd(0) };
    thread::spawn(move || {
        let mut byte = [0];
        let _ = shutdown.read(&mut byte);
        mount_handoff::SIGNAL.store(libc::SIGTERM, Ordering::SeqCst);
    });
    // A fixed private parent channel confirms validation and privilege
    // reduction before the HTTP agent drops UID and opens its listeners.
    let mut ready = unsafe { File::from_raw_fd(3) };
    ready.write_all(b"nebula-storage-module-v1\n")?;
    drop(ready);
    let (finished, completion) = mpsc::channel();
    let mut modules = Vec::new();
    for config in volumes {
        let done = finished.clone();
        modules.push(thread::spawn(move || {
            let result = std::panic::catch_unwind(|| {
                let profile = volume::Profile::agent(&config.name, config.size_bytes);
                generic_storage::serve_volume(config, profile, true)
            });
            let _ = done.send(
                result
                    .map_err(|_| anyhow::anyhow!("volume module failed"))
                    .and_then(|result| result),
            );
        }));
    }
    if let Some(broker) = broker {
        let done = finished.clone();
        modules.push(thread::spawn(move || {
            let result =
                std::panic::catch_unwind(|| generic_storage::serve_resource_module(broker));
            let _ = done.send(
                result
                    .map_err(|_| anyhow::anyhow!("resource module failed"))
                    .and_then(|result| result),
            );
        }));
    }
    drop(finished);
    let result = completion.recv().context("storage modules unavailable")?;
    mount_handoff::SIGNAL.store(libc::SIGTERM, Ordering::SeqCst);
    for module in modules {
        let _ = module.join();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> serde_json::Value {
        json!({"version":1,"volumes":[{"version":1,"name":"data","sizeBytes":67108864,
            "keyResource":"default/volume/data","initialization":"Never",
            "clients":[{"name":"app","uid":11000,"gid":11000}]}],
            "clients":[{"name":"app","uid":11000,"gid":11000,"resources":["default/config/app"]}],
            "deniedResources":["default/volume/data","default/image/app"]})
    }
    #[test]
    fn private_resources_and_conflicting_recipients_cannot_enter_the_broker() {
        assert!(configuration(&config().to_string()).is_ok());
        for resource in ["default/volume/data", "default/image/app"] {
            let mut value = config();
            value["clients"][0]["resources"] = json!([resource]);
            assert!(configuration(&value.to_string()).is_err());
        }
        let mut value = config();
        value["clients"][0]["uid"] = json!(11001);
        assert!(configuration(&value.to_string()).is_err());
        let mut value = config();
        value["deniedResources"] = json!([]);
        assert!(configuration(&value.to_string()).is_err());
    }
    #[test]
    fn module_paths_are_derived_from_validated_names_only() {
        for field in ["device", "stateDir", "endpoint", "key"] {
            let mut value = config();
            value["volumes"][0][field] = json!("untrusted");
            assert!(configuration(&value.to_string()).is_err());
        }
        let a = volume::Profile::agent("data", 67108864);
        let b = volume::Profile::agent("scratch", 67108864);
        assert_ne!(a.disk, b.disk);
        assert_ne!(a.mount, b.mount);
        assert_ne!(a.state, b.state);
        assert_eq!(a.disk, "/dev/nebula-volumes/data");
    }
}
