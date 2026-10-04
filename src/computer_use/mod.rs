pub mod process;

use crate::support::Result;
use std::sync::atomic::{AtomicBool, Ordering};
static CANCELLED: AtomicBool = AtomicBool::new(false);
pub fn cancelled() -> bool {
    CANCELLED.load(Ordering::Relaxed)
}
pub fn signals() -> Result<()> {
    let mut signals = signal_hook::iterator::Signals::new([
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
    ])?;
    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            CANCELLED.store(true, Ordering::Relaxed);
        }
    });
    Ok(())
}
