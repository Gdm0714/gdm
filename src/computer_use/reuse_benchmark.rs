//! Opt-in controlled, multi-action comparison. This is not a general GUI planner.
use super::{
    jev::{self, Candidates},
    model,
    process::capture,
    reuse::{Cache, FormState},
    rfb::Frame,
    vm::TartVm,
};
use crate::support::{Error, Result, has_flag, now, read_flag, required_flag, sha256};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

const ARMS: [&str; 3] = ["model_each_step", "model_batch", "model_reuse_jev"];
const FIXTURE: &str = include_str!("../../bench/computer-use-jev/fixture.rs");
const STAMP: &str = include_str!("../../bench/computer-use-jev/stamp.rs");

fn propose(
    executable: &str,
    model: &str,
    expected: &[String],
    state: &FormState,
    frame: &Frame,
    arm: &str,
    events: &mut Vec<Value>,
) -> Result<(Cache, Vec<String>)> {
    let goal = format!(
        "Fill Name with '{}', City with '{}', Seats with '{}', then Confirmation with exactly 'CONFIRM'. Complete the four-field form.",
        expected[0], expected[1], expected[2]
    );
    let mut schema = json!({"type":"object","properties":{
        "candidates":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","properties":{
            "description":{"type":"string"},"action":{"type":"object","properties":{"action":{"type":"string","enum":["type_text"]},"text":{"type":"string"}},"required":["action","text"],"additionalProperties":false}},"required":["description","action"],"additionalProperties":false}}},
        "required":["candidates"],"additionalProperties":false});
    schema["properties"]["candidates"]["items"]["properties"]["action"]["properties"]["text"]["enum"] = json!(
        expected
            .iter()
            .map(|v| format!("{v}\n"))
            .collect::<Vec<_>>()
    );
    if arm == "model_each_step" {
        schema["properties"]["selected_index"] = json!({"type":"integer","minimum":0,"maximum":7,"description":"Zero-based index of the chosen entry in candidates. First entry is 0."});
        schema["required"] = json!(["candidates", "selected_index"]);
    } else if arm == "model_batch" {
        schema["properties"]["plan"] = json!({"type":"array","items":{"type":"integer","minimum":0,"maximum":7,"description":"Zero-based index in candidates"},"minItems":4-state.stage,"maxItems":4-state.stage});
        schema["required"] = json!(["candidates", "plan"]);
    }
    let mode = match arm {
        "model_each_step" => {
            "Propose concrete candidates for the current and remaining fields. Also choose the single best candidate in selected_index as its zero-based array index (first candidate is 0). Omit plan."
        }
        "model_batch" => {
            "Propose concrete candidates and put the best full ordered sequence of zero-based candidate array indices for ALL remaining fields in plan. Avoid unnecessary actions."
        }
        _ => {
            "Propose reusable concrete candidates covering ALL remaining fields. Do not choose a winner or sequence; omit plan. Another selector will choose from this same pool at each field."
        }
    };
    let prompt = format!(
        "You control an isolated, synthetic terminal form. Goal: {goal}\nCurrent authoritative fixture state: {}\nAll four fields are shown; the current field accepts one line then advances. There is no shell or arbitrary code execution. Each candidate must type one nonempty ASCII alphanumeric/space/hyphen/underscore value ending in ONE newline. No tabs, escape keys, multiple lines or shortcuts. Never submit multiple fields in one action. {} Return JSON. Do not use tools.",
        serde_json::to_string(state)?,
        mode
    );
    let started = Instant::now();
    let reply = model::request(executable, model, &prompt, &schema, frame);
    let mut event = json!({"kind":"model","stage":state.stage,"elapsed_ms":started.elapsed().as_millis(),"ok":reply.is_ok()});
    if let Ok(r) = &reply {
        event["usage"] = r.usage.clone();
        event["models_reported_by_cli"] = json!(r.observed_models);
        event["response"] = r.value.clone();
    }
    events.push(event);
    let r = reply?;
    let mut candidate_values = r.value["candidates"]
        .as_array()
        .ok_or_else(|| Error::new("benchmark_model", "missing candidates"))?
        .clone();
    for (index, candidate) in candidate_values.iter_mut().enumerate() {
        candidate
            .as_object_mut()
            .ok_or_else(|| Error::new("benchmark_model", "invalid candidate"))?
            .insert("id".into(), json!(format!("candidate_{index}")));
    }
    let pool: Candidates = serde_json::from_value(
        json!({"goal":goal,"observation":serde_json::to_string(state)?,"observation_sha256":frame.fingerprint(),"candidates":candidate_values}),
    )?;
    pool.validate()?;
    // The selector cannot authorize arbitrary terminal text. All candidates must
    // use one of the four literal values already authorized by this synthetic task.
    for candidate in &pool.candidates {
        if !matches!(&candidate.action, super::action::Action::TypeText { text }
            if expected.iter().any(|value| text == &format!("{value}\n")))
        {
            return Err(Error::new(
                "reuse_scope",
                "candidate text is outside the task's literal values",
            ));
        }
    }
    let indices = if arm == "model_reuse_jev" {
        vec![]
    } else if arm == "model_each_step" {
        vec![
            r.value["selected_index"]
                .as_u64()
                .ok_or_else(|| Error::new("benchmark_model", "missing selected_index"))?,
        ]
    } else {
        serde_json::from_value::<Vec<u64>>(r.value["plan"].clone())
            .map_err(|_| Error::new("benchmark_model", "missing index plan"))?
    };
    let plan = resolve_indices(&pool, &indices)?;
    let expected = if arm == "model_each_step" {
        1
    } else {
        4 - state.stage
    };
    if arm != "model_reuse_jev"
        && (plan.len() != expected
            || plan
                .iter()
                .any(|id| !pool.candidates.iter().any(|c| &c.id == id)))
    {
        return Err(Error::new(
            "benchmark_model",
            "invalid model plan IDs or length",
        ));
    }
    events.last_mut().unwrap()["proposal"] = serde_json::to_value(&pool)?;
    events.last_mut().unwrap()["plan"] = json!(plan);
    Ok((Cache::new(pool, state.clone(), Instant::now())?, plan))
}

