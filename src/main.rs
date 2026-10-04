fn main() {
    use std::io::Read;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let result = match args.first().map(String::as_str) {
        Some("--version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("computer-use") => gdm::computer_use::run(&cwd, &args[1..]),
        Some(
            "agent" | "memory" | "render-skills" | "verify-manifests" | "context" | "graph"
            | "delegate" | "role-run" | "provider-run" | "pi-launch" | "pi-commands",
        ) => {
            let mut input = String::new();
            let needs_input = (args[0] == "agent" && args.get(1).is_some_and(|s| s == "hook"))
                || (["memory", "delegate", "pi-commands"].contains(&args[0].as_str())
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
            eprintln!(
                "{}",
                include_str!("usage.txt").replace("{VERSION}", env!("CARGO_PKG_VERSION"))
            );
            eprintln!(
                "  gdm computer-use status|serve|mcp|select|benchmark\n  gdm memory rpc\n  gdm render-skills --target codex|claude|pi --output DIR"
            );
            Ok(())
        }
        Some(
            "plan" | "pass" | "recheck" | "audit" | "done" | "status" | "resume" | "retro"
            | "feedback" | "preset" | "miss" | "repair" | "delivery" | "attempt" | "workspace"
            | "doctor" | "habit" | "protocol",
        ) => gdm::runtime::run(&cwd, &args),
        _ => {
            eprintln!(
                "{}",
                include_str!("usage.txt").replace("{VERSION}", env!("CARGO_PKG_VERSION"))
            );
            Err(gdm::support::Error::new("usage", "알 수 없는 명령"))
        }
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(e.exit_code());
    }
}
