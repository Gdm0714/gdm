//! Scoped subprocess ownership. Only the group created by this object is signalled.
use crate::support::{Error, Result};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use std::{
    io::{Read, Write},
    os::unix::process::CommandExt,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub struct Owned {
    pub child: Child,
    group: Option<Pid>,
}
impl Owned {
    /// Observe exit without reaping: the kernel reserves the leader PID until
    /// stop() finishes signalling its owned group, preventing PID reuse races.
    pub fn exit_code(&self) -> Result<Option<i32>> {
        use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};
        let pid = Pid::from_raw(self.child.id() as i32)
            .ok_or_else(|| Error::new("process", "invalid child PID"))?;
        let status = waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        )
        .map_err(std::io::Error::from)?;
        Ok(status.map(|s| {
            s.exit_status()
                .unwrap_or_else(|| 128 + s.terminating_signal().unwrap_or(1))
        }))
    }
    pub fn spawn(command: &mut Command) -> Result<Self> {
        let child = command.process_group(0).spawn()?;
        let group = Some(Pid::from_raw(child.id() as i32));
        Ok(Self { child, group })
    }
    pub fn stop(&mut self) {
        if let Some(group) = self.group.take() {
            let _ = killpg(group, Signal::SIGTERM);
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline && matches!(self.exit_code(), Ok(None)) {
                thread::sleep(Duration::from_millis(20));
            }
            let _ = killpg(group, Signal::SIGKILL);
        }
        let _ = self.child.wait();
    }
    pub fn disarm(&mut self) {
        self.group = None;
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        if self.group.is_some() {
            self.stop();
        }
    }
}

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
    pub elapsed_ms: u128,
}
pub fn capture(
    command: Command,
    input: Vec<u8>,
    timeout: Duration,
    limit: usize,
) -> Result<Output> {
    capture_inner(command, input, timeout, limit, true)
}
/// Cleanup and boundary inspection must remain available after cancellation.
pub fn capture_cleanup(
    command: Command,
    input: Vec<u8>,
    timeout: Duration,
    limit: usize,
) -> Result<Output> {
    capture_inner(command, input, timeout, limit, false)
}
fn capture_inner(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
    limit: usize,
    honor_cancel: bool,
) -> Result<Output> {
    let started = Instant::now();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut owned = Owned::spawn(&mut command)?;
    let mut stdin = owned
        .child
        .stdin
        .take()
        .ok_or_else(|| Error::new("process", "missing stdin"))?;
    let stdout = owned
        .child
        .stdout
        .take()
        .ok_or_else(|| Error::new("process", "missing stdout"))?;
    let stderr = owned
        .child
        .stderr
        .take()
        .ok_or_else(|| Error::new("process", "missing stderr"))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let read = |mut pipe: Box<dyn Read + Send>, overflow: Arc<AtomicBool>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = pipe.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                if bytes.len() + n > limit {
                    overflow.store(true, Ordering::Relaxed);
                    return Err(std::io::Error::other("output limit exceeded"));
                }
                bytes.extend_from_slice(&chunk[..n]);
            }
            Ok::<_, std::io::Error>(bytes)
        })
    };
    let out = read(Box::new(stdout), overflow.clone());
    let err = read(Box::new(stderr), overflow.clone());
    let writer = thread::spawn(move || stdin.write_all(&input));
    let status = loop {
        if honor_cancel && super::cancelled() {
            owned.stop();
            return Err(Error::new("cancelled", "subprocess cancelled"));
        }
        if overflow.load(Ordering::Relaxed) {
            owned.stop();
            return Err(Error::new(
                "process_output_limit",
                "subprocess output exceeded its limit",
            ));
        }
        if started.elapsed() > timeout {
            owned.stop();
            return Err(Error::new("process_timeout", "subprocess timed out"));
        }
        if let Some(status) = owned.exit_code()? {
            break status;
        }
        thread::sleep(Duration::from_millis(10));
    };
    // Terminate any children still holding pipes before joining readers.
    owned.stop();
    let _ = writer.join();
    let stdout = out
        .join()
        .map_err(|_| Error::new("process", "stdout reader panicked"))??;
    let stderr = err
        .join()
        .map_err(|_| Error::new("process", "stderr reader panicked"))??;
    Ok(Output {
        stdout,
        stderr,
        code: status,
        elapsed_ms: started.elapsed().as_millis(),
    })
}
