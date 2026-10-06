//! Native, read-only repository navigation. Untrusted repository text never becomes instructions.
mod graph;
mod pack;
mod scan;
mod schema;
use crate::support::{Error, Result, print_json};
use serde_json::{Value, json};
use std::{io::Read, path::Path};

pub fn run(_cwd: &Path, argv: &[String]) -> Result<()> {
    let kind = argv.first().map(String::as_str).unwrap_or("context");
    let sub = argv.get(1).map(String::as_str).unwrap_or("");
    if argv.len() != 2 {
        return Err(Error::new(
            "usage",
            format!("사용법: gdm {kind} query 또는 status"),
        ));
    }
    if kind == "context" && sub == "status" {
        return print_json(
            &json!({"schemaVersion":"gdm-context-status/v1","provider":"gdm-local-context","version":1,"mode":"one-shot","cache":"disabled","querySchema":"gdm-context-query/v1","packSchema":"gdm-context-pack/v1","defaultMaxBytes":4096,"absoluteMaxBytes":12288}),
        );
    }
    if sub != "query" {
        return Err(Error::new(
            "usage",
            format!(
                "{kind} 하위 명령은 query{}만 지원합니다",
                if kind == "context" {
                    " 또는 status"
                } else {
                    ""
                }
            ),
        ));
    }
    let mut input = String::new();
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_string(&mut input)?;
    if input.len() > 1024 * 1024 {
        return Err(Error::new("usage", "stdin request exceeds 1 MiB"));
    }
    let raw: Value = serde_json::from_str(&input)
        .map_err(|_| Error::new("usage", "stdin에는 JSON request 하나가 필요합니다"))?;
    let result = if kind == "context" {
        query(
            &raw,
            std::env::var("GDM_CONTEXT_TRUSTED_ROOT").ok().as_deref(),
        )?
    } else {
        graph::query(&raw)?
    };
    print_json(&result)
}

pub fn query(raw: &Value, trusted: Option<&str>) -> Result<Value> {
    let q = schema::Query::parse(raw)?;
    if trusted != Some(q.root.as_str()) || graph::validate_root(Path::new(&q.root)).is_err() {
        return Ok(pack::failure(&q, "untrusted", "trusted-root-mismatch"));
    }
    pack::build(&q)
}

#[cfg(test)]
mod tests;
