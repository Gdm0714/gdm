use crate::support::{Error, Result};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::Path,
    sync::{LazyLock, Mutex},
};
use unicode_normalization::UnicodeNormalization;
pub const EDGES: [&str; 8] = [
    "imports",
    "mentions",
    "contains",
    "owns",
    "touches",
    "verifies",
    "evidenced_by",
    "tests",
];
pub fn err(s: impl Into<String>) -> Error {
    Error::new("usage", s)
}
pub fn matches(pattern: &'static str, value: &str) -> bool {
    static PATTERNS: LazyLock<Mutex<std::collections::HashMap<&'static str, Regex>>> =
        LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
    let mut patterns = PATTERNS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    patterns
        .entry(pattern)
        .or_insert_with(|| Regex::new(pattern).expect("fixed regex"))
        .is_match(value)
}
pub fn assignment(value: &str) -> bool {
    matches(r"[:=]\s*\S", &value.nfkc().collect::<String>())
}
pub fn secret(value: &str) -> bool {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
 r#"(?i)\\(?:u(?:[0-9a-f]{4}|\{[0-9a-f]{4,6}\})|x[0-9a-f]{2}|[0-7]{1,3}|[\"'/bfnrt])|%[0-9a-f]{2}|&#(?:x[0-9a-f]+|[0-9]+);|&[a-z][a-z0-9]{1,31};|\p{Cf}"#,
 r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|xox[baprs]|ghp|github_pat)-?[A-Za-z0-9_-]{16,}\b",
 r"\bAKIA[A-Z0-9]{16}\b", r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+",
 r"(?i)\b(?:authorization|password|passwd|pwd|secret|token|api[-_ ]?key|access[-_ ]?(?:key|token)|auth[-_ ]?token|client[-_ ]?secret|refresh[-_ ]?token|private[-_ ]?key|credentials?|session[-_ ]?(?:key|token)|signing[-_ ]?key|encryption[-_ ]?key|webhook[-_ ]?secret)\b[^\p{L}\p{N}\r\n]*[:=]\s*\S+",
 r"\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
 r"(?i)\b[a-z][a-z0-9+.-]*://[^\s/:@]{1,64}:[^\s@]+@[^\s]+",
 r"\b(?:[A-F0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})\b"
 ].iter().map(|p|Regex::new(p).expect("secret regex")).collect()
    });
    let normalized = value.nfkc().collect::<String>();
    PATTERNS.iter().any(|r| r.is_match(&normalized))
}
pub fn canonical(value: &str, field: &str, max: usize) -> Result<String> {
    if value.is_empty()
        || value.encode_utf16().count() > max
        || value.contains(['\0', '\\'])
        || value.starts_with('/')
        || matches(r"^[A-Za-z]:[\\/]", value)
    {
        return Err(err(format!(
            "{field} must be a canonical repository-relative path"
        )));
    }
    if value
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(err(format!(
            "{field} must not contain empty, dot, or parent segments"
        )));
    }
    Ok(value.into())
}
pub fn object<'a>(
    v: &'a Value,
    field: &str,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>> {
    let o = v.as_object().ok_or_else(|| {
        err(format!(
            "{field} must be {}",
            if field == "request" {
                "a JSON object"
            } else {
                "an object"
            }
        ))
    })?;
    let mut unknown = o
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .collect::<Vec<_>>();
    unknown.sort();
    if let Some(k) = unknown.first() {
        return Err(err(format!("{field} has unknown field: {k}")));
    }
    Ok(o)
}
pub fn integer(v: &Value, field: &str, min: usize, max: usize) -> Result<usize> {
    let n = v
        .as_u64()
        .filter(|n| *n >= min as u64 && *n <= max as u64)
        .ok_or_else(|| err(format!("{field} must be an integer from {min} to {max}")))?;
    Ok(n as usize)
}
fn strings(v: &Value, field: &str, min: usize, max: usize) -> Result<Vec<String>> {
    let a = v
        .as_array()
        .filter(|a| a.len() >= min && a.len() <= max)
        .ok_or_else(|| err(format!("{field} must contain {min} to {max} strings")))?;
    let mut out = Vec::new();
    for v in a {
        let s = v
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.encode_utf16().count() <= 200
                    && *s == s.trim()
                    && !s.contains('\0')
            })
            .ok_or_else(|| err(format!("{field} contains an invalid string")))?;
        if secret(s) || assignment(s) {
            return Err(err(format!("{field} contains a secret-shaped value")));
        }
        if out.iter().any(|x| x == s) {
            return Err(err(format!("{field} must not contain duplicates")));
        }
        out.push(s.into());
    }
    Ok(out)
}
#[derive(Clone, Debug)]
pub struct Query {
    pub root: String,
    pub route: bool,
    pub terms: Vec<String>,
    pub seeds: Vec<String>,
    pub edges: Vec<String>,
    pub depth: usize,
    pub bytes: usize,
    pub nodes: usize,
    pub edge_count: usize,
    pub snippets: usize,
}
impl Query {
    pub fn parse(v: &Value) -> Result<Self> {
        object(
            v,
            "request",
            &[
                "schemaVersion",
                "root",
                "op",
                "terms",
                "seeds",
                "edgeTypes",
                "maxDepth",
                "budget",
            ],
        )?;
        if v["schemaVersion"] != "gdm-context-query/v1" {
            return Err(err("schemaVersion must be gdm-context-query/v1"));
        }
        let root = v["root"]
            .as_str()
            .filter(|s| Path::new(s).is_absolute() && !s.contains('\0'))
            .ok_or_else(|| err("root must be an absolute path"))?
            .to_string();
        let route = match v["op"].as_str() {
            Some("route") => true,
            Some("pack") => false,
            _ => return Err(err("op must be route or pack")),
        };
        let terms = strings(&v["terms"], "terms", 1, 8)?;
        let seeds = strings(&v["seeds"], "seeds", 0, 4)?;
        for s in &seeds {
            if s.contains('/') || matches(r"^[^:]+\.[A-Za-z0-9]+$", s) {
                canonical(s, "seed", 512)?;
            } else if !matches(r"^(?:w|c|ev|pkg|owner):[^\x00]{1,190}$", s) {
                return Err(err("seed must be a repository path or node key"));
            }
        }
        let edges = strings(&v["edgeTypes"], "edgeTypes", 0, 8)?;
        if edges.iter().any(|s| !EDGES.contains(&s.as_str())) {
            return Err(err("edgeTypes contains an unsupported edge type"));
        }
        let b = &v["budget"];
        object(
            b,
            "budget",
            &["maxBytes", "maxNodes", "maxEdges", "maxSnippets"],
        )?;
        Ok(Self {
            root,
            route,
            terms,
            seeds,
            edges,
            depth: integer(&v["maxDepth"], "maxDepth", 0, 4)?,
            bytes: integer(&b["maxBytes"], "budget.maxBytes", 512, 12288)?,
            nodes: integer(&b["maxNodes"], "budget.maxNodes", 1, 64)?,
            edge_count: integer(&b["maxEdges"], "budget.maxEdges", 0, 128)?,
            snippets: integer(&b["maxSnippets"], "budget.maxSnippets", 0, 12)?,
        })
    }
}
pub fn split_terms(value: &str) -> Vec<String> {
    let n = value.nfc().collect::<String>();
    static CAMEL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"([\p{Ll}\p{N}])([\p{Lu}])").unwrap());
    static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
    let camel = CAMEL.replace_all(&n, "$1 $2");
    let lower = camel.to_lowercase();
    let mut seen = BTreeSet::new();
    WORD.find_iter(&lower)
        .filter_map(|m| {
            let s = m.as_str();
            (s.encode_utf16().count() <= 64 && !secret(s) && seen.insert(s.to_string()))
                .then(|| s.to_string())
        })
        .take(96)
        .collect()
}
pub fn terms(values: &[&str]) -> BTreeSet<String> {
    let mut t = BTreeSet::new();
    for v in values {
        for s in split_terms(v) {
            t.insert(s);
            if t.len() >= 96 {
                return t;
            }
        }
    }
    t
}
