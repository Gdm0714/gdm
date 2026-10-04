//! Native evidence-driven GDM CLI runtime. No interpreter fallback.
pub mod attempt;
pub mod commands;
pub mod contract;
pub mod credentials;
pub mod delivery;
pub mod doctor;
pub mod evidence;
pub mod fingerprint;
pub mod habit;
pub mod protocol;
pub mod retro;
pub mod state;
pub mod store;
use crate::support::{Error, Result, ensure_flags, has_flag, print_json};
use std::path::Path;
pub fn run(cwd: &Path, argv: &[String]) -> Result<()> {
    let (command, args) = argv
        .split_first()
        .ok_or_else(|| Error::new("usage", "gdm 명령 필요"))?;
    let sub = args.first().map(String::as_str).unwrap_or("");
    let mutates = matches!(
        command.as_str(),
        "pass"
            | "attempt"
            | "recheck"
            | "done"
            | "feedback"
            | "miss"
            | "repair"
            | "protocol"
            | "habit"
            | "delivery"
    ) || (command == "plan"
        && sub != "list"
        && !(sub == "contract" && has_flag(args, "check-commit")))
        || (command == "audit" && sub == "verdict")
        || (command == "preset" && sub != "list");
    let _lock = if mutates {
        Some(store::lock(cwd)?)
    } else {
        None
    };
    match command.as_str() {
        "plan" => commands::plan(cwd, args),
        "pass" => commands::pass(cwd, args),
        "recheck" => commands::recheck(cwd, args),
        "audit" => commands::audit(cwd, args),
        "done" => commands::done(cwd, args),
        "status" => commands::status(cwd, args),
        "resume" => commands::resume(cwd, args),
        "miss" => commands::miss(cwd, args),
        "feedback" => commands::feedback(cwd, args),
        "preset" => commands::preset(cwd, args),
        "repair" => commands::repair(cwd, args),
        "delivery" => delivery::run(cwd, args),
        "attempt" => attempt::run(cwd, args),
        "retro" => retro::run(cwd, args),
        "habit" => habit::run(cwd, args),
        "protocol" => protocol::run(cwd, args),
        "workspace" => {
            if sub != "fingerprint" {
                return Err(Error::new("usage", "workspace fingerprint 필요"));
            }
            ensure_flags(&args[1..], &[], &["json"])?;
            if !has_flag(args, "json") {
                return Err(Error::new("usage", "workspace fingerprint는 --json 필요"));
            }
            print_json(&fingerprint::capture_source(cwd)?)
        }
        "doctor" => doctor::run(cwd),
        _ => Err(Error::new("usage", format!("알 수 없는 명령: {command}"))),
    }
}