fn resolve_indices(pool: &Candidates, indices: &[u64]) -> Result<Vec<String>> {
    indices
        .iter()
        .map(|i| {
            usize::try_from(*i)
                .ok()
                .and_then(|i| pool.candidates.get(i))
                .map(|c| c.id.clone())
                .ok_or_else(|| Error::new("benchmark_model", "candidate index out of bounds"))
        })
        .collect()
}

struct Experiment<'a> {
    executable: &'a str,
    model: &'a str,
    key: &'a str,
    diagnostic_prefix: Option<&'a str>,
}
impl Experiment<'_> {
    fn attempt(
        &self,
        vm: &mut TartVm,
        repeat: usize,
        arm: &str,
        initial: FormState,
        expected: &[String],
    ) -> Value {
        let begin = Instant::now();
        let mut events = Vec::new();
        let mut steps = Vec::new();
        let mut regenerations = 0usize;
        let mut row = json!({"repeat":repeat,"arm":arm,"success":false,"run_id":initial.run_id,"expected":expected,"fixture":"owned-rust-four-field-form","model_requested":self.model});
        let result = (|| -> Result<()> {
            let mut state = initial;
            let mut screen = vm.reuse_screen(&state)?;
            row["initial_visual_sync"] = json!(state.screen_matches(&screen));
            if let Some(prefix) = self.diagnostic_prefix {
                fs::write(
                    format!("{prefix}-{repeat}-{arm}-initial.png"),
                    screen.png()?,
                )?;
            }
            let mut cache = None;
            let mut plan = Vec::new();
            let mut index = 0;
            while state.stage < 4 {
                if super::cancelled() {
                    return Err(Error::new("cancelled", "experiment cancelled"));
                }
                eprintln!(
                    "reuse benchmark: {arm} repeat {} field {}",
                    repeat + 1,
                    state.stage + 1
                );
                if cache.is_none() || arm == "model_each_step" {
                    let (c, p) = propose(
                        self.executable,
                        self.model,
                        expected,
                        &state,
                        &screen,
                        arm,
                        &mut events,
                    )?;
                    cache = Some(c);
                    plan = p;
                    index = 0;
                }
                let decision = (|| -> Result<_> {
                    let c = cache.as_ref().unwrap();
                    let observed = vm.reuse_state()?;
                    let frame = vm.reuse_screen(&observed)?;
                    if frame.fingerprint() != screen.fingerprint() {
                        events.push(json!({"kind":"screen_changed","stage":state.stage,"before":screen.fingerprint(),"after":frame.fingerprint()}));
                        if let Some(prefix) = self.diagnostic_prefix {
                            fs::write(
                                format!("{prefix}-{repeat}-{arm}-{}-before.png", events.len()),
                                screen.png()?,
                            )?;
                            fs::write(
                                format!("{prefix}-{repeat}-{arm}-{}-after.png", events.len()),
                                frame.png()?,
                            )?;
                        }
                    }
                    let set = c.bind(&observed, &frame.fingerprint(), Instant::now())?;
                    let mut jev_selection = None;
                    if arm == "model_reuse_jev" {
                        let started = Instant::now();
                        let result = jev::select(&set, self.key, "jev-1.13.0", 0.8);
                        let mut event = json!({"kind":"jev","stage":state.stage,"elapsed_ms":started.elapsed().as_millis(),"ok":result.is_ok()});
                        if let Ok(s) = &result {
                            event["selection"] = serde_json::to_value(s)?;
                        }
                        events.push(event);
                        jev_selection = Some(result?);
                    }
                    // Same final state AND full-pixel check for all three arms.
                    let current = vm.reuse_state()?;
                    let frame = vm.reuse_screen(&current)?;
                    let action = if let Some(selection) = jev_selection {
                        c.authorize(
                            &set,
                            &selection,
                            &current,
                            &frame.fingerprint(),
                            Instant::now(),
                        )?
                    } else {
                        let id = plan
                            .get(index)
                            .ok_or_else(|| Error::new("benchmark_model", "model plan exhausted"))?;
                        c.authorize_id(&set, id, &current, &frame.fingerprint(), Instant::now())?
                    };
                    Ok(action)
                })();
                let action = match decision {
                    Ok(action) => action,
                    Err(e)
                        if arm == "model_reuse_jev"
                            && regenerations < 1
                            && matches!(
                                e.code.as_str(),
                                "benchmark_abstain" | "computer_use_stale" | "reuse_expired"
                            ) =>
                    {
                        events
                            .push(json!({"kind":"invalidate","reason":e.code,"stage":state.stage}));
                        regenerations += 1;
                        let fresh = vm.reuse_state()?;
                        if fresh.run_id != state.run_id {
                            return Err(Error::new("reuse_target", "form instance changed"));
                        }
                        state = fresh;
                        screen = vm.reuse_screen(&state)?;
                        cache = None;
                        continue;
                    }
                    Err(e) => return Err(e),
                };
                let execute = Instant::now();
                vm.action(&action)?;
                let next = vm.reuse_state()?;
                let after = vm.reuse_screen(&next)?;
                cache
                    .as_mut()
                    .unwrap()
                    .advance(&action, next.clone(), after.fingerprint())?;
                steps.push(json!({"stage":state.stage,"action":action,"execution_and_observation_ms":execute.elapsed().as_millis(),"state_after":next,"screen_after":after.fingerprint(),"visual_sync":next.screen_matches(&after)}));
                state = next;
                screen = after;
                index += 1;
            }
            row["end_to_end_ms"] = json!(begin.elapsed().as_millis());
            let verify = Instant::now();
            let final_state = vm.reuse_state()?;
            row["verification_ms"] = json!(verify.elapsed().as_millis());
            row["final_state"] = serde_json::to_value(&final_state)?;
            row["success"] = json!(
                steps.len() == 4
                    && final_state.run_id == row["run_id"]
                    && final_state.stage == 4
                    && final_state.values == expected
            );
            Ok(())
        })();
        row["attempt_wall_ms"] = json!(begin.elapsed().as_millis());
        if row["end_to_end_ms"].is_null() {
            row["end_to_end_ms"] = row["attempt_wall_ms"].clone();
        }
        if let Err(e) = result {
            row["error_code"] = json!(e.code);
            row["error_detail"] = json!(e.message);
        }
        row["model_calls"] = json!(events.iter().filter(|e| e["kind"] == "model").count());
        row["jev_calls"] = json!(events.iter().filter(|e| e["kind"] == "jev").count());
        row["regenerations"] = json!(regenerations);
        row["events"] = json!(events);
        row["steps"] = json!(steps);
        eprintln!(
            "reuse benchmark: {arm} success={} total={}ms model_calls={} error={}",
            row["success"], row["end_to_end_ms"], row["model_calls"], row["error_code"]
        );
        row
    }
}
fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    })
}
fn summarize(rows: &[Value]) -> Value {
    let mut arms = serde_json::Map::new();
    for arm in ARMS {
        let rows: Vec<_> = rows.iter().filter(|r| r["arm"] == arm).collect();
        arms.insert(arm.into(),json!({"attempts":rows.len(),"succeeded":rows.iter().filter(|r| r["success"]==true).count(),"p50_ms":median(rows.iter().filter_map(|r|r["end_to_end_ms"].as_f64()).collect()),"model_calls":rows.iter().filter_map(|r|r["model_calls"].as_u64()).sum::<u64>(),"jev_calls":rows.iter().filter_map(|r|r["jev_calls"].as_u64()).sum::<u64>()}));
    }
    let equal = ARMS.iter().all(|a| {
        arms[*a]["attempts"].as_u64().unwrap_or(0) > 0
            && arms[*a]["succeeded"] == arms[*a]["attempts"]
    });
    let hybrid = arms["model_reuse_jev"]["p50_ms"].as_f64().unwrap_or(0.0);
    json!({"all_attempts_succeeded":equal,"speedup_vs_each_step":if equal&&hybrid>0.0{arms["model_each_step"]["p50_ms"].as_f64().map(|v|v/hybrid)}else{None},"speedup_vs_batch":if equal&&hybrid>0.0{arms["model_batch"]["p50_ms"].as_f64().map(|v|v/hybrid)}else{None},"arms":arms})
}
fn save(file: &mut fs::File, report: &Value) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    file.set_len(0)?;
    file.write_all(serde_json::to_string_pretty(report)?.as_bytes())?;
    file.sync_all()?;
    Ok(())
}
pub(super) fn run(args: &[String]) -> Result<()> {
    if !has_flag(args, "live-vm") {
        return Err(Error::new("usage", "benchmark-reuse requires --live-vm"));
    }
    let output = required_flag(args, "output")?;
    let repeats = read_flag(args, "repeats")?
        .unwrap_or_else(|| "5".into())
        .parse::<usize>()
        .map_err(|_| Error::new("usage", "invalid repeats"))?;
    if !(1..=10).contains(&repeats) {
        return Err(Error::new("usage", "repeats must be 1 to 10"));
    }
    let model = read_flag(args, "model")?.unwrap_or_else(|| "sonnet".into());
    let executable = read_flag(args, "claude")?.unwrap_or_else(|| "claude".into());
    let env = read_flag(args, "env-file")?;
    let key = jev::api_key(env.as_deref().map(Path::new))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    super::signals()?;
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("fixture.rs");
    let binary = temp.path().join("fixture");
    fs::write(&source, FIXTURE)?;
    fs::write(temp.path().join("stamp.rs"), STAMP)?;
    let mut compiler = Command::new("rustc");
    compiler
        .args(["--edition=2024", "-O"])
        .arg(&source)
        .arg("-o")
        .arg(&binary);
    if capture(compiler, vec![], Duration::from_secs(60), 65536)?.code != 0 {
        return Err(Error::new(
            "benchmark_fixture",
            "fixture compilation failed",
        ));
    }
    let fixture = fs::read(binary)?;
    let mut report = json!({"schemaVersion":"gdm-computer-use-jev-reuse/v1","started_at":now(),"runtime":"rust","mode":"live-vm","model_requested":model,"completed":false,"credential_included":false,"fixture_source_sha256":sha256(format!("{FIXTURE}{STAMP}")),"runtime_source_sha256":sha256(concat!(include_str!("model.rs"),include_str!("reuse.rs"),include_str!("reuse_benchmark.rs"),include_str!("vm.rs"),include_str!("jev.rs"),include_str!("rfb.rs"))),"fixture_binary_sha256":sha256(&fixture),"max_regenerations_per_attempt":1,"samples":[],"limitations":"Controlled, instrumented Rust form in a dedicated macOS VM; not arbitrary application automation. Models receive synthetic screenshots and structured fixture observations. A fresh official CLI process is used for every model call. All arms use identical guards and literal one-line input bounds. Small rotating-order pilot, not statistical proof. Includes observation, model, selection, GUI execution and regeneration costs. Excludes VM preparation, fixture reset and final independent state-file verification. Batch model is included to distinguish batching gains from Jev-specific gains."});
    save(&mut file, &report)?;
    let mut vm = TartVm::default();
    let outcome = (|| -> Result<()> {
        eprintln!("reuse benchmark: starting owned isolated VM");
        vm.start()?;
        if has_flag(args, "fixture-check") {
            let mut states = Vec::new();
            for _ in 0..2 {
                let mut state = vm.reuse_prepare(&fixture, &uuid::Uuid::new_v4().to_string())?;
                eprintln!("fixture check: reset {}", state.run_id);
                report["fixture_check_pending_state"] = json!(state);
                vm.reuse_screen(&state)?;
                for value in ["Test User", "Seoul", "2", "CONFIRM"] {
                    vm.action(&super::action::Action::TypeText {
                        text: format!("{value}\n"),
                    })?;
                    state = vm.reuse_state()?;
                    eprintln!("fixture check: field {}", state.stage);
                    report["fixture_check_pending_state"] = json!(state);
                    let frame = vm.reuse_screen(&state)?;
                    states.push(json!({"state":state,"visual_sync":state.screen_matches(&frame)}));
                    report["fixture_check"] = json!(states);
                    save(&mut file, &report)?;
                }
            }
            report["fixture_check"] = json!(states);
            return Ok(());
        }
        for repeat in 0..repeats {
            let expected = vec![
                format!("Test User {}", repeat + 1),
                if repeat % 2 == 0 {
                    "Seoul".into()
                } else {
                    "Busan".into()
                },
                (repeat % 4 + 1).to_string(),
                "CONFIRM".into(),
            ];
            for offset in 0..3 {
                if super::cancelled() {
                    return Err(Error::new("cancelled", "benchmark cancelled"));
                }
                let arm = ARMS[(repeat + offset) % 3];
                let state = vm.reuse_prepare(&fixture, &uuid::Uuid::new_v4().to_string())?;
                let row = Experiment {
                    executable: &executable,
                    model: &model,
                    key: &key,
                    diagnostic_prefix: has_flag(args, "diagnostic-frames")
                        .then_some(output.as_str()),
                }
                .attempt(&mut vm, repeat, arm, state, &expected);
                report["samples"].as_array_mut().unwrap().push(row);
                report["summary"] = summarize(report["samples"].as_array().unwrap());
                save(&mut file, &report)?;
            }
        }
        Ok(())
    })();
    if outcome.is_err()
        && has_flag(args, "diagnostic-frames")
        && let Ok(frame) = vm.screenshot()
    {
        let _ = fs::write(format!("{output}-last.png"), frame.png()?);
    }
    vm.stop();
    report["completed"] = json!(outcome.is_ok());
    report["finished_at"] = json!(now());
    report["error_code"] = json!(outcome.as_ref().err().map(|e| &e.code));
    report["summary"] = summarize(report["samples"].as_array().unwrap());
    save(&mut file, &report)?;
    println!("{}", report["summary"]);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computer_use_reuse_model_indices_resolve_only_to_original_candidates() {
        let pool: Candidates = serde_json::from_value(json!({"goal":"Fill form","observation":"City field","observation_sha256":"a".repeat(64),"candidates":[{"id":"candidate_0","description":"Name","action":{"action":"type_text","text":"Test User 1\n"}},{"id":"candidate_1","description":"City","action":{"action":"type_text","text":"Seoul\n"}}]})).unwrap();
        assert_eq!(
            resolve_indices(&pool, &[1, 0]).unwrap(),
            ["candidate_1", "candidate_0"]
        );
        assert!(resolve_indices(&pool, &[2]).is_err());
        assert!(resolve_indices(&pool, &[u64::MAX]).is_err());
    }
    #[test]
    fn computer_use_reuse_summary_retains_failure_and_compares_batch() {
        let mut rows = vec![
            json!({"arm":"model_each_step","success":true,"end_to_end_ms":40,"model_calls":4}),
            json!({"arm":"model_batch","success":true,"end_to_end_ms":10,"model_calls":1}),
            json!({"arm":"model_reuse_jev","success":true,"end_to_end_ms":12,"model_calls":1,"jev_calls":4}),
        ];
        let s = summarize(&rows);
        assert!(s["speedup_vs_each_step"].as_f64().unwrap() > 3.0);
        assert!(s["speedup_vs_batch"].as_f64().unwrap() < 1.0);
        rows.push(json!({"arm":"model_reuse_jev","success":false,"end_to_end_ms":1}));
        let s = summarize(&rows);
        assert_eq!(s["arms"]["model_reuse_jev"]["attempts"], 2);
        assert!(s["speedup_vs_each_step"].is_null());
    }
}
