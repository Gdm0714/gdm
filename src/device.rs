//! Physical iOS operations with bounded processes and per-run evidence.
mod config;
mod runner;
use crate::support::{Result, print_json};
pub use config::*;
pub use runner::*;
use std::path::Path;
pub const USAGE: &str = "gdm device list [--json]\ngdm device <doctor|build|install|test> [--config .gdm-device.json] [--json]\ngdm device capture [--config .gdm-device.json] [--case NAME] [--json]";
pub fn run(cwd: &Path, args: &[String]) -> Result<()> {
    if args.is_empty() || args == ["--help"] {
        println!("{USAGE}");
        return Ok(());
    }
    let options = Options::parse(args)?;
    crate::computer_use::signals()?;
    let receipt = execute(cwd, &options, &mut ProcessRunner, None)?;
    if options.json {
        print_json(&receipt)?;
    } else {
        crate::lprint!(
            "{}: {}\n기록: {}",
            "{}: {}\nRecord: {}",
            if receipt["success"] == true {
                crate::i18n::text("통과", "Passed")
            } else {
                crate::i18n::text("실패", "Failed")
            },
            options.action,
            receipt["receiptPath"].as_str().unwrap_or_default()
        );
        if let Some(rows) = receipt["devices"].as_array() {
            for row in rows {
                println!(
                    "{} · {} · {} · {}",
                    row["name"], row["connection"], row["id"], row["udid"]
                );
            }
        }
        if let Some(path) = receipt["capture"]["path"].as_str() {
            crate::lprint!(
                "화면: {path}\n이미지를 직접 열어 UI를 검수해 주세요.",
                "Screen: {path}\nOpen the image to review the UI."
            );
        }
    }
    if receipt["success"] != true {
        return Err(crate::support::Error::new(
            receipt["error"]["code"]
                .as_str()
                .unwrap_or("device_command_failed"),
            receipt["error"]["message"]
                .as_str()
                .unwrap_or(crate::i18n::text(
                    "실기기 작업 실패",
                    "Device operation failed",
                )),
        ));
    }
    Ok(())
}
