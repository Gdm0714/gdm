use super::{
    state::{self, b, s},
    store,
};
use crate::support::{Error, Result, now, sha256};
use serde_json::{Value, json};
use std::{
    io::Read,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
const MAX_OUTPUT: usize = 10 * 1024 * 1024;
pub struct Execution {
    pub body: String,
    pub output: String,
    pub code: Option<i32>,
    pub error: Option<String>,
}
struct CommandGroup {
    child: Child,
    reaped: bool,
}
impl CommandGroup {
    fn observe_exit(&self) -> Result<bool> {
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        let pid = Pid::from_raw(self.child.id() as i32)
            .ok_or_else(|| Error::new("cmd_failed", "invalid child PID"))?;
        Ok(waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        )
        .map_err(std::io::Error::from)?
        .is_some())
    }
    fn stop(&mut self) -> Result<std::process::ExitStatus> {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.child.id() as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
        let status = self.child.wait()?;
        self.reaped = true;
        Ok(status)
    }
}
impl Drop for CommandGroup {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.stop();
        }
    }
}
struct Signals {
    flag: Arc<AtomicBool>,
    ids: Vec<signal_hook::SigId>,
}
impl Signals {
    fn new() -> Result<Self> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut guard = Self { flag, ids: vec![] };
        for sig in [
            signal_hook::consts::SIGINT,
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGHUP,
        ] {
            guard
                .ids
                .push(signal_hook::flag::register(sig, guard.flag.clone())?);
        }
        Ok(guard)
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        for id in &self.ids {
            signal_hook::low_level::unregister(*id);
        }
    }
}
pub fn execute(cwd: &Path, cmd: &str) -> Result<Execution> {
    let timeout = match std::env::var("GDM_COMMAND_TIMEOUT_MS")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        None => None,
        Some(s) => {
            let ms = s.trim().parse::<u64>().map_err(|_| {
                Error::new(
                    "usage",
                    crate::i18n::text(
                        "GDM_COMMAND_TIMEOUT_MS는 밀리초 단위 정수여야 합니다",
                        "GDM_COMMAND_TIMEOUT_MS must be an integer in milliseconds",
                    ),
                )
            })?;
            if !(100..=3_600_000).contains(&ms) {
                return Err(Error::new(
                    "usage",
                    crate::i18n::text(
                        "GDM_COMMAND_TIMEOUT_MS는 100~3600000 범위여야 합니다",
                        "GDM_COMMAND_TIMEOUT_MS must be between 100 and 3600000",
                    ),
                ));
            }
            Some(Duration::from_millis(ms))
        }
    };
    crate::lprint!("실행: {cmd}", "Running: {cmd}");
    execute_bounded(cwd, cmd, timeout)
}

