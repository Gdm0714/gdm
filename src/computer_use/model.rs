//! Shared official CLI proposal transport for the two opt-in experiments.
use super::{process::capture, rfb::Frame};
use crate::support::{Error, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    process::Command,
    time::{Duration, Instant},
};

pub(super) struct Reply {
    pub value: Value,
    pub elapsed: u128,
    pub usage: Value,
    pub observed_models: Vec<String>,
}
pub(super) fn request(
    executable: &str,
    model: &str,
    instruction: &str,
    schema: &Value,
    frame: &Frame,
) -> Result<Reply> {
    let started = Instant::now();
    let message = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":instruction},{"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(frame.png()?)}}]}});
    let mut input = serde_json::to_vec(&message)?;
    input.push(b'\n');
    let temporary = tempfile::tempdir()?;
    let mut cmd = Command::new(executable);
    cmd.current_dir(temporary.path()).args([
        "--print",
        "--safe-mode",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--tools",
        "",
        "--no-chrome",
        "--disable-slash-commands",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--effort",
        "low",
        "--json-schema",
        &schema.to_string(),
    ]);
    let result = capture(cmd, input, Duration::from_secs(120), 2 * 1024 * 1024)?;
    if result.code != 0 {
        return Err(Error::new(
            "benchmark_model",
            format!(
                "model CLI exited {}; captured diagnostics excluded from report",
                result.code
            ),
        ));
    }
    let mut observed_models = std::collections::BTreeSet::new();
    let mut payload = None;
    let mut usage = Value::Null;
    let mut text = String::new();
    for line in result.stdout.split(|b| *b == b'\n') {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        for item in [&v["model"], &v["message"]["model"]] {
            if let Some(name) = item.as_str() {
                observed_models.insert(name.to_owned());
            }
        }
        if let Some(models) = v["modelUsage"].as_object() {
            observed_models.extend(models.keys().cloned());
        }
        if v["type"] == "result" {
            if v["is_error"] == true {
                return Err(Error::new("benchmark_model", "model returned an error"));
            }
            usage = v["usage"].clone();
            if v["structured_output"].is_object() {
                payload = Some(v["structured_output"].clone());
            }
            if let Some(t) = v["result"].as_str() {
                text = t.into();
            }
        }
        if v["type"] == "assistant"
            && let Some(blocks) = v["message"]["content"].as_array()
        {
            for block in blocks {
                if block["type"] == "text"
                    && let Some(t) = block["text"].as_str()
                {
                    text = t.into();
                }
            }
        }
    }
    let value = if let Some(p) = payload {
        p
    } else {
        let t = text
            .trim()
            .strip_prefix("```json")
            .or_else(|| text.trim().strip_prefix("```"))
            .unwrap_or(text.trim())
            .trim()
            .trim_end_matches("```")
            .trim();
        serde_json::from_str::<Value>(t)
            .map_err(|_| Error::new("benchmark_model", "model did not provide a valid proposal"))?
    };
    Ok(Reply {
        value,
        elapsed: started.elapsed().as_millis(),
        usage,
        observed_models: observed_models.into_iter().collect(),
    })
}
