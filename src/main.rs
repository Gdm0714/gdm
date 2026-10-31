fn main() {
    use std::io::Read;
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut preference = None;
    if args
        .first()
        .is_some_and(|s| s == "--language" || s.starts_with("--language="))
    {
        let flag = args.remove(0);
        let value = if let Some(value) = flag.strip_prefix("--language=") {
            value.to_owned()
        } else if !args.is_empty() {
            args.remove(0)
        } else {
            String::new()
        };
        match gdm::i18n::Preference::parse(&value) {
            Ok(value) => preference = Some(value),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
    if let Err(error) = gdm::i18n::configure(preference) {
        eprintln!("{error}");
        std::process::exit(2);
    }
    if args.first().is_some_and(|s| s == "language") {
        let result = if args.len() == 2 {
            gdm::i18n::Preference::parse(&args[1]).and_then(|value| {
                let path = gdm::i18n::config_path()?;
                gdm::i18n::save_preference(&path, value)?;
                gdm::lprint!(
                    "언어 저장됨: {} (다음 실행부터 적용)",
                    "Language saved: {} (applies on next launch)",
                    value.name()
                );
                Ok(())
            })
        } else {
            Err("Usage: gdm language auto|ko|en".into())
        };
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let result = match args.first().map(String::as_str) {
        Some("--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("computer-use") => gdm::computer_use::run(&cwd, &args[1..]),
        Some("device") => gdm::device::run(&cwd, &args[1..]),
        Some(
            "agent" | "memory" | "render-skills" | "verify-manifests" | "context" | "graph"
            | "role-run" | "provider-run",
        ) => {
            let mut input = String::new();
            let needs_input = (args[0] == "agent" && args.get(1).is_some_and(|s| s == "hook"))
                || (["memory"].contains(&args[0].as_str())
                    && args.get(1).is_some_and(|s| s == "rpc"));
            if needs_input {
                if let Err(e) = std::io::stdin()
                    .take(4 * 1024 * 1024 + 1)
                    .read_to_string(&mut input)
                {
                    eprintln!("{e}");
                    std::process::exit(2);
                }
                if input.len() > 4 * 1024 * 1024 {
                    eprintln!("input exceeds 4 MiB");
                    std::process::exit(2);
                }
            }
            gdm::integrations::run(&cwd, &args, &input)
        }
        None | Some("--help" | "-h") => {
            eprintln!("{}", gdm::i18n::usage());
            eprintln!(
                "  gdm computer-use status|serve|mcp|select|benchmark\n  gdm device list|doctor|build|install|test|capture\n  gdm memory rpc\n  gdm render-skills --target codex|claude|gid --output DIR"
            );
            Ok(())
        }
        Some(
            "plan" | "pass" | "recheck" | "audit" | "done" | "status" | "resume" | "retro"
            | "feedback" | "preset" | "miss" | "repair" | "delivery" | "attempt" | "workspace"
            | "doctor" | "habit" | "protocol" | "regression" | "team",
        ) => gdm::runtime::run(&cwd, &args),
        _ => {
            eprintln!("{}", gdm::i18n::usage());
            Err(gdm::support::Error::new(
                "usage",
                gdm::i18n::text("알 수 없는 명령", "Unknown command"),
            ))
        }
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(e.exit_code());
    }
}
