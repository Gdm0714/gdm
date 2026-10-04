//! Native Codex hook admission and lifecycle ledger.
mod config;
mod ledger;
pub mod limit;
mod lock;
use crate::support::{Error, Result, print_json};
pub use ledger::parse_envelope;
pub use ledger::run_at as run_hook_at;
pub fn doctor_lines(cwd: &Path) -> Vec<String> {
    let mut lines = limit::doctor_lines(cwd);
    lines.extend(config::doctor_lines(cwd));
    lines
}
use std::path::Path;
pub fn run(cwd: &Path, args: &[String], stdin: &str) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("hook") => {
            if args.len() != 1
                && !(args.len() == 3 && args[1] == "--handler-id" && args[2] == "gdm-agent-gate-v1")
            {
                return Err(Error::new(
                    "agent_usage",
                    "gdm agent hook [--handler-id gdm-agent-gate-v1]",
                ));
            }
            print_json(&ledger::run(cwd, stdin))
        }
        Some("hook-install") => config::install(cwd, &args[1..]),
        Some("hook-status") => {
            if args[1..].iter().any(|s| s != "--json") || args.len() > 2 {
                return Err(Error::new("agent_usage", "unsupported agent options"));
            }
            let status = config::status(cwd)?;
            if args.len() == 2 {
                print_json(&status)
            } else {
                println!(
                    "Codex agent hooks: configured={} executable={} feature={} trust=unknown effective={}",
                    status["configured"],
                    status["executable"],
                    status["feature"]["state"],
                    status["effective"]
                );
                print_json(&status["ledgers"])
            }
        }
        _ => Err(Error::new(
            "agent_usage",
            "gdm agent hook | hook-install --binary <absolute path> [--dry-run] | hook-status [--json]",
        )),
    }
}
