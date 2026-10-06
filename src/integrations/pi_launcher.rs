//! Pi profile and pinned model policy lives in Rust; the launcher shell only execs.
use crate::support::{Error, Result};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};
const DEFAULT_MODEL: &str = "openai-codex/gpt-5.6-terra";
const THINKING: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
fn failure(code: i32, text: impl Into<String>) -> Error {
    Error::new(format!("runner_exit_{code}"), text)
}
fn model(v: &str) -> bool {
    v.len() <= 160
        && regex::Regex::new(r"^[A-Za-z0-9._+-]+/[A-Za-z0-9._+-]+$")
            .unwrap()
            .is_match(v)
}
fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}
fn find(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|p| p.join(name))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}
fn executable(path: PathBuf) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(failure(69, "gdm-pi: Pi executable not found"));
    }
    let p = fs::canonicalize(&path)
        .map_err(|_| failure(69, "gdm-pi: Pi executable is not a regular executable"))?;
    if !fs::metadata(&p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
        return Err(failure(
            69,
            "gdm-pi: Pi executable is not a regular executable",
        ));
    }
    Ok(p)
}
fn reserved(a: &str) -> bool {
    let key = a.split('=').next().unwrap_or(a);
    [
        "--provider",
        "--model",
        "--models",
        "--thinking",
        "--api-key",
        "--extension",
        "-e",
        "--skill",
        "--no-extensions",
        "--no-skills",
        "--tools",
        "-t",
        "--exclude-tools",
        "-xt",
        "--no-tools",
        "-nt",
        "--no-builtin-tools",
        "-nbt",
        "--system-prompt",
        "--append-system-prompt",
    ]
    .contains(&key)
}
pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    let mut rest = args;
    let mut profile = "auto";
    let mut raw = false;
    if let Some(first) = args.first().map(String::as_str) {
        match first {
            "auto" | "go" | "full" => {
                profile = first;
                rest = &args[1..];
            }
            "--raw" => {
                raw = true;
                rest = &args[1..];
            }
            "-h" | "--help" => {
                println!(
                    "usage: gdm-pi [auto|go|full] [pi arguments or initial prompt]\n       gdm-pi --raw [pi arguments]\n\nProfiles: auto (all installed GDM skills), go (daily loop), full (independent review).\nModels: GDM_PI_MODEL (default {DEFAULT_MODEL}), GDM_PI_THINKING (default high).\nRoles: GDM_PI_SCOUT_MODEL / GDM_PI_DESIGN_MODEL / GDM_PI_REVIEW_MODEL.\nAudit: GDM_PI_AUDIT_MODEL must differ from implementation model for auto/full.\nExecutable: GDM_PI_EXECUTABLE must identify the real Pi binary."
                );
                return Ok(());
            }
            "-v" | "--version" | "install" | "remove" | "uninstall" | "update" | "list"
            | "config" | "auth" => raw = true,
            _ => {}
        }
    }
    let pi = executable(
        std::env::var_os("GDM_PI_EXECUTABLE")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| find("pi"))
            .ok_or_else(|| failure(69, "gdm-pi: Pi executable not found"))?,
    )?;
    let gdm = fs::canonicalize(std::env::current_exe()?)?;
    let launcher = std::env::var_os("GDM_PI_LAUNCHER_PATH").and_then(|p| fs::canonicalize(p).ok());
    if pi == gdm || launcher.as_ref() == Some(&pi) {
        return Err(failure(
            69,
            "gdm-pi: Pi executable resolves back to the harness; set GDM_PI_EXECUTABLE to the real Pi binary",
        ));
    }
    let mut command = Command::new(&pi);
    command.current_dir(cwd);
    if raw {
        let error = command.args(rest).exec();
        return Err(error.into());
    }
    for arg in rest {
        if reserved(arg) {
            return Err(failure(
                64,
                format!("gdm-pi: reserved Pi option is managed by the harness: {arg}"),
            ));
        }
    }
    let pinned = env("GDM_PI_MODEL", DEFAULT_MODEL);
    if !model(&pinned) {
        return Err(failure(
            64,
            "gdm-pi: invalid GDM_PI_MODEL; expected provider/model",
        ));
    }
    let thinking = env("GDM_PI_THINKING", "high");
    if !THINKING.contains(&thinking.as_str()) {
        return Err(failure(64, "gdm-pi: invalid GDM_PI_THINKING"));
    }
    let audit = env("GDM_PI_AUDIT_MODEL", "openai-codex/gpt-6-astra:medium");
    let Some((audit_id, audit_thinking)) = audit.rsplit_once(':') else {
        return Err(failure(
            64,
            "gdm-pi: invalid GDM_PI_AUDIT_MODEL; expected provider/model:thinking",
        ));
    };
    if audit.len() > 176 || !model(audit_id) || !THINKING.contains(&audit_thinking) {
        return Err(failure(
            64,
            "gdm-pi: invalid GDM_PI_AUDIT_MODEL; expected provider/model:thinking",
        ));
    }
    for key in [
        "GDM_PI_CHILD_MODEL",
        "GDM_PI_SCOUT_MODEL",
        "GDM_PI_DESIGN_MODEL",
        "GDM_PI_REVIEW_MODEL",
    ] {
        if let Ok(value) = std::env::var(key)
            && !model(&value)
        {
            return Err(failure(
                64,
                format!("gdm-pi: invalid {key}; expected provider/model"),
            ));
        }
    }
    for key in [
        "GDM_PI_CHILD_THINKING",
        "GDM_PI_SCOUT_THINKING",
        "GDM_PI_DESIGN_THINKING",
        "GDM_PI_REVIEW_THINKING",
    ] {
        if let Ok(value) = std::env::var(key)
            && !THINKING.contains(&value.as_str())
        {
            return Err(failure(64, format!("gdm-pi: invalid {key}")));
        }
    }
    if profile != "go" && audit_id == pinned {
        return Err(failure(
            64,
            "gdm-pi: full audit model identity must differ from the implementation model",
        ));
    }
    let agent_dir = match std::env::var_os("PI_CODING_AGENT_DIR").filter(|s| !s.is_empty()) {
        Some(p) => {
            let p = PathBuf::from(p);
            if p.is_absolute() { p } else { cwd.join(p) }
        }
        None => PathBuf::from(
            std::env::var_os("HOME").ok_or_else(|| failure(69, "gdm-pi: HOME is required"))?,
        )
        .join(".pi/agent"),
    };
    let skills = agent_dir.join("skills");
    let assets = skills.join("gdm-agents/pi");
    let extension = assets.join("gdm-delegate.ts");
    let memory = assets.join("gdm-memory/index.ts");
    let computer = assets.join("gdm-computer-use/index.ts");
    let prompt = assets.join("coordinator.md");
    let mut required = vec![
        extension.clone(),
        memory.clone(),
        computer.clone(),
        assets.join("presentation.mjs"),
        assets.join("ax.mjs"),
        prompt.clone(),
    ];
    let names: Vec<&str> = if profile == "auto" {
        vec![
            "analyze", "db", "design", "document", "email", "full", "go", "plan", "pr", "reflect",
            "research", "review", "ui",
        ]
    } else {
        vec![profile]
    };
    let mut skill_args = vec!["--no-skills".to_owned()];
    for name in names {
        let p = skills.join(format!("gdm-{name}"));
        required.push(p.join("SKILL.md"));
        skill_args.push("--skill".into());
        skill_args.push(p.to_string_lossy().into_owned());
    }
    for p in required {
        if !fs::symlink_metadata(&p).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
            return Err(failure(
                69,
                format!(
                    "gdm-pi: installed harness asset missing or unsafe: {}",
                    p.display()
                ),
            ));
        }
    }
    let mut role_vars = BTreeMap::new();
    for role in ["SCOUT", "DESIGN", "REVIEW"] {
        let role_model = env(
            &format!("GDM_PI_{role}_MODEL"),
            &env(
                "GDM_PI_CHILD_MODEL",
                if role == "SCOUT" {
                    "openai-codex/gpt-5.6-luna"
                } else {
                    "openai-codex/gpt-6-astra"
                },
            ),
        );
        let effort = env(
            &format!("GDM_PI_{role}_THINKING"),
            &env("GDM_PI_CHILD_THINKING", "medium"),
        );
        role_vars.insert(format!("GDM_PI_{role}_MODEL"), role_model);
        role_vars.insert(format!("GDM_PI_{role}_THINKING"), effort);
    }
    command
        .env("GDM_PI_EXECUTABLE", &pi)
        .env("GDM_PI_AGENT_DIR", &agent_dir)
        .env("GDM_EXECUTABLE", &gdm)
        .env("GDM_PI_PROFILE", profile)
        .env("GDM_PI_MODEL", &pinned)
        .env("GDM_PI_THINKING", &thinking)
        .env(
            "GDM_PI_IMPLEMENTATION_MODEL",
            format!("{pinned}:{thinking}"),
        )
        .env("GDM_PI_AUDIT_MODEL", &audit)
        .envs(&role_vars);
    let metadata = format!(
        "GDM Pi active profile: {profile}. Implementation model metadata: {pinned}:{thinking}. Full audit model when required: {audit}."
    );
    let routing = format!(
        "GDM delegate routing: scout={}:{}; design={}:{}; reviewer={}:{}. Delegation is optional; reviewer output is advisory and does not satisfy full audit.",
        role_vars["GDM_PI_SCOUT_MODEL"],
        role_vars["GDM_PI_SCOUT_THINKING"],
        role_vars["GDM_PI_DESIGN_MODEL"],
        role_vars["GDM_PI_DESIGN_THINKING"],
        role_vars["GDM_PI_REVIEW_MODEL"],
        role_vars["GDM_PI_REVIEW_THINKING"]
    );
    command
        .args([
            "--model",
            &pinned,
            "--models",
            &format!("{pinned}:{thinking}"),
            "--thinking",
            &thinking,
            "--no-extensions",
            "--extension",
        ])
        .arg(extension)
        .arg("--extension")
        .arg(memory)
        .arg("--extension")
        .arg(computer)
        .args(skill_args)
        .args(["--no-prompt-templates", "--append-system-prompt"])
        .arg(prompt)
        .args([
            "--append-system-prompt",
            &metadata,
            "--append-system-prompt",
            &routing,
            "--tools",
            "read,bash,edit,write,grep,find,ls,gdm_delegate,gdm_memory,gdm_computer_use",
        ])
        .args(rest);
    let error = command.exec();
    Err(error.into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_options_cannot_escape_with_equals() {
        assert!(reserved("--model=evil"));
        assert!(reserved("--api-key=secret"));
        assert!(reserved("-t"));
        assert!(!reserved("--continue"));
    }
    #[test]
    fn model_identity_validation() {
        assert!(model("openai-codex/gpt-6-astra"));
        assert!(!model("openai/model:high"));
        assert!(!model("openai/model;sh"));
    }
}
