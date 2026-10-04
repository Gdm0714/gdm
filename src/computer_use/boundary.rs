//! Observe only children of the owned VM roots. PID start identities survive
//! reparenting; unrelated processes are never selected by executable name.
use super::process::capture_cleanup as capture;
use crate::support::{Error, Result};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Clone, Debug)]
struct Record {
    pid: i32,
    parent: i32,
    group: i32,
    started: String,
}
fn table() -> Result<Vec<Record>> {
    let mut c = Command::new("/bin/ps");
    c.args(["-axo", "pid=,ppid=,pgid=,lstart="]);
    let out = capture(c, vec![], Duration::from_secs(5), 1024 * 1024)?;
    if out.code != 0 {
        return Err(Error::new(
            "computer_use_boundary",
            "could not inspect owned process identities",
        ));
    }
    let mut records = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<_> = line.split_whitespace().collect();
        if f.len() < 8 {
            return Err(Error::new(
                "computer_use_boundary",
                "invalid process identity table",
            ));
        }
        let parse = |s: &str| {
            s.parse::<i32>()
                .map_err(|_| Error::new("computer_use_boundary", "invalid process ID"))
        };
        records.push(Record {
            pid: parse(f[0])?,
            parent: parse(f[1])?,
            group: parse(f[2])?,
            started: f[3..].join(" "),
        });
    }
    Ok(records)
}
#[derive(Default)]
struct State {
    roots: BTreeMap<i32, String>,
    known: BTreeMap<i32, String>,
    failure: Option<String>,
}
impl State {
    fn inspect(&mut self) -> Result<()> {
        if self.roots.is_empty() {
            return Ok(());
        }
        let records = table()?;
        let mut reachable = BTreeSet::new();
        for (&pid, start) in &self.roots {
            if !records.iter().any(|r| r.pid == pid && &r.started == start) {
                return Err(Error::new(
                    "computer_use_boundary",
                    "owned VM root disappeared",
                ));
            }
            reachable.insert(pid);
        }
        loop {
            let before = reachable.len();
            for r in &records {
                if reachable.contains(&r.parent) || self.roots.contains_key(&r.group) {
                    reachable.insert(r.pid);
                }
            }
            if reachable.len() == before {
                break;
            }
        }
        self.known
            .retain(|pid, start| records.iter().any(|r| &r.pid == pid && &r.started == start));
        for r in &records {
            if reachable.contains(&r.pid) {
                self.known.insert(r.pid, r.started.clone());
            }
        }
        if self.known.keys().any(|pid| !reachable.contains(pid)) {
            return Err(Error::new(
                "computer_use_boundary",
                "owned descendant escaped process containment",
            ));
        }
        let pids = self
            .known
            .keys()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        if pids.is_empty() {
            return Err(Error::new(
                "computer_use_boundary",
                "owned process tree disappeared",
            ));
        }
        let mut c = Command::new("/usr/sbin/lsof");
        c.args(["-nP", "-a", "-p", &pids, "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
        let out = capture(c, vec![], Duration::from_secs(5), 65536)?;
        if !out.stdout.is_empty() {
            return Err(Error::new(
                "computer_use_boundary",
                "owned runtime opened a host TCP listener",
            ));
        }
        if out.code != 0 && out.code != 1 {
            return Err(Error::new(
                "computer_use_boundary",
                "could not verify host listener boundary",
            ));
        }
        Ok(())
    }
    fn terminate_known(&self, only_outside_groups: bool) {
        // Revalidate every individual PID immediately before signalling. Root
        // leaders remain unreaped in Owned until this monitor has been joined.
        for signal in [Signal::SIGTERM, Signal::SIGKILL] {
            if let Ok(records) = table() {
                for r in records.iter().rev() {
                    if only_outside_groups && self.roots.contains_key(&r.group) {
                        continue;
                    }
                    if self.known.get(&r.pid) == Some(&r.started)
                        || self.roots.get(&r.pid) == Some(&r.started)
                    {
                        let _ = kill(Pid::from_raw(r.pid), signal);
                    }
                }
            }
            if signal == Signal::SIGTERM {
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}
pub struct Boundary {
    state: Arc<Mutex<State>>,
    stopping: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Boundary {
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let stopping = Arc::new(AtomicBool::new(false));
        let s = state.clone();
        let stop = stopping.clone();
        let handle = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let mut state = s.lock().unwrap_or_else(|e| e.into_inner());
                if let Err(e) = state.inspect() {
                    if !stop.load(Ordering::Acquire) {
                        state.failure = Some(e.message);
                        state.terminate_known(false);
                    }
                    break;
                }
                drop(state);
                for _ in 0..5 {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
            }
        });
        Self {
            state,
            stopping,
            thread: Some(handle),
        }
    }
    pub fn add(&self, pid: u32) -> Result<()> {
        let records = table()?;
        let record = records
            .iter()
            .find(|r| r.pid == pid as i32)
            .ok_or_else(|| {
                Error::new(
                    "computer_use_boundary",
                    "owned root exited before registration",
                )
            })?;
        let mut s = self
            .state
            .lock()
            .map_err(|_| Error::new("computer_use_boundary", "process monitor failed"))?;
        s.roots.insert(record.pid, record.started.clone());
        s.known.insert(record.pid, record.started.clone());
        Ok(())
    }
    pub fn remove(&self, pid: u32) {
        if let Ok(mut s) = self.state.lock() {
            s.roots.remove(&(pid as i32));
            s.known.remove(&(pid as i32));
        }
    }
    pub fn check(&self) -> Result<()> {
        let mut s = self
            .state
            .lock()
            .map_err(|_| Error::new("computer_use_boundary", "process monitor failed"))?;
        if let Some(f) = &s.failure {
            return Err(Error::new("computer_use_boundary", f.clone()));
        }
        if let Err(e) = s.inspect() {
            s.failure = Some(e.message.clone());
            s.terminate_known(false);
            return Err(e);
        }
        Ok(())
    }
}
impl Drop for Boundary {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if let Ok(s) = self.state.lock() {
            s.terminate_known(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computer_use_process_table_has_current_identity() {
        let rows = table().unwrap();
        assert!(
            rows.iter()
                .any(|r| r.pid == std::process::id() as i32 && !r.started.is_empty())
        );
    }
}
