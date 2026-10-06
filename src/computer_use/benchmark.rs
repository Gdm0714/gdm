//! Paired live experiment. Candidate generation and failed attempts stay in totals.
use super::{
    jev::{self, Candidates},
    rfb::Frame,
    vm::TartVm,
};
use crate::support::{Error, Result, has_flag, now, read_flag, required_flag};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Instant};

struct Proposal {
    set: Candidates,
    selected: Option<String>,
    elapsed: u128,
    usage: Value,
    observed_models: Vec<String>,
}
fn generate(
    executable: &str,
    model: &str,
    goal: &str,
    frame: &Frame,
    select: bool,
) -> Result<Proposal> {
    let schema = json!({"type":"object","properties":{"observation":{"type":"string"},"candidates":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"object","properties":{"id":{"type":"string"},"description":{"type":"string"},"action":{"type":"object","properties":{"action":{"type":"string","enum":["type_text","press_key","click"]},"text":{"type":"string"},"key":{"type":"string"},"modifiers":{"type":"array","items":{"type":"string"}},"x":{"type":"integer"},"y":{"type":"integer"}},"required":["action"],"additionalProperties":false}},"required":["id","description","action"],"additionalProperties":false}},"selected_id":{"type":"string"}},"required":if select{vec!["observation","candidates","selected_id"]}else{vec!["observation","candidates"]},"additionalProperties":false});
    let instruction = format!(
        "You control an isolated test VM. Goal: {goal}\nInspect the attached screenshot and provide a concise factual textual observation and 2-4 concrete candidate GUI actions, each with id, description and action. Do not execute tools. The action must match one of: {{\"action\":\"type_text\",\"text\":\"...\"}}, {{\"action\":\"press_key\",\"key\":\"...\",\"modifiers\":[]}}, {{\"action\":\"click\",\"x\":0,\"y\":0}}. Provide only fields applicable to that action. {} Return JSON matching the supplied schema.",
        if select {
            "Also choose the single best candidate in selected_id."
        } else {
            "Do not choose or recommend a winner; another selector will decide. Omit selected_id."
        }
    );
    let reply = super::model::request(executable, model, &instruction, &schema, frame)?;
    let value = reply.value;
    let set: Candidates = serde_json::from_value(
        json!({"goal":goal,"observation":value["observation"],"observation_sha256":frame.fingerprint(),"candidates":value["candidates"]}),
    )?;
    set.validate()?;
    let selected = value["selected_id"].as_str().map(str::to_owned);
    if select
        && !selected
            .as_ref()
            .is_some_and(|id| set.candidates.iter().any(|c| &c.id == id))
    {
        return Err(Error::new(
            "benchmark_model",
            "baseline selected an unknown candidate",
        ));
    }
    Ok(Proposal {
        set,
        selected,
        elapsed: reply.elapsed,
        usage: reply.usage,
        observed_models: reply.observed_models,
    })
}
fn percentile(values: &[f64], q: f64) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    let mut s = values.to_vec();
    s.sort_by(f64::total_cmp);
    let i = ((s.len() as f64 * q).ceil() as usize)
        .saturating_sub(1)
        .min(s.len() - 1);
    json!(s[i])
}
pub fn summarize(samples: &[Value]) -> Value {
    let mut arms = serde_json::Map::new();
    for arm in ["model_direct", "model_candidates_jev"] {
        let rows: Vec<_> = samples.iter().filter(|s| s["arm"] == arm).collect();
        let all: Vec<_> = rows
            .iter()
            .filter_map(|s| s["end_to_end_ms"].as_f64())
            .collect();
        let succeeded = rows.iter().filter(|s| s["success"] == true).count();
        arms.insert(arm.into(),json!({"attempts":rows.len(),"succeeded":succeeded,"success_rate":if rows.is_empty(){0.0}else{succeeded as f64/rows.len()as f64},"p50_ms":percentile(&all,0.5),"p95_ms":percentile(&all,0.95)}));
    }
    let same_quality = arms["model_direct"]["succeeded"].as_u64().unwrap_or(0) > 0
        && arms["model_direct"]["success_rate"] == arms["model_candidates_jev"]["success_rate"];
    let baseline = arms["model_direct"]["p50_ms"].as_f64().unwrap_or(0.0);
    let hybrid = arms["model_candidates_jev"]["p50_ms"]
        .as_f64()
        .unwrap_or(0.0);
    json!({"arms":arms,"equal_observed_success_rate":same_quality,"observed_p50_speedup":if same_quality&&hybrid>0.0{Some(baseline/hybrid)}else{None},"interpretation":"Small paired pilot, not statistical proof. Task latency includes candidate generation, selection and GUI execution. Independent file verification is reported separately. Includes a new official CLI process per proposal. Persistent gid sessions can have different overhead. Candidate generation is included. Jev is text-only; observations are produced by the existing vision model."})
}
pub fn run(args: &[String]) -> Result<()> {
    if !has_flag(args, "live-vm") {
        return Err(Error::new(
            "usage",
            "benchmark requires --live-vm and uses only the owned gdm-cu-vm test document",
        ));
    }
    super::signals()?;
    let output = required_flag(args, "output")?;
    let diagnostic_frames = has_flag(args, "diagnostic-frames");
    // Claim output before spending calls; never overwrite an experiment.
    if Path::new(&output).exists() {
        return Err(Error::new("usage", "benchmark output already exists"));
    }
    let model = read_flag(args, "model")?.unwrap_or_else(|| "sonnet".into());
    let executable = read_flag(args, "claude")?.unwrap_or_else(|| "claude".into());
    let repeats = read_flag(args, "repeats")?
        .map(|s| s.parse::<usize>())
        .transpose()
        .map_err(|_| Error::new("usage", "invalid repeats"))?
        .unwrap_or(3);
    if !(1..=20).contains(&repeats) {
        return Err(Error::new("usage", "repeats must be 1 to 20"));
    }
    let env = read_flag(args, "env-file")?;
    let key = jev::api_key(env.as_deref().map(Path::new))?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    let mut vm = TartVm::default();
    let mut samples = Vec::new();
    let started = now();
    let experiment = (|| -> Result<()> {
        eprintln!("benchmark: starting owned isolated VM");
        vm.start()?;
        eprintln!("benchmark: VM ready; preparing document");
        for repeat in 0..repeats {
            let expected = format!("GDM experiment {:02}", repeat + 1);
            let goal = format!(
                "Replace the selected placeholder in the focused TextEdit document with exactly '{expected}'. Take exactly one action."
            );
            let order = if repeat % 2 == 0 {
                ["model_direct", "model_candidates_jev"]
            } else {
                ["model_candidates_jev", "model_direct"]
            };
            for arm in order {
                if super::cancelled() {
                    return Err(Error::new("cancelled", "experiment cancelled"));
                }
                vm.benchmark_document(true)?;
                let frame = vm.screenshot()?;
                eprintln!("benchmark: {arm} candidate generation");
                let begin = Instant::now();
                let mut row = json!({"repeat":repeat,"arm":arm,"model_requested":model,"success":false,"selection_ms":0,"fixture":"fullscreen-selected-textedit-single-action","screen_sha256":frame.fingerprint()});
                let attempt = (|| -> Result<()> {
                    let proposal =
                        generate(&executable, &model, &goal, &frame, arm == "model_direct")?;
                    row["generation_ms"] = json!(proposal.elapsed);
                    row["generation_usage"] = proposal.usage;
                    row["models_reported_by_cli"] = json!(proposal.observed_models);
                    row["candidate_count"] = json!(proposal.set.candidates.len());
                    let chosen = if arm == "model_direct" {
                        proposal.selected
                    } else {
                        let selection = jev::select(&proposal.set, &key, "jev-1.13.0", 0.8)?;
                        row["selection_ms"] = json!(selection.elapsed_ms);
                        row["jev_model"] = json!(selection.model);
                        row["jev_usage"] = selection.usage;
                        row["confidence"] = json!(selection.confidence);
                        selection.candidate_id
                    };
                    let id = chosen
                        .ok_or_else(|| Error::new("benchmark_abstain", "selector abstained"))?;
                    let action = proposal
                        .set
                        .candidates
                        .iter()
                        .find(|c| c.id == id)
                        .ok_or_else(|| Error::new("benchmark_model", "unknown selected action"))?
                        .action
                        .clone();
                    // No hidden model loop or fallback is added after a wrong selection.
                    let execution = Instant::now();
                    let current = vm.screenshot()?;
                    if current.fingerprint() != proposal.set.observation_sha256 {
                        let changed: Vec<_> = frame
                            .rgba
                            .chunks_exact(4)
                            .zip(current.rgba.chunks_exact(4))
                            .enumerate()
                            .filter(|(_, (a, b))| a != b)
                            .map(|(i, _)| (i % frame.width as usize, i / frame.width as usize))
                            .collect();
                        if diagnostic_frames {
                            for (label, image) in [("before", &frame), ("after", &current)] {
                                let path = format!("{output}-{repeat}-{arm}-{label}.png");
                                let mut file = std::fs::OpenOptions::new()
                                    .write(true)
                                    .create_new(true)
                                    .open(path)?;
                                file.write_all(&image.png()?)?;
                            }
                        }
                        row["screen_change"] = json!({"changed_pixels":changed.len(),"bounds":[changed.iter().map(|p|p.0).min(),changed.iter().map(|p|p.1).min(),changed.iter().map(|p|p.0).max(),changed.iter().map(|p|p.1).max()]});
                        return Err(Error::new(
                            "computer_use_stale",
                            "screen changed while deciding",
                        ));
                    }
                    vm.action(&action)?;
                    row["execution_ms"] = json!(execution.elapsed().as_millis());
                    row["selected_action"] = serde_json::to_value(&action)?;
                    row["end_to_end_ms"] = json!(begin.elapsed().as_millis());
                    let verification = Instant::now();
                    let actual = vm.benchmark_document(false)?;
                    row["verification_ms"] = json!(verification.elapsed().as_millis());
                    row["success"] = json!(actual.trim_end_matches(['\r', '\n']) == expected);
                    row["verification"] = json!("exact saved guest TextEdit fixture file");
                    Ok(())
                })();
                row["attempt_wall_ms"] = json!(begin.elapsed().as_millis());
                if row["end_to_end_ms"].is_null() {
                    row["end_to_end_ms"] = row["attempt_wall_ms"].clone();
                }
                if let Err(e) = attempt {
                    row["error_code"] = json!(e.code);
                }
                eprintln!(
                    "benchmark {arm} repeat {}: success={} elapsed={}ms",
                    repeat + 1,
                    row["success"],
                    row["end_to_end_ms"]
                );
                samples.push(row);
            }
        }
        Ok(())
    })();
    vm.stop();
    let report = json!({"schemaVersion":"gdm-computer-use-jev-benchmark/v2","started_at":started,"finished_at":now(),"runtime":"rust","mode":"live-vm","proposer":"official Claude Code CLI, tools disabled","jev_role":"select only among model-proposed actions","credential_included":false,"completed":experiment.is_ok(),"error_code":experiment.as_ref().err().map(|e|e.code.as_str()),"samples":samples,"summary":summarize(&samples)});
    file.write_all(serde_json::to_string_pretty(&report)?.as_bytes())?;
    file.sync_all()?;
    println!("{}", serde_json::to_string(&report["summary"])?);
    experiment
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computer_use_benchmark_keeps_failed_attempts() {
        let s = summarize(&[
            json!({"arm":"model_direct","success":true,"end_to_end_ms":100}),
            json!({"arm":"model_candidates_jev","success":false,"end_to_end_ms":1}),
        ]);
        assert!(s["observed_p50_speedup"].is_null());
        assert_eq!(s["arms"]["model_candidates_jev"]["attempts"], 1);
    }
}
