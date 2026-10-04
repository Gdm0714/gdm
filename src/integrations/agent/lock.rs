//! Cross-version lock publication remains compatible with the legacy CLI.
use crate::support::{Error, Result, sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
pub struct Lock {
    path: PathBuf,
    token: String,
}
impl Drop for Lock {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.path)
            .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
            && fs::read_to_string(&self.path).is_ok_and(|s| s.trim() == self.token)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn alive(pid: i32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) != Err(nix::errno::Errno::ESRCH)
}
fn start_digest(pid: i32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/bin/ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let started = String::from_utf8(output.stdout).ok()?.trim().to_owned();
        if started.is_empty() {
            None
        } else {
            Some(sha256(format!("darwin:{started}")))
        }
    }
    #[cfg(target_os = "linux")]
    {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let tail = &stat[stat.rfind(')')? + 1..];
        let ticks = tail.split_whitespace().nth(19)?;
        let boot =
            fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap_or("unknown-boot".into());
        Some(sha256(format!("linux:{}:{ticks}", boot.trim())))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}
fn owner_live(path: &Path, incarnation: bool) -> bool {
    let Ok(token) = fs::read_to_string(path) else {
        return true;
    };
    let token = token.trim();
    if incarnation {
        let Some(c) = regex::Regex::new(r"^v2:([1-9][0-9]*):([a-f0-9]{64}|unknown):([a-f0-9]+)$")
            .unwrap()
            .captures(token)
        else {
            return false;
        };
        let Ok(pid) = c[1].parse::<i32>() else {
            return false;
        };
        alive(pid) && start_digest(pid).is_some_and(|d| d == c[2])
    } else {
        let Some(c) = regex::Regex::new(r"^([1-9][0-9]*)-[a-f0-9]{24}$")
            .unwrap()
            .captures(token)
        else {
            return false;
        };
        c[1].parse::<i32>().is_ok_and(alive)
    }
}
pub fn acquire(path: &Path, incarnation: bool) -> Result<Lock> {
    let pid = std::process::id() as i32;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let token = if incarnation {
        format!(
            "v2:{pid}:{}:{}",
            start_digest(pid).unwrap_or("unknown".into()),
            &nonce[..24]
        )
    } else {
        format!("{pid}-{}", &nonce[..24])
    };
    let started = Instant::now();
    loop {
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut file) => {
                writeln!(file, "{token}")?;
                file.sync_all()?;
                return Ok(Lock {
                    path: path.to_owned(),
                    token,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let observed = match fs::symlink_metadata(path) {
                    Ok(m) => m,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                if !observed.is_file() || observed.file_type().is_symlink() {
                    return Err(Error::new(
                        "agent_state_path_invalid",
                        "lock path is not a regular file",
                    ));
                }
                let stale = observed
                    .modified()
                    .ok()
                    .and_then(|m| m.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(30));
                if stale
                    && !owner_live(path, incarnation)
                    && fs::symlink_metadata(path).is_ok_and(|m| {
                        m.dev() == observed.dev()
                            && m.ino() == observed.ino()
                            && m.mtime() == observed.mtime()
                    })
                    && !owner_live(path, incarnation)
                {
                    let _ = fs::remove_file(path);
                    continue;
                }
            }
            Err(e) => return Err(e.into()),
        }
        if started.elapsed() >= Duration::from_secs(5) {
            return Err(Error::new(
                "agent_state_lock_timeout",
                format!("agent ledger lock timed out: {}", path.display()),
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
