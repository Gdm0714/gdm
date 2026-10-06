use super::{
    action::Action,
    process::{Owned, capture, capture_cleanup},
    rfb::{Frame, Rfb, apple_password},
};
use crate::support::{Error, Result, sha256};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel},
    thread,
    time::{Duration, Instant},
};

pub(crate) const VM: &str = "gdm-cu-vm";
const SANDBOX: &str = "(version 1) (allow default) (deny process-fork)";
pub(crate) const TART_SHA: &str =
    "4247b559b8d3f216127bf864f00397880a79c1e16dcccfcadeec708d0f39b950";
pub(crate) const BINARY_SHA: &str =
    "e0d71385a2974229c3e97f71862020cce4911c16c3a2fb74ab5e6f540a62131e";
pub(crate) const SOFTNET_SHA: &str =
    "5982c8cde55cd039d4aa71add54356224b8b8a040df1a8786f16327b421f701d";

pub struct ChannelReader {
    receiver: Receiver<io::Result<Vec<u8>>>,
    pending: Vec<u8>,
    offset: usize,
}
impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.offset == self.pending.len() {
            if super::cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "computer use cancelled",
                ));
            }
            if Instant::now() > deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "RFB read timed out",
                ));
            }
            match self.receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(bytes) => {
                    self.pending = bytes?;
                    self.offset = 0;
                    if self.pending.is_empty() {
                        return Ok(0);
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len() - self.offset);
        buf[..n].copy_from_slice(&self.pending[self.offset..self.offset + n]);
        self.offset += n;
        Ok(n)
    }
}
fn read_pipe(mut pipe: impl Read + Send + 'static, sender: SyncSender<io::Result<Vec<u8>>>) {
    thread::spawn(move || {
        loop {
            let mut b = vec![0; 8192];
            match pipe.read(&mut b) {
                Ok(n) => {
                    b.truncate(n);
                    if sender.send(Ok(b)).is_err() || n == 0 {
                        break;
                    }
                }
                Err(e) => {
                    let _ = sender.send(Err(e));
                    break;
                }
            }
        }
    });
}
type GuestRfb = Rfb<ChannelReader, ChildStdin>;
pub struct TartVm {
    boundary: Option<super::boundary::Boundary>,
    fixture: Option<String>,
    fixture_files: Vec<String>,
    reuse_base: Option<String>,
    reuse_terminal_pid: Option<u64>,
    tart: Option<PathBuf>,
    run: Option<Owned>,
    tunnel: Option<Owned>,
    rfb: Option<GuestRfb>,
    pub observed: Option<String>,
    state: String,
    last_error: Option<String>,
}
impl Default for TartVm {
    fn default() -> Self {
        Self {
            boundary: None,
            fixture: None,
            fixture_files: vec![],
            reuse_base: None,
            reuse_terminal_pid: None,
            tart: None,
            run: None,
            tunnel: None,
            rfb: None,
            observed: None,
            state: "stopped".into(),
            last_error: None,
        }
    }
}
impl TartVm {
    fn executable(&mut self) -> Result<PathBuf> {
        if let Some(p) = &self.tart {
            return Ok(p.clone());
        }
        let override_path = std::env::var_os("GDM_TART_PATH");
        let path = PathBuf::from(
            override_path
                .as_deref()
                .unwrap_or(std::ffi::OsStr::new("/opt/homebrew/bin/tart")),
        );
        if !path.is_absolute() {
            return Err(Error::new(
                "computer_use_unavailable",
                "GDM_TART_PATH must be absolute",
            ));
        }
        let path = path
            .canonicalize()
            .map_err(|_| Error::new("computer_use_unavailable", "Tart is not installed"))?;
        if override_path.is_none() {
            let binary = path
                .parent()
                .ok_or_else(|| Error::new("computer_use_unavailable", "invalid Tart path"))?
                .join("../libexec/tart.app/Contents/MacOS/tart")
                .canonicalize()?;
            for (p, expected) in [
                (path.as_path(), TART_SHA),
                (binary.as_path(), BINARY_SHA),
                (Path::new("/opt/homebrew/bin/softnet"), SOFTNET_SHA),
            ] {
                if sha256(std::fs::read(p)?) != expected {
                    return Err(Error::new(
                        "computer_use_unavailable",
                        "Tart or Softnet differs from the pinned audited build",
                    ));
                }
            }
        }
        self.tart = Some(path.clone());
        Ok(path)
    }
    fn command(&mut self, args: &[&str]) -> Result<Command> {
        let tart = self.executable()?;
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.args(["-p", SANDBOX]).arg(tart).args(args);
        clean_env(&mut c);
        Ok(c)
    }
    fn call(&mut self, args: &[&str], input: Vec<u8>, seconds: u64) -> Result<Vec<u8>> {
        let c = self.command(args)?;
        let out = capture(c, input, Duration::from_secs(seconds), 65536)?;
        if out.code != 0 {
            return Err(Error::new(
                "computer_use_process",
                format!("Tart command failed with exit {}", out.code),
            ));
        }
        Ok(out.stdout)
    }
    pub fn status(&mut self) -> Value {
        let result = (|| -> Result<()> {
            let bytes = self.call(
                &["list", "--source", "local", "--format", "json"],
                vec![],
                10,
            )?;
            let records: Value = serde_json::from_slice(&bytes)?;
            let entries = records
                .as_array()
                .ok_or_else(|| Error::new("computer_use_process", "invalid VM list"))?;
            if let Some(record) = entries.iter().find(|r| r["Name"] == VM) {
                if record["Running"] == true && self.run.is_none() {
                    self.state = "failed".into();
                    self.last_error = Some("VM belongs to another process".into());
                } else if record["Running"] != true {
                    self.state = "stopped".into();
                }
            } else {
                self.state = "no-vm".into();
            }
            Ok(())
        })();
        if let Err(e) = result {
            self.state = "not-installed".into();
            self.last_error = Some(e.message);
        }
        json!({"state":self.state,"vmName":VM,"owned":self.run.is_some(),"lastError":self.last_error})
    }
    pub fn start(&mut self) -> Result<Frame> {
        if self.run.is_some() {
            return self.screenshot();
        }
        let s = self.status();
        if s["state"] != "stopped" {
            return Err(Error::new(
                "computer_use_unavailable",
                format!(
                    "VM cannot start: {}. Run computer-use setup first; an existing owner's VM is never attached.",
                    s["state"]
                ),
            ));
        }
        self.state = "starting".into();
        let result = self.start_inner();
        if let Err(ref e) = result {
            self.stop();
            self.state = "failed".into();
            self.last_error = Some(e.message.clone());
        }
        result
    }
    fn start_inner(&mut self) -> Result<Frame> {
        let mut command = Command::new(self.executable()?);
        clean_env(&mut command);
        command
            .args([
                "run",
                VM,
                "--no-graphics",
                "--no-clipboard",
                "--net-softnet",
                "--net-softnet-block=0.0.0.0/0",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        self.run = Some(Owned::spawn(&mut command)?);
        let boundary = super::boundary::Boundary::new();
        boundary.add(self.run.as_ref().unwrap().child.id())?;
        self.boundary = Some(boundary);
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if super::cancelled() {
                return Err(Error::new("cancelled", "VM start cancelled"));
            }
            if self.call(&["exec", VM, "/usr/bin/true"], vec![], 5).is_ok() {
                break;
            }
            if Instant::now() > deadline {
                return Err(Error::new(
                    "computer_use_timeout",
                    "guest did not become ready",
                ));
            }
            thread::sleep(Duration::from_millis(500));
        }
        self.assert_no_host_listener()?;
        let marker = self.call(
            &["exec", VM, "/bin/cat", "/var/db/gdm-computer-use-vsock"],
            vec![],
            10,
        )?;
        if marker != b"gdm-computer-use-vsock-v1\n" && marker != b"gdm-computer-use-vsock-v1" {
            return Err(Error::new(
                "computer_use_unavailable",
                "guest preparation marker mismatch",
            ));
        }
        let mut password = vec![0u8; 8];
        getrandom::fill(&mut password).map_err(|_| {
            Error::new(
                "computer_use_unavailable",
                "secure guest credential generation failed",
            )
        })?;
        let result = (|| {
            self.call(
                &[
                    "exec",
                    "-i",
                    VM,
                    "/usr/bin/sudo",
                    "/usr/bin/tee",
                    "/Library/Preferences/com.apple.VNCSettings.txt",
                ],
                apple_password(&password)?,
                10,
            )?;
            self.call(
                &[
                    "exec",
                    VM,
                    "/usr/bin/sudo",
                    "/bin/chmod",
                    "600",
                    "/Library/Preferences/com.apple.VNCSettings.txt",
                ],
                vec![],
                10,
            )?;
            self.call(
                &[
                    "exec",
                    VM,
                    "/usr/bin/sudo",
                    "/bin/launchctl",
                    "kickstart",
                    "-k",
                    "system/com.apple.screensharing",
                ],
                vec![],
                10,
            )?;
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                match self.connect(&password) {
                    Ok(()) => break,
                    Err(e) => {
                        self.rfb = None;
                        if let Some(t) = self.tunnel.as_ref()
                            && let Some(b) = &self.boundary
                        {
                            b.remove(t.child.id());
                        }
                        self.tunnel = None;
                        if Instant::now() > deadline {
                            return Err(e);
                        }
                        thread::sleep(Duration::from_millis(300));
                    }
                }
            }
            self.assert_no_host_listener()?;
            self.state = "ready".into();
            self.screenshot()
        })();
        password.fill(0);
        result
    }
    fn connect(&mut self, password: &[u8]) -> Result<()> {
        let mut c = self.command(&["exec", "-i", VM, "/usr/bin/nc", "127.0.0.1", "5900"])?;
        c.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut tunnel = Owned::spawn(&mut c)?;
        let stdin = tunnel
            .child
            .stdin
            .take()
            .ok_or_else(|| Error::new("rfb", "missing stdin"))?;
        let stdout = tunnel
            .child
            .stdout
            .take()
            .ok_or_else(|| Error::new("rfb", "missing stdout"))?;
        let (tx, rx) = sync_channel(16);
        read_pipe(stdout, tx);
        if let Some(b) = &self.boundary {
            b.add(tunnel.child.id())?;
        }
        self.tunnel = Some(tunnel);
        self.rfb = Some(Rfb::connect(
            ChannelReader {
                receiver: rx,
                pending: vec![],
                offset: 0,
            },
            stdin,
            password,
        )?);
        Ok(())
    }
    pub fn screenshot(&mut self) -> Result<Frame> {
        self.assert_no_host_listener()?;
        let frame = self
            .rfb
            .as_mut()
            .ok_or_else(|| Error::new("computer_use_unavailable", "start the VM first"))?
            .screenshot()?;
        self.observed = Some(frame.fingerprint());
        Ok(frame)
    }
    pub fn action(&mut self, action: &Action) -> Result<Frame> {
        action.validate()?;
        self.assert_no_host_listener()?;
        if self.observed.is_none() {
            return Err(Error::new(
                "computer_use_observation_required",
                "read a screenshot before acting",
            ));
        }
        if let Action::OpenApp { app } = action {
            self.rfb
                .as_mut()
                .ok_or_else(|| Error::new("computer_use_unavailable", "VM not ready"))?
                .action(&Action::PressKey {
                    key: "escape".into(),
                    modifiers: vec![],
                })?;
            self.call(
                &[
                    "exec",
                    VM,
                    "/usr/bin/sudo",
                    "/bin/launchctl",
                    "asuser",
                    "501",
                    "/usr/bin/open",
                    "-a",
                    app,
                ],
                vec![],
                30,
            )?;
            thread::sleep(Duration::from_millis(1500));
        } else {
            self.rfb
                .as_mut()
                .ok_or_else(|| Error::new("computer_use_unavailable", "VM not ready"))?
                .action(action)?;
        }
        self.observed = None;
        thread::sleep(Duration::from_millis(300));
        self.screenshot()
    }
    /// Fixed fixture operations for the local benchmark, not an exposed agent tool.
    pub(crate) fn benchmark_document(&mut self, reset: bool) -> Result<String> {
        self.assert_no_host_listener()?;
        if reset {
            let new_document = self.fixture.is_none();
            let path = self
                .fixture
                .clone()
                .unwrap_or_else(|| format!("/tmp/gdm-benchmark-{}.txt", uuid::Uuid::new_v4()));
            if new_document {
                self.call(
                    &["exec", "-i", VM, "/usr/bin/tee", &path],
                    b"REPLACE ME".to_vec(),
                    10,
                )?;
                self.fixture_files.push(path.clone());
            }
            self.call(
                &[
                    "exec",
                    VM,
                    "/usr/bin/open",
                    "-a",
                    "/System/Applications/TextEdit.app",
                    &path,
                ],
                vec![],
                10,
            )?;
            self.fixture = Some(path);
            self.observed = None;
            thread::sleep(Duration::from_secs(2));
            if new_document {
                self.rfb
                    .as_mut()
                    .ok_or_else(|| Error::new("benchmark_fixture", "VM not ready"))?
                    .action(&Action::PressKey {
                        key: "f".into(),
                        modifiers: vec!["ctrl".into(), "cmd".into()],
                    })?;
                thread::sleep(Duration::from_secs(2));
            }
            // A full-screen, selected-text fixture avoids clocks, Dock animation and
            // caret blinking without relaxing the production freshness check.
            let screen = self.screenshot()?;
            let rfb = self
                .rfb
                .as_mut()
                .ok_or_else(|| Error::new("benchmark_fixture", "VM not ready"))?;
            rfb.action(&Action::Click {
                x: screen.width / 2,
                y: screen.height / 2,
                button: super::action::Button::Left,
                click_count: 1,
            })?;
            let select_all = Action::PressKey {
                key: "a".into(),
                modifiers: vec!["cmd".into()],
            };
            rfb.action(&select_all)?;
            rfb.action(&Action::TypeText {
                text: "REPLACE ME".into(),
            })?;
            rfb.action(&select_all)?;
            thread::sleep(Duration::from_secs(2));
            Ok(String::new())
        } else {
            let path = self
                .fixture
                .clone()
                .ok_or_else(|| Error::new("benchmark_fixture", "fixture document not created"))?;
            self.rfb
                .as_mut()
                .ok_or_else(|| Error::new("benchmark_fixture", "VM not ready"))?
                .action(&Action::PressKey {
                    key: "s".into(),
                    modifiers: vec!["cmd".into()],
                })?;
            thread::sleep(Duration::from_millis(500));
            let bytes = self.call(&["exec", VM, "/bin/cat", &path], vec![], 10)?;
            String::from_utf8(bytes)
                .map_err(|_| Error::new("benchmark_fixture", "guest returned invalid UTF-8"))
        }
    }

