//! Durable state and journal storage. Never traverse user-controlled symlinks.
use super::state;
use crate::support::{Error, Result, now, sha256};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const MAX_STATE: u64 = 16 * 1024 * 1024;
const MAX_JOURNAL: u64 = 64 * 1024 * 1024;
const FORMAT: &str = "gdm-journal-anchor/v1\n";
fn bad(m: impl Into<String>) -> Error {
    Error::new("state_corrupt", m)
}
pub fn root(cwd: &Path) -> PathBuf {
    cwd.join(".gdm")
}
pub fn inspect(path: &Path, directory: bool) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            if m.file_type().is_symlink()
                || (directory && !m.is_dir())
                || (!directory && !m.is_file())
            {
                return Err(bad(format!("안전하지 않은 상태 경로: {}", path.display())));
            }
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(bad(e.to_string())),
    }
}
pub fn ensure_dir(path: &Path) -> Result<()> {
    if !inspect(path, true)? {
        match fs::create_dir(path) {
            Ok(()) => fs::set_permissions(path, fs::Permissions::from_mode(0o700))?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        };
        inspect(path, true)?;
        if let Some(p) = path.parent() {
            File::open(p)?.sync_all()?;
        }
    }
    Ok(())
}
pub fn work_dir(cwd: &Path, id: &str) -> Result<PathBuf> {
    state::validate_slug(id)?;
    let r = root(cwd);
    inspect(&r, true)?;
    let p = r.join(id);
    inspect(&p, true)?;
    Ok(p)
}
pub fn ensure_work_dir(cwd: &Path, id: &str) -> Result<PathBuf> {
    state::validate_slug(id)?;
    let r = root(cwd);
    ensure_dir(&r)?;
    let p = r.join(id);
    ensure_dir(&p)?;
    Ok(p)
}
pub fn read_regular(path: &Path, max: u64) -> Result<Vec<u8>> {
    if !inspect(path, false)? {
        return Err(Error::new(
            "file_missing",
            format!("파일 없음: {}", path.display()),
        ));
    }
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let m = f.metadata()?;
    if !m.is_file() || m.len() > max {
        return Err(bad("파일 크기 또는 유형 오류"));
    }
    let mut b = Vec::new();
    (&mut f).take(max.saturating_add(1)).read_to_end(&mut b)?;
    if b.len() as u64 > max {
        return Err(bad("파일 크기 상한 초과"));
    }
    if b.len() as u64 != m.len() {
        return Err(bad("읽는 동안 파일 길이가 바뀜"));
    }
    Ok(b)
}
pub fn read_json(path: &Path) -> Result<Value> {
    let bytes = read_regular(path, MAX_STATE)?;
    serde_json::from_slice(&bytes).map_err(|e| bad(format!("{}: {e}", path.display())))
}
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic_mode(path, bytes, 0o600)
}
pub fn write_atomic_mode(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().ok_or_else(|| bad("부모 경로 없음"))?;
    inspect(parent, true)?;
    inspect(path, false)?;
    if bytes.len() as u64 > MAX_STATE {
        return Err(bad("상태 파일 크기 상한 초과"));
    }
    let temp = parent.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&temp)?;
        f.set_permissions(fs::Permissions::from_mode(mode))?;
        f.write_all(bytes)?;
        f.sync_all()?;
        inspect(path, false)?;
        fs::rename(&temp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
pub fn write_json_atomic(path: &Path, v: &Value) -> Result<()> {
    let mut b = serde_json::to_vec_pretty(v)?;
    b.push(b'\n');
    write_atomic(path, &b)
}
pub fn load(cwd: &Path, id: &str) -> Result<Value> {
    let p = work_dir(cwd, id)?.join("checks.json");
    if !inspect(&p, false)? {
        return Err(Error::new("work_not_found", format!("작업 {id} 없음")));
    }
    let v = state::validate_work(read_json(&p)?)?;
    if v["slug"] != id {
        return Err(bad("디렉토리와 slug 불일치"));
    }
    Ok(v)
}
pub fn save(cwd: &Path, v: &Value) -> Result<()> {
    let v = state::validate_work(v.clone())?;
    let p = ensure_work_dir(cwd, state::s(&v["slug"]))?;
    ensure_dir(&p.join("out"))?;
    write_json_atomic(&p.join("checks.json"), &v)?;
    write_atomic(&p.join("work.md"), render_work(&v).as_bytes())
}
pub fn render_work(w: &Value) -> String {
    use state::{b, s};
    let c = &w["contract"];
    let list = |v: &Value, fallback: &str| {
        let items = v
            .as_array()
            .map(|a| a.iter().map(s).collect::<Vec<_>>())
            .unwrap_or_default();
        if items.is_empty() {
            fallback.to_owned()
        } else {
            items.join(", ")
        }
    };
    let status = if b(&w["done"]) {
        format!(
            "완료 ({}/{}) · {}",
            state::proven_count(w),
            state::checks(w).len(),
            s(&w["doneAt"])
        )
    } else {
        format!(
            "진행 중 ({}/{}) · 시작 {}",
            state::proven_count(w),
            state::checks(w).len(),
            s(&w["createdAt"])
        )
    };
    let mut lines = vec![
        format!("# {}", s(&w["slug"])),
        String::new(),
        format!("> {status}"),
        String::new(),
        "## 목표".into(),
        String::new(),
        s(&w["brief"]).into(),
        String::new(),
    ];
    if let Some(o) = c.get("outcome") {
        lines.extend(["## 선언한 outcome (GDM 미측정)".into(), String::new()]);
        for (key, label) in [
            ("bottleneck", "병목"),
            ("desiredOutcome", "원하는 결과"),
            ("baseline", "기준선"),
            ("target", "목표"),
            ("unit", "단위"),
            ("interveneIf", "개입 조건"),
        ] {
            lines.push(format!("- {label}: {}", s(&o[key])));
        }
        lines.push(String::new());
    }
    lines.extend([
        "## 작업 계약".into(),
        String::new(),
        format!("- 커밋: {}", s(&c["commit"])),
        format!("- 위험도: {}", s(&c["risk"])),
        format!("- 검증 가능성: {}", s(&c["verification"])),
        format!("- 허용 경로: {}", list(&c["allowedPaths"], ".")),
        format!("- 금지 경로: {}", list(&c["forbiddenPaths"], "없음")),
        format!("- 가정: {}", list(&c["assumptions"], "없음")),
        format!("- 불확실성: {}", list(&c["uncertainties"], "없음")),
        format!("- 중단 조건: {}", list(&c["stopConditions"], "없음")),
        format!(
            "- 간소화 증거: {}",
            if b(&c["simplificationRequired"]) {
                "필수"
            } else {
                "선택"
            }
        ),
    ]);
    for (key, label) in [("required", "필수"), ("forbidden", "금지")] {
        lines.push(format!("- {label}:"));
        let values = c[key].as_array().unwrap();
        if values.is_empty() {
            lines.push("  - 없음".into());
        } else {
            for v in values {
                lines.push(format!("  - {}", s(v)));
            }
        }
    }
    lines.extend([
        String::new(),
        "## 확인 항목".into(),
        String::new(),
        "| ID | 상태 | 종류 | 항목 | 재현 명령 | 기대 | red 증거 | green 증거 |".into(),
        "|---|---|---|---|---|---|---|---|".into(),
    ]);
    for check in state::checks(w) {
        let how = if b(&check["manual"]) {
            format!(
                "(수동 확인{})",
                if b(&check["expert"]) {
                    " · expert"
                } else {
                    ""
                }
            )
        } else {
            format!("`{}`", s(&check["cmd"]))
        };
        lines.push(format!(
            "| {} | {} | {} | {} | {how} | {} | {} | {} |",
            s(&check["id"]),
            if check["status"] == "proven" {
                "✅"
            } else {
                "⬜"
            },
            state::kind(check),
            s(&check["desc"]),
            s(&check["expect"]),
            check["redEvidence"]["observed"].as_str().unwrap_or("—"),
            check["evidence"]["observed"].as_str().unwrap_or("—")
        ));
    }
    if let Some(d) = w.get("delivery") {
        lines.extend([
            String::new(),
            "## 전달".into(),
            String::new(),
            format!("- 이슈: {}", s(&d["issue"])),
            format!("- 브랜치: {}", s(&d["branch"])),
            format!("- HEAD: {}", s(&d["head"])),
            format!("- PR: {}", d["pr"]["number"].as_str().unwrap_or("—")),
            format!("- CI: {}", d["ci"]["status"].as_str().unwrap_or("—")),
            format!(
                "- 머지 승인: {}",
                if d.get("mergeApproval").is_some() {
                    "승인"
                } else {
                    "—"
                }
            ),
            format!("- 머지 SHA: {}", d["merged"]["sha"].as_str().unwrap_or("—")),
        ]);
    }
    lines.push(String::new());
    lines.join("\n")
}
pub fn list(cwd: &Path) -> Result<Vec<Value>> {
    let r = root(cwd);
    if !inspect(&r, true)? {
        return Ok(vec![]);
    }
    let mut names = fs::read_dir(&r)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    let mut out = vec![];
    for n in names {
        if state::validate_slug(&n).is_err() {
            continue;
        }
        let p = r.join(&n);
        if inspect(&p, true).unwrap_or(false) && p.join("checks.json").exists() {
            match load(cwd, &n) {
                Ok(v) => out.push(v),
                Err(e) => eprintln!("경고: 작업 {n} 건너뜀 — {e}"),
            }
        }
    }
    Ok(out)
}
pub fn resolve(cwd: &Path, id: Option<&str>, read: bool) -> Result<Value> {
    if let Some(id) = id {
        return load(cwd, id);
    }
    let works = list(cwd)?;
    let active = works
        .iter()
        .filter(|w| !state::b(&w["done"]))
        .collect::<Vec<_>>();
    match active.len() {
        1 => return Ok(active[0].clone()),
        n if n > 1 => {
            return Err(Error::new(
                "ambiguous_slug",
                "진행 중인 작업이 여러 개입니다. --slug 지정",
            ));
        }
        _ => {}
    }
    if !read || works.is_empty() {
        return Err(Error::new("no_active", "진행 중인 작업이 없습니다"));
    }
    let mut timed = vec![];
    for w in works {
        let journal = read_journal(cwd, state::s(&w["slug"]))?;
        let ts = journal
            .last()
            .map(|j| state::s(&j["ts"]))
            .unwrap_or(state::s(&w["createdAt"]))
            .to_owned();
        timed.push((ts, w));
    }
    timed.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(timed.remove(0).1)
}
fn journal_prefix(cwd: &Path, id: &str) -> Result<(PathBuf, Vec<u8>, Vec<Value>)> {
    let d = work_dir(cwd, id)?;
    if !inspect(&d, true)? {
        return Ok((d, vec![], vec![]));
    }
    let marker = d.join("journal.format");
    let anchor = d.join("journal.anchor");
    let file = d.join("journal.jsonl");
    let marked = inspect(&marker, false)?;
    if marked && read_regular(&marker, 128)? != FORMAT.as_bytes() {
        return Err(bad("journal.format 오류"));
    }
    let a = if inspect(&anchor, false)? {
        Some(serde_json::from_slice::<Value>(&read_regular(
            &anchor, 4096,
        )?)?)
    } else {
        None
    };
    if marked && a.is_none() {
        return Err(bad("journal.anchor 없음"));
    }
    if !inspect(&file, false)? {
        if a.is_some() {
            return Err(bad("anchor의 journal 없음"));
        }
        return Ok((d, vec![], vec![]));
    }
    let bytes = if let Some(a) = &a {
        if a.as_object().map(|o| o.len()) != Some(4)
            || a["schemaVersion"] != "gdm-journal-anchor/v1"
            || a["byteLength"].as_u64().is_none()
            || a["lineCount"].as_u64().is_none()
            || !state::valid_hash(state::s(&a["sha256"]))
        {
            return Err(bad("journal.anchor schema 오류"));
        }
        let n = a["byteLength"].as_u64().unwrap();
        if n > MAX_JOURNAL {
            return Err(bad("journal committed prefix 크기 상한 초과"));
        }
        let mut handle = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(&file)?;
        if !handle.metadata()?.is_file() || handle.metadata()?.len() < n {
            return Err(bad("journal이 anchor보다 짧음"));
        }
        let mut bytes = vec![0; n as usize];
        handle
            .read_exact(&mut bytes)
            .map_err(|_| bad("journal prefix를 읽을 수 없음"))?;
        if sha256(&bytes) != a["sha256"] {
            return Err(bad("journal 해시 불일치"));
        }
        bytes
    } else {
        read_regular(&file, MAX_JOURNAL)?
    };
    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        return Err(bad("journal 마지막 행 불완전"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| bad("journal UTF-8 오류"))?;
    let mut events = vec![];
    for line in text.split_terminator('\n') {
        if line.is_empty() || line.ends_with('\r') {
            return Err(bad("journal 비정규 행"));
        }
        let v: Value = serde_json::from_str(line)?;
        if !v.is_object() {
            return Err(bad("journal event가 객체가 아님"));
        }
        events.push(v);
    }
    if let Some(a) = a
        && a["lineCount"].as_u64() != Some(events.len() as u64)
    {
        return Err(bad("journal 행 수 불일치"));
    }
    Ok((d, bytes, events))
}
pub fn read_journal(cwd: &Path, id: &str) -> Result<Vec<Value>> {
    let events = journal_prefix(cwd, id)?.2;
    super::protocol::validate_journal(&events)?;
    Ok(events)
}
pub fn append_journal(cwd: &Path, id: &str, v: &Value) -> Result<()> {
    append_journal_batch(cwd, id, std::slice::from_ref(v))
}
pub fn append_journal_batch(cwd: &Path, id: &str, events: &[Value]) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    ensure_work_dir(cwd, id)?;
    let (d, mut bytes, prior) = journal_prefix(cwd, id)?;
    let mut combined = prior.clone();
    combined.extend_from_slice(events);
    super::protocol::validate_journal(&combined)?;
    let anchor = d.join("journal.anchor");
    let make_anchor = |b: &[u8], n: usize| json!({"schemaVersion":"gdm-journal-anchor/v1","byteLength":b.len(),"lineCount":n,"sha256":sha256(b)});
    if !inspect(&anchor, false)? {
        write_json_atomic(&anchor, &make_anchor(&bytes, prior.len()))?;
    }
    let mut f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(d.join("journal.jsonl"))?;
    f.set_len(bytes.len() as u64)?;
    f.seek(SeekFrom::End(0))?;
    for e in events {
        if !e.is_object() {
            return Err(bad("journal event 객체 필요"));
        }
        let mut line = serde_json::to_vec(e)?;
        line.push(b'\n');
        if bytes.len() + line.len() > MAX_JOURNAL as usize {
            return Err(bad("journal 크기 상한"));
        }
        f.write_all(&line)?;
        bytes.extend(line);
    }
    f.sync_all()?;
    if std::env::var("GDM_TEST_JOURNAL_FAILPOINT").as_deref() == Ok("after-data-fsync") {
        std::process::exit(86)
    }
    write_json_atomic(&anchor, &make_anchor(&bytes, prior.len() + events.len()))?;
    if std::env::var("GDM_TEST_JOURNAL_FAILPOINT").as_deref() == Ok("after-anchor-rename") {
        std::process::exit(86)
    }
    write_atomic(&d.join("journal.format"), FORMAT.as_bytes())
}
pub fn contained(cwd: &Path, value: &str, field: &str, max: usize) -> Result<Vec<u8>> {
    super::contract::assert_no_sensitive(value, field)?;
    let bad =
        |reason: &str| Error::new("path_rejected", format!("field={field} category={reason}"));
    if value.is_empty()
        || value.contains('\\')
        || Path::new(value).is_absolute()
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(bad("containment"));
    }
    let mut p = cwd.to_path_buf();
    for part in value.split('/') {
        super::contract::assert_no_sensitive(part, field)?;
        p.push(part);
        let m = fs::symlink_metadata(&p).map_err(|_| bad("missing"))?;
        if m.file_type().is_symlink() {
            return Err(bad("symlink"));
        }
    }
    let root = cwd.canonicalize()?;
    let p = p.canonicalize()?;
    if !p.starts_with(root) {
        return Err(bad("containment"));
    }
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(p)
        .map_err(|_| bad("read"))?;
    if !f.metadata()?.is_file() {
        return Err(bad("containment"));
    }
    if f.metadata()?.len() > max as u64 {
        return Err(Error::new("file_too_large", field));
    }
    let mut bytes = vec![];
    (&mut f)
        .take((max as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(Error::new("file_too_large", field));
    }
    Ok(bytes)
}
pub fn output(cwd: &Path, id: &str, name: &str, body: &[u8]) -> Result<String> {
    if !regex::Regex::new(r"^[a-z0-9][a-z0-9-]*\.txt$")
        .unwrap()
        .is_match(name)
    {
        return Err(Error::new("path_rejected", "evidence output filename"));
    }
    let d = ensure_work_dir(cwd, id)?.join("out");
    ensure_dir(&d).map_err(|_| Error::new("path_rejected", "unsafe output"))?;
    write_atomic(&d.join(name), body).map_err(|_| Error::new("path_rejected", "unsafe output"))?;
    Ok(format!(".gdm/{id}/out/{name}"))
}
pub struct Lock {
    path: PathBuf,
    dev: u64,
    ino: u64,
}
impl Drop for Lock {
    fn drop(&mut self) {
        if let Ok(m) = fs::symlink_metadata(&self.path)
            && m.dev() == self.dev
            && m.ino() == self.ino
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
pub fn lock(cwd: &Path) -> Result<Lock> {
    let path = cwd.join(".gdm.lock");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&path)
        {
            Ok(mut f) => {
                let m = f.metadata()?;
                writeln!(
                    f,
                    "{}",
                    json!({"pid":std::process::id(),"acquiredAt":now()})
                )?;
                return Ok(Lock {
                    path,
                    dev: m.dev(),
                    ino: m.ino(),
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let Ok(m) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if m.file_type().is_symlink() || !m.is_file() {
                    return Err(Error::new("state_lock_rejected", "잠금 경로 거부"));
                }
                let owner = read_regular(&path, 4096)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
                let stale = owner
                    .map(|value| {
                        let pid = value["pid"].as_i64().and_then(|p| i32::try_from(p).ok());
                        !pid.is_some_and(|p| {
                            p > 0
                                && matches!(
                                    nix::sys::signal::kill(nix::unistd::Pid::from_raw(p), None),
                                    Ok(()) | Err(nix::errno::Errno::EPERM)
                                )
                        })
                    })
                    .unwrap_or_else(|| {
                        m.modified()
                            .ok()
                            .and_then(|t| t.elapsed().ok())
                            .is_some_and(|d| d > Duration::from_secs(60))
                    });
                if stale {
                    if let Ok(cur) = fs::symlink_metadata(&path)
                        && cur.dev() == m.dev()
                        && cur.ino() == m.ino()
                    {
                        let _ = fs::remove_file(&path);
                    }
                    continue;
                }
            }
            Err(e) => return Err(e.into()),
        }
        if Instant::now() >= deadline {
            return Err(Error::new("state_busy", "다른 gdm이 상태를 갱신 중"));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

pub fn write_json_atomic_mode(path: &Path, v: &Value, mode: u32) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(v)?;
    bytes.push(b'\n');
    write_atomic_mode(path, &bytes, mode)
}
