//! Shared CLI parsing and wire-compatible errors. Command policy lives in modules.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;

#[derive(Debug, Clone)]
pub struct Error {
    pub code: String,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn exit_code(&self) -> i32 {
        if self.code == "interrupted" {
            return 130;
        }
        if self.code.starts_with("agent_hooks_") {
            return 3;
        }
        if let Some(code) = self
            .code
            .strip_prefix("runner_exit_")
            .and_then(|s| s.parse::<i32>().ok())
            .filter(|c| (1..=255).contains(c))
        {
            return code;
        }
        match self.code.as_str() {
            "usage"
            | "agent_usage"
            | "constraint_required"
            | "state_corrupt"
            | "habit_ledger_corrupt"
            | "brief_checks_invalid" => 2,
            "work_not_found"
            | "contract_conflict"
            | "contract_locked"
            | "commit_transition_conflict"
            | "attempt_id_conflict"
            | "attempt_not_found"
            | "attempt_transition"
            | "event_conflict"
            | "habit_transition"
            | "stale_correction"
            | "evaluation_activation_mismatch"
            | "habit_rule_changed"
            | "habit_activation_locked"
            | "habit_activation_conflict"
            | "habit_event_invalid"
            | "handoff_id_conflict"
            | "handoff_time_invalid"
            | "receipt_time_invalid"
            | "handoff_not_found"
            | "claim_not_found"
            | "claim_id_conflict"
            | "receipt_conflict"
            | "receipt_transition"
            | "runner_observation_invalid"
            | "receiver_ack_invalid"
            | "artifact_encoding_invalid"
            | "audit_verdict_invalid"
            | "audit_verdict_mismatch" => 3,
            "commit_forbidden"
            | "unchanged_retry"
            | "stale_evidence"
            | "delivery_gate"
            | "scope_violation"
            | "red_evidence_required"
            | "red_expected_failure"
            | "red_not_allowed"
            | "simplification_required"
            | "expert_evidence_required"
            | "expert_review_required"
            | "scope_locked"
            | "plan_fingerprint_mismatch"
            | "state_fingerprint_mismatch"
            | "source_fingerprint_mismatch"
            | "capability_unsupported"
            | "receiver_mismatch"
            | "claim_conflict"
            | "bundle_mismatch"
            | "artifact_missing"
            | "artifact_changed"
            | "artifact_too_large"
            | "output_too_large"
            | "bundle_too_large"
            | "output_missing"
            | "output_changed"
            | "receiver_blocked"
            | "provider_executable_changed" => 4,
            "privacy_rejected" | "path_rejected" => 5,
            _ => 1,
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "오류({}): {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("state_corrupt", e.to_string())
    }
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}
pub fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == &format!("--{name}"))
}
pub fn read_flag(args: &[String], name: &str) -> Result<Option<String>> {
    let flag = format!("--{name}");
    if let Some(index) = args.iter().position(|a| a == &flag) {
        return args
            .get(index + 1)
            .filter(|v| !v.starts_with("--"))
            .cloned()
            .map(Some)
            .ok_or_else(|| Error::new("usage", format!("{flag} 값이 필요합니다")));
    }
    let prefix = format!("{flag}=");
    Ok(args
        .iter()
        .find_map(|a| a.strip_prefix(&prefix).map(str::to_owned)))
}
pub fn required_flag(args: &[String], name: &str) -> Result<String> {
    read_flag(args, name)?.ok_or_else(|| Error::new("usage", format!("--{name} 값이 필요합니다")))
}
pub fn read_flags(args: &[String], name: &str) -> Result<Vec<String>> {
    let mut values = Vec::new();
    let flag = format!("--{name}");
    let prefix = format!("{flag}=");
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            i += 1;
            values.push(
                args.get(i)
                    .filter(|v| !v.starts_with("--"))
                    .cloned()
                    .ok_or_else(|| Error::new("usage", format!("{flag} 값이 필요합니다")))?,
            );
        } else if let Some(v) = args[i].strip_prefix(&prefix) {
            values.push(v.to_owned());
        }
        i += 1;
    }
    Ok(values)
}
pub fn ensure_flags(args: &[String], valued: &[&str], boolean: &[&str]) -> Result<()> {
    let mut i = 0;
    while i < args.len() {
        if let Some(flag) = args[i].strip_prefix("--") {
            let (name, value) = flag
                .split_once('=')
                .map_or((flag, None), |(n, v)| (n, Some(v)));
            if valued.contains(&name) {
                if value.is_none() {
                    i += 1;
                }
            } else if boolean.contains(&name) {
                if value.is_some() {
                    return Err(Error::new(
                        "usage",
                        format!("--{name}는 값을 받지 않습니다"),
                    ));
                }
            } else {
                return Err(Error::new("usage", format!("알 수 없는 플래그: --{name}")));
            }
        }
        i += 1;
    }
    Ok(())
}
pub fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}