    /// Private benchmark fixture transport. All paths are freshly generated here;
    /// no model-proposed shell commands or host desktop operations are accepted.
    pub(super) fn reuse_prepare(
        &mut self,
        binary: &[u8],
        run_id: &str,
    ) -> Result<super::reuse::FormState> {
        self.assert_no_host_listener()?;
        uuid::Uuid::parse_str(run_id)
            .map_err(|_| Error::new("benchmark_fixture", "invalid run ID"))?;
        let first = self.reuse_base.is_none();
        let base = self
            .reuse_base
            .clone()
            .unwrap_or_else(|| format!("/tmp/gdm-reuse-{}", uuid::Uuid::new_v4()));
        if first {
            self.reuse_base = Some(base.clone());
            self.fixture_files.extend(
                [
                    "bin",
                    "command",
                    "reset",
                    "reset-pending",
                    "state",
                    "pending",
                ]
                .map(|ext| format!("{base}.{ext}")),
            );
            let path = format!("{base}.bin");
            self.call(
                &[
                    "exec",
                    "-i",
                    VM,
                    "/bin/sh",
                    "-c",
                    "cat > \"$1\" && chmod 700 \"$1\"",
                    "gdm-fixture",
                    &path,
                ],
                binary.to_vec(),
                20,
            )?;
            let script = format!("#!/bin/sh\nexec {base}.bin {base}\n");
            self.call(
                &[
                    "exec",
                    "-i",
                    VM,
                    "/bin/sh",
                    "-c",
                    "cat > \"$1\" && chmod 700 \"$1\"",
                    "gdm-fixture",
                    &format!("{base}.command"),
                ],
                script.into_bytes(),
                10,
            )?;
        }
        self.call(
            &[
                "exec",
                "-i",
                VM,
                "/bin/sh",
                "-c",
                "cat > \"$1\" && mv \"$1\" \"$2\"",
                "gdm-fixture",
                &format!("{base}.reset-pending"),
                &format!("{base}.reset"),
            ],
            run_id.as_bytes().to_vec(),
            10,
        )?;
        if first {
            self.call(
                &[
                    "exec",
                    VM,
                    "/usr/bin/open",
                    "-n",
                    "-a",
                    "Terminal",
                    &format!("{base}.command"),
                    "--args",
                    "-ApplePersistenceIgnoreState",
                    "YES",
                    "-ShowActivityIndicatorInTab",
                    "NO",
                ],
                vec![],
                15,
            )?;
            thread::sleep(Duration::from_secs(3));
            self.screenshot()?;
            self.action(&Action::PressKey {
                key: "f".into(),
                modifiers: vec!["ctrl".into(), "cmd".into()],
            })?;
            // Terminal updates its initial activity marker asynchronously. Keep
            // process-local UI preferences and launch settling outside all arms.
            // Never mask pixels or relax the execution-time freshness check.
            thread::sleep(Duration::from_secs(12));
            self.reuse_terminal_pid = Some(self.reuse_front_pid()?);
        } else {
            // Reset through the visible TUI input path. Out-of-band file changes
            // can leave Terminal displaying the previous completed form.
            self.reuse_state()?;
            self.action(&Action::TypeText {
                text: format!("__GDM_RESET_{run_id}\n"),
            })?;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(state) = self.reuse_state()
                && state.run_id == run_id
                && state.stage == 0
            {
                thread::sleep(Duration::from_millis(400));
                return Ok(state);
            }
            if Instant::now() > deadline {
                return Err(Error::new(
                    "benchmark_fixture",
                    "owned form did not become ready",
                ));
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    pub(super) fn reuse_state(&mut self) -> Result<super::reuse::FormState> {
        self.assert_no_host_listener()?;
        let front_pid = self.reuse_front_pid()?;
        if self.reuse_terminal_pid != Some(front_pid) {
            return Err(Error::new(
                "reuse_target",
                "owned Terminal is not frontmost",
            ));
        }
        let base = self
            .reuse_base
            .as_ref()
            .ok_or_else(|| Error::new("benchmark_fixture", "form not prepared"))?;
        let path = format!("{base}.state");
        let bytes = self.call(&["exec", VM, "/bin/cat", &path], vec![], 10)?;
        let state: super::reuse::FormState = serde_json::from_slice(&bytes)?;
        state.validate()?;
        Ok(state)
    }
    /// A fixture-owned visual marker binds the actual framebuffer to its state.
    /// Two equal full frames avoid exposing an intermediate redraw to the model.
    pub(super) fn reuse_screen(&mut self, state: &super::reuse::FormState) -> Result<Frame> {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut previous = None;
        loop {
            let frame = self.screenshot()?;
            let fingerprint = frame.fingerprint();
            if state.screen_matches(&frame) {
                if previous.as_ref() == Some(&fingerprint) {
                    return Ok(frame);
                }
                previous = Some(fingerprint);
            } else {
                previous = None;
            }
            if Instant::now() > deadline {
                return Err(Error::new(
                    "reuse_visual_sync",
                    "current form state is not visible; no model call or input permitted",
                ));
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    fn reuse_front_pid(&mut self) -> Result<u64> {
        // AppKit reads the frontmost process. No Apple Events or AX permissions.
        let script = "ObjC.import('AppKit'); const a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({bundle:ObjC.unwrap(a.bundleIdentifier),pid:Number(a.processIdentifier)})";
        let bytes = self.call(
            &[
                "exec",
                VM,
                "/usr/bin/osascript",
                "-l",
                "JavaScript",
                "-e",
                script,
            ],
            vec![],
            10,
        )?;
        let value: Value = serde_json::from_slice(&bytes)?;
        if value["bundle"] != "com.apple.Terminal" {
            return Err(Error::new("reuse_target", "test Terminal is not frontmost"));
        }
        value["pid"]
            .as_u64()
            .filter(|p| *p > 0)
            .ok_or_else(|| Error::new("reuse_target", "missing Terminal process identity"))
    }
    pub fn stop(&mut self) {
        let files = std::mem::take(&mut self.fixture_files);
        if !files.is_empty() && self.run.is_some() {
            let mut args = vec!["exec", VM, "/bin/rm", "-f"];
            args.extend(files.iter().map(String::as_str));
            if let Ok(command) = self.command(&args) {
                let _ = capture_cleanup(command, vec![], Duration::from_secs(10), 65536);
            }
        }
        self.boundary = None;
        self.fixture = None;
        self.reuse_base = None;
        self.reuse_terminal_pid = None;
        if let Some(mut r) = self.rfb.take() {
            r.release_all();
        }
        self.tunnel = None;
        self.run = None;
        self.observed = None;
        self.state = "stopped".into();
    }
    fn assert_no_host_listener(&mut self) -> Result<()> {
        if let Some(boundary) = &self.boundary {
            boundary.check()?;
        }
        Ok(())
    }
}
impl Drop for TartVm {
    fn drop(&mut self) {
        self.stop();
    }
}
pub(crate) fn clean_env(c: &mut Command) {
    let home = std::env::var_os("HOME");
    let tmp = std::env::var_os("TMPDIR");
    c.env_clear()
        .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "en_US.UTF-8");
    if let Some(home) = home {
        c.env("HOME", home);
    }
    if let Some(tmp) = tmp {
        c.env("TMPDIR", tmp);
    }
}
