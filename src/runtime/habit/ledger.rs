//! Durable replacement under the legacy ledger lease; every event is replay-validated.
use super::model;
use crate::support::{Error, Result};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

fn corrupt(category: &str) -> Error {
    Error::new(
        "habit_ledger_corrupt",
        format!("habit ledger category={category}"),
    )
}
fn inspect(path: &Path, dir: bool) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() || if dir { !m.is_dir() } else { !m.is_file() } => {
            Err(corrupt("node-kind"))
        }
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(corrupt("io")),
    }
}
fn directories(cwd: &Path, create: bool) -> Result<Option<PathBuf>> {
    inspect(cwd, true)?.ok_or_else(|| corrupt("repository"))?;
    for path in [cwd.join(".gdm"), cwd.join(".gdm/habits")] {
        if inspect(&path, true)?.is_none() {
            if !create {
                return Ok(None);
            }
            match fs::create_dir(&path) {
                Ok(()) => fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(corrupt("mkdir")),
            }
            inspect(&path, true)?.ok_or_else(|| corrupt("mkdir"))?;
        }
    }
    let dir = cwd.join(".gdm/habits");
    for name in ["ledger.jsonl", ".ledger.lock", ".ledger.tmp"] {
        inspect(&dir.join(name), false)?;
    }
    Ok(Some(dir))
}
fn raw(dir: &Path) -> Result<String> {
    let path = dir.join("ledger.jsonl");
    if inspect(&path, false)?.is_none() {
        return Ok(String::new());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| corrupt("open"))?;
    if !file.metadata()?.is_file() {
        return Err(corrupt("file-kind"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|_| corrupt("encoding"))?;
    Ok(text)
}
fn parse(text: &str) -> Result<Vec<Value>> {
    let mut events = Vec::new();
    for (index, line) in text.split_terminator('\n').enumerate() {
        let fail = |category: &str| {
            Error::new(
                "habit_ledger_corrupt",
                format!(
                    "habit_ledger_corrupt line={} category={category}",
                    index + 1
                ),
            )
        };
        if line.is_empty() || line.len() + 1 >= 2048 {
            return Err(fail("size"));
        }
        let event: Value = serde_json::from_str(line).map_err(|_| fail("json"))?;
        model::scan_tokens(line).map_err(|_| fail("privacy"))?;
        model::validate(&event).map_err(|_| fail("fields"))?;
        events.push(event);
    }
    model::reduce(&events).map_err(|_| corrupt("transition"))?;
    Ok(events)
}
pub fn read(cwd: &Path) -> Result<Vec<Value>> {
    match directories(cwd, false)? {
        Some(dir) => parse(&raw(&dir)?),
        None => Ok(Vec::new()),
    }
}
#[derive(Clone, Copy)]
struct Identity(u64, u64);
fn identity(path: &Path, dir: bool) -> Result<Identity> {
    let m = inspect(path, dir)?.ok_or_else(|| corrupt("missing"))?;
    Ok(Identity(m.dev(), m.ino()))
}
fn same(path: &Path, dir: bool, id: Identity) -> Result<()> {
    let actual = identity(path, dir)?;
    if actual.0 == id.0 && actual.1 == id.1 {
        Ok(())
    } else {
        Err(corrupt("changed"))
    }
}
struct Lease {
    path: PathBuf,
    identity: Identity,
    _file: File,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if same(&self.path, false, self.identity).is_ok() {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn acquire(dir: &Path) -> Result<Lease> {
    let path = dir.join(".ledger.lock");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(file) => {
                let m = file.metadata()?;
                return Ok(Lease {
                    path,
                    identity: Identity(m.dev(), m.ino()),
                    _file: file,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Some(m) = inspect(&path, false)?
                    && m.modified()
                        .ok()
                        .and_then(|t| SystemTime::now().duration_since(t).ok())
                        .is_some_and(|age| age > Duration::from_secs(60))
                {
                    let id = Identity(m.dev(), m.ino());
                    same(&path, false, id)?;
                    match fs::remove_file(&path) {
                        Ok(()) => continue,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(_) => return Err(corrupt("reclaim")),
                    }
                }
            }
            Err(_) => return Err(corrupt("lock")),
        }
        if Instant::now() >= deadline {
            return Err(Error::new(
                "habit_ledger_busy",
                crate::i18n::text(
                    "원장이 다른 프로세스에 의해 잠겨 있습니다",
                    "The ledger is locked by another process",
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
pub fn append(cwd: &Path, candidates: &[Value]) -> Result<usize> {
    // Validate without creating any filesystem state on rejected input.
    let mut preflight = read(cwd)?;
    preflight.extend_from_slice(candidates);
    model::reduce(&preflight)?;
    if candidates.is_empty() {
        return Ok(0);
    }
    let dir = directories(cwd, true)?.ok_or_else(|| corrupt("directory"))?;
    let root = cwd.join(".gdm");
    let root_id = identity(&root, true)?;
    let dir_id = identity(&dir, true)?;
    let lease = acquire(&dir)?;
    same(&root, true, root_id)?;
    same(&dir, true, dir_id)?;
    let text = raw(&dir)?;
    let current = parse(&text)?;
    let state = model::reduce(&current)?;
    let mut combined = current;
    combined.extend_from_slice(candidates);
    model::reduce(&combined)?;
    let mut known = state
        .events
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let mut additions = Vec::new();
    for candidate in candidates {
        if known.insert(model::s(candidate, "eventId").into()) {
            additions.push(serde_json::to_string(candidate)?);
        }
    }
    if additions.is_empty() {
        return Ok(0);
    }
    let temp = dir.join(".ledger.tmp");
    if inspect(&temp, false)?.is_some() {
        fs::remove_file(&temp).map_err(|_| corrupt("stale-temp"))?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(&temp)
        .map_err(|_| corrupt("temp"))?;
    let meta = file.metadata()?;
    let temp_id = Identity(meta.dev(), meta.ino());
    let write_result = (|| {
        file.write_all(text.as_bytes())?;
        if !text.is_empty() && !text.ends_with('\n') {
            file.write_all(b"\n")?;
        }
        for line in &additions {
            file.write_all(line.as_bytes())?;
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        same(&root, true, root_id)?;
        same(&dir, true, dir_id)?;
        same(&lease.path, false, lease.identity)?;
        same(&temp, false, temp_id)?;
        inspect(&dir.join("ledger.jsonl"), false)?;
        fs::rename(&temp, dir.join("ledger.jsonl"))?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_DIRECTORY)
            .open(&dir)?;
        directory.sync_all()?;
        Ok::<_, Error>(())
    })();
    if same(&temp, false, temp_id).is_ok() {
        let _ = fs::remove_file(&temp);
    }
    write_result?;
    Ok(additions.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn event() -> Value {
        let mut e = json!({"schemaVersion":1,"eventId":"","at":"2026-09-21T00:00:00.000Z","kind":"observation","pattern":"verification.failed-recheck","taxonomy":"verification","sourceToken":"src-test","sourceGroup":"grp-test","sourceKind":"incident"});
        e["eventId"] = model::expected_id(&e).into();
        e
    }
    #[test]
    fn replay_and_tamper() {
        let repo = tempfile::tempdir().unwrap();
        assert_eq!(append(repo.path(), &[event()]).unwrap(), 1);
        assert_eq!(append(repo.path(), &[event()]).unwrap(), 0);
        let path = repo.path().join(".gdm/habits/ledger.jsonl");
        let bytes = fs::read_to_string(&path).unwrap();
        fs::write(path, bytes.replace("src-test", "src-other")).unwrap();
        assert_eq!(read(repo.path()).unwrap_err().code, "habit_ledger_corrupt");
    }
    #[test]
    fn symlink_ledger_is_rejected() {
        let repo = tempfile::tempdir().unwrap();
        fs::create_dir_all(repo.path().join(".gdm/habits")).unwrap();
        let external = repo.path().join("external");
        fs::write(&external, "secret").unwrap();
        std::os::unix::fs::symlink(&external, repo.path().join(".gdm/habits/ledger.jsonl"))
            .unwrap();
        assert_eq!(
            append(repo.path(), &[event()]).unwrap_err().code,
            "habit_ledger_corrupt"
        );
        assert_eq!(fs::read_to_string(external).unwrap(), "secret");
    }
    #[test]
    fn rejected_batch_never_writes() {
        let repo = tempfile::tempdir().unwrap();
        let e = event();
        let mut bad = e.clone();
        bad["taxonomy"] = "unknown".into();
        assert!(append(repo.path(), &[e, bad]).is_err());
        assert!(!repo.path().join(".gdm/habits/ledger.jsonl").exists());
    }
}
