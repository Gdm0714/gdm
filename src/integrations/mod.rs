//! Provider adapters call native policy and storage through these commands.
pub mod agent;
pub mod context;
pub mod memory;
pub mod render;
pub mod role_runner;

use crate::support::{Error, Result};
use std::path::Path;

pub fn doctor_lines(cwd: &Path) -> Result<Vec<String>> {
    Ok(agent::doctor_lines(cwd))
}

pub fn run(cwd: &Path, argv: &[String], stdin: &str) -> Result<()> {
    match argv.first().map(String::as_str) {
        Some("agent") => agent::run(cwd, &argv[1..], stdin),
        Some("context" | "graph") => context::run(cwd, argv),
        Some("memory") => memory::run(cwd, &argv[1..], stdin),
        Some("render-skills") => render::run(cwd, &argv[1..]),
        Some("verify-manifests") => render::verify_manifests(cwd, &argv[1..]),
        Some("role-run") => role_runner::run(cwd, &argv[1..]),
        Some("provider-run") => role_runner::provider_run(cwd, &argv[1..]),
        _ => Err(Error::new("usage", "unknown integration command")),
    }
}
