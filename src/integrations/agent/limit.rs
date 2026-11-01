//! Read-only Codex user-level concurrency inspection. Session effective values may differ.
use crate::support::Result;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};
use toml_edit::{DocumentMut, Item, TableLike};
fn note() -> &'static str {
    crate::i18n::text(
        "  → 현재 세션 유효값은 CLI·프로필·프로젝트 설정이 덮을 수 있으므로 /debug-config에서 확인하세요",
        "  → CLI, profile and project settings may override this value; inspect /debug-config for the current session",
    )
}
fn invalid(kind: &str, message: impl Into<String>) -> Value {
    json!({"exists":true,"invalid":true,"invalidKind":kind,"invalidMessage":message.into()})
}
fn positive(table: Option<&dyn TableLike>, key: &str) -> std::result::Result<Option<u64>, ()> {
    let Some(value) = table.and_then(|t| t.get(key)) else {
        return Ok(None);
    };
    if let Some(n) = value.as_integer() {
        return if (1..=9_007_199_254_740_991).contains(&n) {
            Ok(Some(n as u64))
        } else {
            Err(())
        };
    }
    if let Some(n) = value.as_float() {
        return if n.is_finite() && (1.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0
        {
            Ok(Some(n as u64))
        } else {
            Err(())
        };
    }
    Err(())
}
fn parse(source: &str) -> Value {
    let doc = match source.parse::<DocumentMut>() {
        Ok(d) => d,
        Err(_) => {
            return invalid(
                "parse",
                crate::i18n::text(
                    "config.toml TOML 문법이 올바르지 않습니다: invalid TOML syntax",
                    "Invalid config.toml TOML syntax",
                ),
            );
        }
    };
    let agents_raw = doc.get("agents");
    let features_raw = doc.get("features");
    let agents = agents_raw.and_then(Item::as_table_like);
    let features = features_raw.and_then(Item::as_table_like);
    let legacy = features
        .and_then(|f| f.get("multi_agent_v2"))
        .and_then(Item::as_table_like);
    let mut bad = (agents_raw.is_some() && agents.is_none())
        || (features_raw.is_some() && features.is_none());
    let mut out = json!({"exists":true});
    for (key, value) in [
        (
            "official",
            positive(agents, "max_concurrent_threads_per_session"),
        ),
        ("legacyAgents", positive(agents, "max_threads")),
        (
            "legacyFeature",
            positive(legacy, "max_concurrent_threads_per_session"),
        ),
    ] {
        match value {
            Ok(Some(n)) => {
                out[key] = json!(n);
            }
            Ok(None) => {}
            Err(()) => bad = true,
        }
    }
    out["invalid"] = json!(bad);
    if bad {
        out["invalidKind"] = json!("shape");
        out["invalidMessage"] = json!(crate::i18n::text(
            "동시성 상한 또는 관련 TOML 테이블의 형식이 올바르지 않습니다",
            "Invalid concurrency limit or related TOML table type"
        ));
    }
    out
}
fn read_at(home: &Path) -> Value {
    let path = home.join("config.toml");
    let stat = match fs::symlink_metadata(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return json!({"exists":false,"invalid":false});
        }
        Err(e) => {
            return invalid(
                "read",
                crate::lfmt!(
                    "config.toml 상태를 읽을 수 없습니다: {e}",
                    "Cannot inspect config.toml: {e}"
                ),
            );
        }
    };
    if !stat.is_file() || stat.is_symlink() {
        return invalid(
            "path",
            crate::i18n::text(
                "config.toml 경로가 일반 파일이 아닙니다",
                "config.toml is not a regular file",
            ),
        );
    }
    // Read a bounded regular file without following a replaced final symlink.
    let read = (|| -> std::io::Result<String> {
        let f = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&path)?;
        if !f.metadata()?.is_file() {
            return Err(std::io::Error::other("not a regular file"));
        }
        let mut bytes = Vec::new();
        f.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(std::io::Error::other("config.toml exceeds 8 MiB"));
        }
        String::from_utf8(bytes).map_err(|_| std::io::Error::other("config.toml is not UTF-8"))
    })();
    match read {
        Ok(source) => parse(&source),
        Err(e) => invalid(
            "read",
            crate::lfmt!(
                "config.toml을 읽을 수 없습니다: {e}",
                "Cannot read config.toml: {e}"
            ),
        ),
    }
}
pub fn read_config(cwd: &Path) -> Result<Value> {
    Ok(read_at(&super::ledger::home(cwd)?))
}
fn lines(config: &Value, path: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if config["exists"] == false {
        out.push(
            crate::i18n::text("  Codex 서브에이전트 사용자 설정: config.toml 없음 (현재 세션 유효값 미확인)", "  Codex subagent user settings: no config.toml (effective session value unverified)").into(),
        );
    } else if config["invalid"] == true {
        let label = match config["invalidKind"].as_str() {
            Some("parse") => crate::i18n::text("TOML 문법 오류", "Invalid TOML syntax"),
            Some("path") => crate::i18n::text("config.toml 경로 오류", "Invalid config.toml path"),
            Some("read") => crate::i18n::text("config.toml 읽기 오류", "Cannot read config.toml"),
            _ => crate::i18n::text("상한 설정 오류", "Invalid limit configuration"),
        };
        out.push(crate::lfmt!(
            "  Codex 서브에이전트 사용자 설정: {label}",
            "  Codex subagent user settings: {label}"
        ));
        if let Some(message) = config["invalidMessage"].as_str() {
            out.push(format!("  → {message}"));
        }
        out.push(crate::lfmt!(
            "  → {}의 [agents] max_concurrent_threads_per_session 상한이 양의 정수인지 확인하세요",
            "  → Check that [agents] max_concurrent_threads_per_session is a positive integer in {}",
            path.display()
        ));
    } else {
        let official = config["official"].as_u64();
        let legacy = config["legacyFeature"]
            .as_u64()
            .or_else(|| config["legacyAgents"].as_u64());
        if let Some(configured) = official.or(legacy) {
            let prefix = if official.is_none() {
                crate::i18n::text("legacy 동시 상한", "Legacy concurrency limit")
            } else {
                crate::i18n::text("동시 상한", "Concurrency limit")
            };
            out.push(crate::lfmt!(
                "  Codex 서브에이전트 사용자 설정: {prefix} {configured}개 (현재 세션 유효값 미확인)",
                "  Codex subagent user settings: {prefix} {configured} (effective session value unverified)"
            ));
            if legacy.is_some() {
                out.push(crate::lfmt!(
                    "  → 구형 상한 설정을 제거하고 [agents] max_concurrent_threads_per_session = {configured}만 유지하세요",
                    "  → Remove legacy limits and keep only [agents] max_concurrent_threads_per_session = {configured}"
                ));
            }
        } else {
            out.push(
                crate::i18n::text("  Codex 서브에이전트 사용자 설정: 명시 상한 없음 (현재 세션 유효값 미확인)", "  Codex subagent user settings: no explicit limit (effective session value unverified)").into(),
            );
            out.push(
                crate::i18n::text("  → 실제 가용 슬롯·독립 작업·자원·비용 예산에 맞춰 작업별 동시 실행 수를 정하세요", "  → Choose per-work concurrency from available slots, independent tasks, resources and spending limits").into(),
            );
        }
    }
    out.push(note().into());
    out
}
pub fn doctor_lines(cwd: &Path) -> Vec<String> {
    match super::ledger::home(cwd) {
        Ok(home) => lines(&read_at(&home), &home.join("config.toml")),
        Err(e) => vec![
            crate::lfmt!(
                "  Codex 서브에이전트 사용자 설정: 경로 오류 — {}",
                "  Codex subagent user settings: invalid path — {}",
                e.message
            ),
            note().into(),
        ],
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valid_and_legacy_precedence() {
        let config = parse(
            "[agents]\nmax_concurrent_threads_per_session=4\nmax_threads=6\n[features.multi_agent_v2]\nmax_concurrent_threads_per_session=7\n",
        );
        assert_eq!(
            config,
            json!({"exists":true,"official":4,"legacyAgents":6,"legacyFeature":7,"invalid":false})
        );
        let l = lines(&config, Path::new("/test/config.toml"));
        assert_eq!(
            l[0],
            "  Codex 서브에이전트 사용자 설정: 동시 상한 4개 (현재 세션 유효값 미확인)"
        );
        assert!(l[1].contains("구형 상한"));
    }
    #[test]
    fn shape_and_syntax_failures() {
        for source in [
            "agents=4",
            "features=true",
            "[agents]\nmax_concurrent_threads_per_session=\"4\"",
            "[agents]\nmax_threads=0",
            "[features.multi_agent_v2]\nmax_concurrent_threads_per_session=1.5",
            "[agents]\nmax_threads=9007199254740992",
        ] {
            let config = parse(source);
            assert_eq!(config["invalidKind"], "shape", "{source}");
        }
        assert_eq!(parse("[agents\n")["invalidKind"], "parse");
        assert_eq!(parse("[agents]\nmax_threads=4.0")["legacyAgents"], 4);
        assert_eq!(parse("features={multi_agent_v2=true}")["invalid"], false);
    }
    #[test]
    fn missing_unset_and_path_distinct() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            read_at(temp.path()),
            json!({"exists":false,"invalid":false})
        );
        fs::write(temp.path().join("config.toml"), "model='test'\n").unwrap();
        assert_eq!(read_at(temp.path()), json!({"exists":true,"invalid":false}));
        fs::remove_file(temp.path().join("config.toml")).unwrap();
        fs::create_dir(temp.path().join("config.toml")).unwrap();
        assert_eq!(read_at(temp.path())["invalidKind"], "path");
    }
    #[test]
    fn configured_limits_are_preserved_without_unmeasured_risk_classification() {
        for n in [1, 4, 5, 8, 9, 16, 32, 1000] {
            let c = parse(&format!(
                "agents={{max_concurrent_threads_per_session={n}}}"
            ));
            assert_eq!(c["official"], n);
            assert_eq!(c["invalid"], false);
            let l = lines(&c, Path::new("/test/config.toml"));
            assert!(l[0].contains(&format!("동시 상한 {n}개")));
            assert!(l[0].contains("현재 세션 유효값 미확인"));
            assert!(
                !l.iter().any(|s| s.contains("낮추세요")
                    || s.contains("위험")
                    || s.contains("권장 범위"))
            );
            assert!(l.last().unwrap().contains("/debug-config"));
        }
    }
    #[test]
    fn legacy_migration_keeps_the_selected_value() {
        for (source, expected) in [
            ("[agents]\nmax_threads=12\n", 12),
            (
                "[features.multi_agent_v2]\nmax_concurrent_threads_per_session=16\n",
                16,
            ),
            (
                "[agents]\nmax_concurrent_threads_per_session=24\nmax_threads=6\n",
                24,
            ),
        ] {
            let l = lines(&parse(source), Path::new("/test/config.toml"));
            assert!(l[0].contains(&format!("동시 상한 {expected}개")));
            assert!(l[1].contains(&format!(
                "max_concurrent_threads_per_session = {expected}만 유지"
            )));
        }
    }
    #[test]
    fn inspection_does_not_rewrite_the_users_configuration() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        let original = "# Keep user formatting and unrelated settings\nmodel = 'chosen-model'\n[agents]\nmax_concurrent_threads_per_session = 32\nmax_threads = 6\n";
        fs::write(&path, original).unwrap();
        let config = read_at(temp.path());
        let output = lines(&config, &path);
        assert_eq!(config["official"], 32);
        assert!(output[0].contains("동시 상한 32개"));
        assert!(output[1].contains("max_concurrent_threads_per_session = 32만 유지"));
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }
}
