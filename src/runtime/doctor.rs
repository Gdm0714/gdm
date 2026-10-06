use super::{
    state::{b, s, valid_hash},
    store,
};
use crate::support::{Result, sha256};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
const SKILLS: [&str; 13] = [
    "go", "full", "plan", "review", "analyze", "research", "pr", "ui", "db", "design", "reflect",
    "email", "document",
];
fn file(root: &Path, relative: &str, executable: bool) -> Option<PathBuf> {
    let canonical_root = root.canonicalize().ok()?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || executable && metadata.permissions().mode() & 0o111 == 0
    {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    if canonical == canonical_root || !canonical.starts_with(canonical_root) {
        return None;
    }
    Some(canonical)
}
fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn hash_file(root: &Path, relative: &str, hash: &Value) -> bool {
    valid_hash(s(hash))
        && file(root, relative, true)
            .and_then(|p| fs::read(p).ok())
            .is_some_and(|bytes| sha256(bytes) == s(hash))
}
fn runner(root: &Path, v: &Value) -> bool {
    if !exact(v, &["contract", "path", "sha256", "adapters"])
        || v["contract"] != "gdm-role-runner/v1"
        || v["path"] != "gdm-agents/run-role.sh"
        || !hash_file(root, "gdm-agents/run-role.sh", &v["sha256"])
        || !exact(&v["adapters"], &["codex", "claude", "pi"])
    {
        return false;
    }
    for name in ["codex", "claude", "pi"] {
        let a = &v["adapters"][name];
        let path = format!("gdm-agents/providers/{name}.sh");
        if !exact(a, &["path", "sha256"])
            || a["path"] != path
            || !hash_file(root, &path, &a["sha256"])
        {
            return false;
        }
    }
    true
}
fn manifest(target: &str, root: &Path) -> (String, Option<String>) {
    let path = root.join("gdm-target-manifest.json");
    if !path.exists() {
        return (
            format!(
                "  protocol target {target}: WARN manifest[missing] source[unavailable] profile[unavailable] hook[unavailable] runner[unavailable] — manifest missing"
            ),
            None,
        );
    }
    let mut problems = vec![];
    let value = file(root, "gdm-target-manifest.json", false)
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(value) = value.filter(Value::is_object) else {
        return (
            format!(
                "  protocol target {target}: ERROR manifest[drift] source[unavailable] profile[invalid] hook[invalid] runner[invalid] — manifest JSON is malformed or unsafe"
            ),
            None,
        );
    };
    if !exact(
        &value,
        &[
            "schemaVersion",
            "target",
            "adapterVersion",
            "canonicalSourceSha256",
            "sourceSha256",
            "capabilityProfile",
            "hook",
            "runner",
            "skills",
        ],
    ) {
        problems.push("top-level schema keys differ".to_owned())
    }
    for (key, expected) in [
        ("schemaVersion", "gdm-target-skill-manifest/v1"),
        ("target", target),
        ("adapterVersion", "gdm-target-adapter/v1"),
    ] {
        if value[key] != expected {
            problems.push(format!("{key} differs"))
        }
    }
    let source = valid_hash(s(&value["canonicalSourceSha256"]))
        .then(|| s(&value["canonicalSourceSha256"]).to_owned());
    if source.is_none() {
        problems.push("canonical source hash is invalid".into())
    }
    if !valid_hash(s(&value["sourceSha256"])) {
        problems.push("source hash is invalid".into())
    }
    let profile = value["capabilityProfile"]
        == json!({"id":"gdm-read-only-specialist/v1","filesystem":"read-only","delegation":"disabled","mcp":"disabled","shell":"unsupported","browser":"unsupported","network":"unsupported"});
    if !profile {
        problems.push("capability profile differs".into())
    }
    let hook = value["hook"]
        == if target == "codex" {
            json!({"id":"gdm-agent-gate-v1","status":"supported","requiredForTarget":true})
        } else {
            json!({"id":null,"status":"not-required","requiredForTarget":false})
        };
    if !hook {
        problems.push("hook capability differs".into())
    }
    let runner = runner(root, &value["runner"]);
    if !runner {
        problems.push("runner or provider adapter contract/hash differs".into())
    }
    let mut expected = SKILLS
        .iter()
        .map(|s| format!("gdm-{s}"))
        .collect::<Vec<_>>();
    expected.sort();
    let mut names = vec![];
    let name_pattern = regex::Regex::new(r"^gdm-[a-z][a-z0-9-]*$").unwrap();
    if let Some(skills) = value["skills"].as_array() {
        for (index, skill) in skills.iter().enumerate() {
            if !exact(
                skill,
                &["name", "sourcePath", "sourceSha256", "renderedSha256"],
            ) {
                problems.push(format!("skill {} schema differs", index + 1));
                continue;
            }
            let name = s(&skill["name"]);
            names.push(name.to_owned());
            if !name_pattern.is_match(name)
                || skill["sourcePath"]
                    != format!("skills/{}", name.strip_prefix("gdm-").unwrap_or(""))
            {
                problems.push(format!("skill {} identity differs", index + 1))
            }
            if !valid_hash(s(&skill["sourceSha256"])) {
                problems.push(format!("skill {name} source hash is invalid"))
            }
            if !valid_hash(s(&skill["renderedSha256"])) {
                problems.push(format!("skill {name} rendered hash is invalid"));
                continue;
            }
            match file(root, &format!("{name}/SKILL.md"), false).and_then(|p| fs::read(p).ok()) {
                None => problems.push(format!("skill {name} is missing or unsafe")),
                Some(bytes) if sha256(&bytes) != s(&skill["renderedSha256"]) => {
                    problems.push(format!("skill {name} rendered bytes drifted"))
                }
                _ => {}
            }
        }
        if names != expected {
            problems.push("installed skill set differs".into());
        }
    } else {
        problems.push("skills list is invalid".into())
    }
    let valid = problems.is_empty();
    let source_label = source
        .as_ref()
        .map(|s| format!("{}…", &s[..12]))
        .unwrap_or("unavailable".into());
    let detail = if valid {
        String::new()
    } else {
        format!(" — {}", problems.join(", "))
    };
    (
        format!(
            "  protocol target {target}: {} manifest[{}] source[{source_label}] profile[{}] hook[{}] runner[{}]{detail}",
            if valid { "OK" } else { "ERROR" },
            if valid { "valid" } else { "drift" },
            if profile {
                "gdm-read-only-specialist/v1"
            } else {
                "invalid"
            },
            if !hook {
                "invalid"
            } else if target == "codex" {
                "supported"
            } else {
                "not-required"
            },
            if runner { "supported" } else { "invalid" }
        ),
        source,
    )
}
pub fn run(cwd: &Path) -> Result<()> {
    println!("gdm {}", env!("CARGO_PKG_VERSION"));
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let setting = |name: &str, default: PathBuf| {
        let p = std::env::var(name)
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or(default);
        if p.is_absolute() { p } else { cwd.join(p) }
    };
    let codex = setting("CODEX_HOME", home.join(".codex"));
    let pi = setting("PI_CODING_AGENT_DIR", home.join(".pi/agent"));
    if let Ok(link) = home.join(".claude/skills/gdm-go").canonicalize()
        && let Some(root) = link.parent().and_then(Path::parent)
        && let Ok(bytes) = fs::read(root.join("cli/package.json"))
        && let Ok(v) = serde_json::from_slice::<Value>(&bytes)
        && let Some(version) = v["version"].as_str()
    {
        if version == env!("CARGO_PKG_VERSION") {
            println!("  저장소: {version} (바이너리와 일치)");
        } else {
            println!(
                "  저장소: {version} — 바이너리({})와 다릅니다 → {} 재실행",
                env!("CARGO_PKG_VERSION"),
                root.join("install/install.sh").display()
            );
        }
    }
    for line in crate::integrations::doctor_lines(cwd)? {
        println!("{line}");
    }
    let targets = [
        ("codex", codex.join("skills")),
        ("claude", home.join(".claude/skills")),
        ("pi", pi.join("skills")),
    ];
    let mut hashes = vec![];
    for (target, root) in &targets {
        let (line, hash) = manifest(target, root);
        println!("{line}");
        hashes.push(hash);
    }
    if hashes.iter().all(Option::is_some) {
        if hashes.windows(2).all(|a| a[0] == a[1]) {
            println!(
                "  protocol target source parity: OK [{}…]",
                &hashes[0].as_ref().unwrap()[..12]
            );
        } else {
            println!("  protocol target source parity: ERROR [mismatch]");
        }
    } else {
        println!("  protocol target source parity: WARN [unavailable]");
    }
    let mut missing = false;
    for skill in SKILLS {
        let mark = |root: &Path| {
            if root.join("skills").join(format!("gdm-{skill}")).exists() {
                "OK"
            } else {
                "없음"
            }
        };
        let a = mark(&home.join(".claude"));
        let c = mark(&codex);
        let p = mark(&pi);
        missing |= [a, c, p].contains(&"없음");
        println!("  gdm-{skill}: claude[{a}] codex[{c}] pi[{p}]");
    }
    if missing {
        println!("  → 누락 스킬은 재설치로 채웁니다: install/install.sh");
    }
    let works = store::list(cwd)?;
    println!(
        "  현재 디렉토리 작업: {}개 (진행 중 {}개)",
        works.len(),
        works.iter().filter(|w| !b(&w["done"])).count()
    );
    Ok(())
}
