//! Credential-shaped values in source-bearing artifacts, not prose metadata.
//!
//! Inspect every byte of the supplied text, including comments and code fences.
//! A marker without a value is source syntax, not an authentication credential.
//! This heuristic does not certify that arbitrary application secrets are absent.
use base64::{
    Engine,
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub fn contains_credentials(text: &str) -> bool {
    static VALUES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"(?i)(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{8,}",
            r"(?i)(?:AKIA|ASIA)[A-Z0-9]{16}",
            r"AIza[A-Za-z0-9_-]{35}",
            r"(?i)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----",
            // Literal template/concatenation delimiters cannot be a header value.
            r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+",
            // A quoted constant after concatenation is still a literal credential.
            r#"(?i)\bBearer\s*["'`]\s*\+\s*["'`][A-Za-z0-9._~+/=-]+"#,
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("fixed credential pattern"))
        .collect()
    });
    if VALUES.iter().any(|pattern| pattern.is_match(text)) {
        return true;
    }
    // Prefixes alone occur in detector source; a nonempty suffix is a value.
    static OPENAI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)(?:^|[^A-Za-z0-9])sk-([A-Za-z0-9_-]+)")
            .expect("fixed provider key pattern")
    });
    if OPENAI.captures_iter(text).any(|candidate| {
        let body = candidate.get(1).expect("key body capture").as_str();
        !body.eq_ignore_ascii_case("proj-") && !body.eq_ignore_ascii_case("svcacct-")
    }) {
        return true;
    }

    // Dot-separated public identifiers and property paths are not compact JOSE
    // credentials. Identify an encoded protected JSON header, without requiring
    // a valid signature, particular algorithm, or minimum claims/signature size.
    static COMPACT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"([A-Za-z0-9_-]{2,}={0,2})\.[A-Za-z0-9_-]*={0,2}\.[A-Za-z0-9_-]*={0,2}")
            .expect("fixed compact JOSE pattern")
    });
    let mut offset = 0;
    while let Some(candidate) = COMPACT.captures(&text[offset..]) {
        let first = candidate.get(1).expect("protected header capture");
        let encoded = first.as_str();
        // Move one segment, not one whole match. A public dotted prefix must not
        // consume a following protected header as its third segment and hide it.
        offset += first.end() + 1;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .or_else(|_| URL_SAFE.decode(encoded));
        let Ok(bytes) = bytes else { continue };
        let Ok(Value::Object(header)) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if ["alg", "enc"].into_iter().any(|field| {
            header
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        }) || header
            .get("typ")
            .and_then(Value::as_str)
            .is_some_and(|typ| {
                typ.eq_ignore_ascii_case("JWT") || typ.eq_ignore_ascii_case("application/jwt")
            })
        {
            return true;
        }
    }
    false
}
