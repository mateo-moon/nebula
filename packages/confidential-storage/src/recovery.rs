//! Fixed owner-authorized recovery over the agent's inherited private channel.
//! No key, arbitrary path, device, command or disk bytes cross this channel.
use anyhow::{ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    os::{fd::FromRawFd, unix::net::UnixStream},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

pub(crate) const ACTION: &str = "initialize-empty-filesystem";
pub(crate) const ACK: &str = "RESUME ONLY THIS VERIFIED EMPTY FILESYSTEM";
const LIFETIME: Duration = Duration::from_secs(60);
type Shared = Arc<Mutex<State>>;
#[derive(Default)]
struct State {
    instance: Option<String>,
    volumes: BTreeMap<String, Entry>,
}
struct Entry {
    resource: String,
    candidate: Option<String>,
    challenge: Option<Challenge>,
    sender: mpsc::SyncSender<String>,
}
struct Challenge {
    value: String,
    header: String,
    expires: Instant,
}
pub(crate) struct VolumeRecovery {
    name: String,
    shared: Shared,
    receiver: mpsc::Receiver<String>,
}
pub(crate) struct Manager {
    shared: Shared,
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Manager {
    pub(crate) fn new() -> Self {
        Self {
            shared: Arc::new(Mutex::new(State::default())),
        }
    }
    pub(crate) fn volume(&self, name: &str, resource: &str) -> VolumeRecovery {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.shared.lock().unwrap().volumes.insert(
            name.into(),
            Entry {
                resource: resource.into(),
                candidate: None,
                challenge: None,
                sender,
            },
        );
        VolumeRecovery {
            name: name.into(),
            shared: self.shared.clone(),
            receiver,
        }
    }
    pub(crate) fn start(self) -> Result<()> {
        ensure!(
            unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) } == 0,
            "private recovery channel unavailable"
        );
        let mut stream = unsafe { UnixStream::from_raw_fd(3) };
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(b"nebula-storage-module-v1\n")?;
        std::thread::spawn(move || {
            let Ok(reader) = stream.try_clone() else {
                return;
            };
            let mut reader = BufReader::new(reader);
            loop {
                let mut bytes = Vec::new();
                let read = reader.by_ref().take(8193).read_until(b'\n', &mut bytes);
                if !matches!(read, Ok(n) if n > 0)
                    || bytes.len() > 8192
                    || bytes.last() != Some(&b'\n')
                {
                    break;
                }
                let parsed = serde_json::from_slice::<Value>(&bytes);
                let id = parsed
                    .as_ref()
                    .ok()
                    .and_then(|v| v["id"].as_u64())
                    .filter(|id| *id > 0 && *id <= i32::MAX as u64);
                let response = match (id, parsed) {
                    (Some(id), Ok(value)) => match self.request(value) {
                        Ok(result) => json!({"id":id,"result":result}),
                        Err(_) => json!({"id":id,"error":"recovery-request-refused"}),
                    },
                    _ => break,
                };
                let Ok(mut raw) = serde_json::to_vec(&response) else {
                    break;
                };
                raw.push(b'\n');
                if stream.write_all(&raw).is_err() {
                    break;
                }
            }
            crate::mount_handoff::SIGNAL.store(libc::SIGTERM, std::sync::atomic::Ordering::SeqCst);
        });
        Ok(())
    }
    fn request(&self, value: Value) -> Result<Value> {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("invalid control request"))?;
        let op = value["op"].as_str().unwrap_or("");
        let mut state = self
            .shared
            .lock()
            .map_err(|_| anyhow::anyhow!("recovery unavailable"))?;
        match op {
            "bind" => {
                ensure!(
                    object.len() == 3 && object.contains_key("instance"),
                    "invalid instance binding"
                );
                let instance = value["instance"].as_str().unwrap_or("");
                ensure!(digest(instance), "invalid instance");
                if let Some(existing) = &state.instance {
                    ensure!(existing == instance, "instance already bound");
                } else {
                    state.instance = Some(instance.into());
                }
                Ok(json!({"bound":true}))
            }
            "plans" => {
                ensure!(object.len() == 2, "invalid plan request");
                let instance = state
                    .instance
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("instance unavailable"))?;
                let now = Instant::now();
                let mut plans = Vec::new();
                for (name, entry) in &mut state.volumes {
                    let Some(header) = entry.candidate.clone() else {
                        continue;
                    };
                    if entry
                        .challenge
                        .as_ref()
                        .is_none_or(|c| c.expires <= now || c.header != header)
                    {
                        let mut random = [0; 32];
                        File::open("/dev/urandom")?.read_exact(&mut random)?;
                        entry.challenge = Some(Challenge {
                            value: hex::encode(random),
                            header: header.clone(),
                            expires: now + LIFETIME,
                        });
                    }
                    let challenge = entry.challenge.as_ref().unwrap();
                    plans.push(json!({"version":1,"storage":name,"keyResource":entry.resource,"instance":instance,
                        "headerSha256":header,"challenge":challenge.value,"action":ACTION,
                        "expiresInSeconds":challenge.expires.saturating_duration_since(now).as_secs().clamp(1,60)}));
                }
                Ok(json!({"version":1,"instance":instance,"plans":plans}))
            }
            "apply" => {
                ensure!(
                    object.len() == 3 && object.contains_key("request"),
                    "invalid recovery request"
                );
                let request: Apply = serde_json::from_value(value["request"].clone())?;
                let instance = state
                    .instance
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("instance unavailable"))?;
                let entry = state
                    .volumes
                    .get_mut(&request.storage)
                    .ok_or_else(|| anyhow::anyhow!("unknown storage"))?;
                let challenge = entry
                    .challenge
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("challenge unavailable"))?;
                ensure!(
                    request.version == 1
                        && request.instance == instance
                        && digest(&request.challenge)
                        && request.challenge == challenge.value
                        && request.header_sha256 == challenge.header
                        && entry.candidate.as_ref() == Some(&challenge.header)
                        && challenge.expires > Instant::now()
                        && request.action == ACTION
                        && request.acknowledgement == ACK,
                    "stale or unapproved recovery"
                );
                entry.sender.try_send(challenge.header)?;
                entry.candidate = None;
                Ok(json!({"version":1,"storage":request.storage,"accepted":true}))
            }
            _ => anyhow::bail!("unknown control operation"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Apply {
    version: u8,
    storage: String,
    instance: String,
    header_sha256: String,
    challenge: String,
    action: String,
    acknowledgement: String,
}
impl VolumeRecovery {
    pub(crate) fn candidate(&self, header: Option<String>) {
        let mut state = self.shared.lock().unwrap();
        let entry = state.volumes.get_mut(&self.name).unwrap();
        if entry.candidate != header {
            entry.challenge = None;
        }
        entry.candidate = header;
    }
    pub(crate) fn requested(&self, timeout: Duration) -> Option<String> {
        self.receiver.recv_timeout(timeout).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_requires_exact_instance_header_ack_and_one_shot_challenge() {
        let manager = Manager::new();
        let volume = manager.volume("data", "default/volume/data");
        volume.candidate(Some("b".repeat(64)));
        manager
            .request(json!({"id":1,"op":"bind","instance":"a".repeat(64)}))
            .unwrap();
        let plan = manager.request(json!({"id":2,"op":"plans"})).unwrap()["plans"][0].clone();
        let apply = |plan: &Value| json!({"id":3,"op":"apply","request":{"version":1,"storage":"data","instance":plan["instance"],"headerSha256":plan["headerSha256"],"challenge":plan["challenge"],"action":ACTION,"acknowledgement":ACK}});
        let mut wrong = apply(&plan);
        wrong["request"]["instance"] = "c".repeat(64).into();
        assert!(manager.request(wrong).is_err());
        assert!(manager.request(apply(&plan)).is_err());
        let plan = manager.request(json!({"id":4,"op":"plans"})).unwrap()["plans"][0].clone();
        assert_eq!(manager.request(apply(&plan)).unwrap()["accepted"], true);
        assert_eq!(
            volume.requested(Duration::from_millis(1)),
            Some("b".repeat(64))
        );
        assert!(manager.request(apply(&plan)).is_err());
        assert!(manager
            .request(json!({"id":5,"op":"bind","instance":"d".repeat(64)}))
            .is_err());
    }
    #[test]
    fn plan_polling_is_stable_and_expiry_header_change_unknown_fields_fail_closed() {
        let manager = Manager::new();
        let volume = manager.volume("data", "default/volume/data");
        manager
            .request(json!({"id":1,"op":"bind","instance":"a".repeat(64)}))
            .unwrap();
        volume.candidate(Some("b".repeat(64)));
        let first = manager.request(json!({"id":2,"op":"plans"})).unwrap()["plans"][0].clone();
        let second = manager.request(json!({"id":3,"op":"plans"})).unwrap()["plans"][0].clone();
        assert_eq!(first["challenge"], second["challenge"]);
        let request = |plan: &Value| json!({"id":4,"op":"apply","request":{"version":1,"storage":"data","instance":plan["instance"],"headerSha256":plan["headerSha256"],"challenge":plan["challenge"],"action":ACTION,"acknowledgement":ACK}});
        let mut extra = request(&first);
        extra["request"]["path"] = "/dev/other".into();
        assert!(manager.request(extra).is_err());
        manager
            .shared
            .lock()
            .unwrap()
            .volumes
            .get_mut("data")
            .unwrap()
            .challenge
            .as_mut()
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        assert!(manager.request(request(&first)).is_err());
        let fresh = manager.request(json!({"id":5,"op":"plans"})).unwrap()["plans"][0].clone();
        assert_ne!(first["challenge"], fresh["challenge"]);
        volume.candidate(Some("c".repeat(64)));
        assert!(manager.request(request(&fresh)).is_err());
        assert!(volume.requested(Duration::from_millis(1)).is_none());
    }
}