/// Execute an explicitly supplied command with the same process-group and
/// output limits as a check, without printing into a caller's JSON response.
pub(crate) fn execute_bounded(
    cwd: &Path,
    cmd: &str,
    timeout: Option<Duration>,
) -> Result<Execution> {
    let signals = Signals::new()?;
    let child = Command::new("bash")
        .args(["-c", cmd])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| Error::new("cmd_failed", e.to_string()))?;
    let mut owned = CommandGroup {
        child,
        reaped: false,
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let read = |mut stream: Box<dyn Read + Send>, overflow: Arc<AtomicBool>| {
        thread::spawn(move || {
            let mut bytes = vec![];
            let mut chunk = [0u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let keep = n.min(MAX_OUTPUT.saturating_sub(bytes.len()));
                        bytes.extend(&chunk[..keep]);
                        if keep < n {
                            overflow.store(true, Ordering::Relaxed);
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            bytes
        })
    };
    let stdout = read(
        Box::new(owned.child.stdout.take().unwrap()),
        overflow.clone(),
    );
    let stderr = read(
        Box::new(owned.child.stderr.take().unwrap()),
        overflow.clone(),
    );
    let started = Instant::now();
    let mut error = None;
    let status = loop {
        if signals.flag.load(Ordering::Relaxed) {
            error = Some(
                crate::i18n::text(
                    "INTERRUPTED: 검증 명령 취소됨",
                    "INTERRUPTED: verification command cancelled",
                )
                .into(),
            );
            break owned.stop()?;
        }
        if overflow.load(Ordering::Relaxed) || timeout.is_some_and(|t| started.elapsed() >= t) {
            error = Some(
                if overflow.load(Ordering::Relaxed) {
                    crate::i18n::text("출력 크기 상한 초과", "Output size limit exceeded")
                } else {
                    crate::i18n::text(
                        "ETIMEDOUT: 명령 시간 제한 초과",
                        "ETIMEDOUT: command time limit exceeded",
                    )
                }
                .to_owned(),
            );
            break owned.stop()?;
        }
        if owned.observe_exit()? {
            break owned.stop()?;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    if overflow.load(Ordering::Relaxed) {
        error = Some(crate::i18n::text("출력 크기 상한 초과", "Output size limit exceeded").into())
    }
    let mut output = String::from_utf8_lossy(&out).into_owned();
    if !err.is_empty() {
        output.push_str("\n[stderr]\n");
        output.push_str(&String::from_utf8_lossy(&err));
    }
    let code = status.code();
    let body = format!(
        "$ {cmd}\n(exit {})\n\n{output}",
        code.map(|n| n.to_string()).unwrap_or("null".into())
    );
    Ok(Execution {
        body,
        output,
        code,
        error,
    })
}
pub fn automatic(
    cwd: &Path,
    slug: &str,
    id: &str,
    cmd: &str,
    red: bool,
    write: bool,
) -> Result<Value> {
    let execution = execute(cwd, cmd)?;
    let observed = if write {
        store::output(
            cwd,
            slug,
            &format!("{id}{}.txt", if red { "-red" } else { "" }),
            execution.body.as_bytes(),
        )?
    } else {
        format!(".gdm/{slug}/out/{id}.txt")
    };
    if let Some(e) = execution.error {
        return Err(Error::new(
            if e.starts_with("INTERRUPTED:") {
                "interrupted"
            } else {
                "cmd_failed"
            },
            e,
        ));
    }
    if execution.code.is_none() || !red && execution.code != Some(0) {
        return Err(Error::new(
            "cmd_failed",
            crate::lfmt!(
                "검증 실패: {observed}\n{}",
                "Verification failed: {observed}\n{}",
                execution
                    .output
                    .lines()
                    .rev()
                    .take(15)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        ));
    }
    if red && execution.code == Some(0) {
        return Err(Error::new(
            "red_expected_failure",
            crate::i18n::text(
                "red 재현이 성공했습니다",
                "The red reproduction succeeded unexpectedly",
            ),
        ));
    }
    Ok(
        json!({"observed":observed,"sha256":sha256(execution.body),"exitCode":execution.code,"manual":false}),
    )
}
pub fn revert(work: &mut Value, index: usize, red: bool) {
    let id = s(&work["checks"][index]["id"]).to_owned();
    super::verification::evidence_replaced(work, &id);
    work["checks"][index]["status"] = json!("open");
    work["checks"][index]
        .as_object_mut()
        .unwrap()
        .remove("evidence");
    if red {
        work["checks"][index]
            .as_object_mut()
            .unwrap()
            .remove("redEvidence");
    }
}
pub fn recheck(
    cwd: &Path,
    work: &mut Value,
    only: Option<&str>,
    validate: bool,
) -> Result<Vec<String>> {
    recheck_observed(cwd, work, only, validate).map(|(failed, _)| failed)
}
pub fn automatic_bound(
    cwd: &Path,
    work: &Value,
    id: &str,
    cmd: &str,
    red: bool,
    write: bool,
) -> Result<Value> {
    if !super::verification::active(work) {
        return automatic(cwd, s(&work["slug"]), id, cmd, red, write);
    }
    let before = super::verification::observe(cwd, work)?;
    let mut evidence = automatic(cwd, s(&work["slug"]), id, cmd, red, write)?;
    let after = super::verification::observe(cwd, work)?;
    super::verification::assert_unchanged(&before, &after)?;
    if let Some(binding) = super::verification::bind(work, id, &before, &after, false) {
        evidence["verificationBinding"] = binding;
    }
    Ok(evidence)
}
pub fn recheck_observed(
    cwd: &Path,
    work: &mut Value,
    only: Option<&str>,
    validate: bool,
) -> Result<(Vec<String>, Vec<Value>)> {
    let targets = state::checks(work)
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            c["status"] == "proven" && !b(&c["manual"]) && only.is_none_or(|id| c["id"] == id)
        })
        .map(|(i, c)| (i, c.clone()))
        .collect::<Vec<_>>();
    if only.is_some() && targets.is_empty() {
        return Err(Error::new(
            "not_recheckable",
            crate::i18n::text(
                "통과한 자동 항목만 재검증 가능",
                "Only proven automatic checks can be rechecked",
            ),
        ));
    }
    let slug = s(&work["slug"]).to_owned();
    let ts = now();
    let mut failed = vec![];
    let mut observations = vec![];
    for (i, c) in targets {
        // Replacing evidence invalidates the old completion and audit binding.
        // Validation-only replay retains them unless the check actually fails.
        if !validate {
            super::verification::invalidate(work);
            work["done"] = json!(false);
            work.as_object_mut().unwrap().remove("doneAt");
        }
        let id = s(&c["id"]);
        match automatic_bound(cwd, work, id, s(&c["cmd"]), false, !validate) {
            Ok(mut evidence) => {
                let hash = evidence["sha256"].clone();
                observations.push(json!({"checkId":id,"sha256":hash,"exitCode":evidence["exitCode"],"binding":evidence["verificationBinding"]}));
                if !validate {
                    super::verification::evidence_replaced(work, id);
                    evidence["at"] = json!(ts);
                    work["checks"][i]["evidence"] = evidence;
                }
                store::append_journal(
                    cwd,
                    &slug,
                    &json!({"ts":ts,"event":"recheck","check":id,"ok":true,"mode":if validate{"validate"}else{"refresh"},"sha256":hash}),
                )?;
            }
            Err(e) if e.code == "cmd_failed" || e.code.starts_with("verification_") => {
                work["done"] = json!(false);
                work.as_object_mut().unwrap().remove("doneAt");
                revert(work, i, false);
                failed.push(id.to_owned());
                store::append_journal(
                    cwd,
                    &slug,
                    &json!({"ts":ts,"event":"recheck","check":id,"ok":false,"message":e.message}),
                )?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok((failed, observations))
}
pub fn stale(cwd: &Path, work: &Value) -> Vec<(usize, bool, String)> {
    let mut result = vec![];
    for (i, c) in state::checks(work).iter().enumerate() {
        for (key, red) in [("redEvidence", true), ("evidence", false)] {
            if !red && c["status"] != "proven" {
                continue;
            }
            if let Some(e) = c.get(key) {
                match store::contained(cwd, s(&e["observed"]), "evidence", usize::MAX / 2) {
                    Ok(bytes) if sha256(&bytes) == s(&e["sha256"]) => {}
                    _ => result.push((
                        i,
                        red,
                        crate::lfmt!(
                            "{} 증거 파일 누락 또는 변경",
                            "{} evidence file is missing or changed",
                            s(&c["id"])
                        ),
                    )),
                }
            }
        }
    }
    result
}
