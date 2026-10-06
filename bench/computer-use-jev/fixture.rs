//! Standalone, dependency-free guest fixture. Never executes submitted text.
//! Compiled for the same macOS/arm64 platform as the isolated Tart guest.
use std::{
    fs,
    io::{self, BufRead, Write},
    sync::mpsc,
    thread,
    time::Duration,
};
mod stamp;

fn main() -> io::Result<()> {
    let base = std::env::args().nth(1).expect("owned fixture base");
    // Alternate buffer keeps reset output out of Terminal scrollback.
    print!("\x1b[?1049h\x1b[?25l");
    io::stdout().flush()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let fields = ["Name", "City", "Seats", "Confirmation"];
    let mut run = fs::read_to_string(format!("{base}.reset"))?;
    let mut values: Vec<String> = vec![];
    let mut first = true;
    loop {
        let mut changed = first;
        first = false;
        if let Ok(line) = rx.recv_timeout(Duration::from_millis(50)) {
            if let Some(id) = line.strip_prefix("__GDM_RESET_") {
                if id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                    run = id.into();
                    values.clear();
                    changed = true;
                }
            } else if values.len() < fields.len() {
                // The fixture consumes one literal line. No command interpreter.
                let value: String = line
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || " -_".contains(*c))
                    .take(80)
                    .collect();
                values.push(value);
                changed = true;
            }
        }
        if changed {
            let [r, g, b] = stamp::color(values.len()).expect("bounded form stage");
            print!("\x1b[48;2;{r};{g};{b}m");
            print!("\x1b[?25l\x1b[2J\x1b[H\rGDM REUSE EXPERIMENT - ISOLATED TEST FORM\r\n\r\n");
            for (i, field) in fields.iter().enumerate() {
                println!(
                    "\r{} {}: {}",
                    if i == values.len() { ">" } else { " " },
                    field,
                    values.get(i).map(String::as_str).unwrap_or("")
                );
            }
            if values.len() < fields.len() {
                println!(
                    "\r\n\rEnter {} then Return. Confirmation accepts CONFIRM.",
                    fields[values.len()]
                );
            } else {
                println!("\r\n\rForm finished. No data was sent anywhere.");
            }
            io::stdout().flush()?;
            let strings = values
                .iter()
                .map(|v| format!("{v:?}"))
                .collect::<Vec<_>>()
                .join(",");
            let state = format!(
                "{{\"run_id\":{run:?},\"stage\":{},\"values\":[{}],\"fields\":[\"Name\",\"City\",\"Seats\",\"Confirmation\"]}}",
                values.len(),
                strings
            );
            fs::write(format!("{base}.pending"), state)?;
            fs::rename(format!("{base}.pending"), format!("{base}.state"))?;
        }
    }
}
