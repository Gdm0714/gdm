//! Explicit provisioning for the pinned guest image. Never changes host privilege or installs packages.
use super::{
    boundary::Boundary,
    process::{Owned, capture},
    vm,
};
use crate::support::{Error, Result, print_json};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
const TART: &str = "/opt/homebrew/bin/tart";
const SOFTNET: &str = "/opt/homebrew/bin/softnet";
const VERSION: &str = "2.36.0";
const IMAGE: &str = "ghcr.io/cirruslabs/macos-tahoe-base@sha256:e1863fead81cb8cf98350bc96275b7ff528119c527d16fd98cc8d5be3d9c927a";
const MIN_FREE_BYTES: u64 = 60 * 1024 * 1024 * 1024;
const MARKER: &str = "gdm-computer-use-vsock-v1";
const MARKER_PATH: &str = "/var/db/gdm-computer-use-vsock";
const KICKSTART: &str =
    "/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart";
fn err(message: impl Into<String>) -> Error {
    Error::new("computer_use_setup", message)
}
fn digest(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(err("pinned tool is not a regular file"));
    }
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
struct Toolchain {
    tart: PathBuf,
    binary: PathBuf,
    softnet: PathBuf,
}
impl Toolchain {
    fn inspect() -> Result<Self> {
        if !cfg!(target_os = "macos") {
            return Err(err(
                "Computer Use setup requires macOS on an Apple Silicon host",
            ));
        }
        if std::env::var_os("GDM_TART_PATH").is_some_and(|p| Path::new(&p) != Path::new(TART)) {
            return Err(err(
                "setup accepts only the pinned /opt/homebrew/bin/tart toolchain; unset GDM_TART_PATH",
            ));
        }
        let tart=fs::canonicalize(TART).map_err(|_|err("Audited Tart is missing. Review and run `/opt/homebrew/bin/brew install openai/tools/tart` in your terminal, then rerun setup. GDM never installs host packages automatically."))?;
        let binary = tart
            .parent()
            .ok_or_else(|| err("invalid Tart launcher path"))?
            .join("../libexec/tart.app/Contents/MacOS/tart")
            .canonicalize()
            .map_err(|_| err("audited Tart binary is missing"))?;
        let softnet = fs::canonicalize(SOFTNET).map_err(|_| {
            err("Tart's Softnet dependency is missing at /opt/homebrew/bin/softnet")
        })?;
        let tools = Self {
            tart,
            binary,
            softnet,
        };
        tools.verify()?;
        let metadata = fs::metadata(&tools.softnet)?;
        if metadata.uid() != 0 || metadata.permissions().mode() & 0o4000 == 0 {
            return Err(Error::new(
                "runner_exit_77",
                format!(
                    "Softnet requires its documented one-time root ownership and SUID setup. Review the pinned binary, then run these commands in your own terminal:\n  sudo chown root:wheel '{}'\n  sudo chmod 4755 '{}'\nRe-run setup afterward. No passwordless sudo rule is required.",
                    tools.softnet.display(),
                    tools.softnet.display()
                ),
            ));
        }
        let version = tools.call(&["--version"], vec![], Duration::from_secs(10), 4096)?;
        if String::from_utf8_lossy(&version).trim() != VERSION {
            return Err(err("Tart 2.36.0 is required"));
        }
        Ok(tools)
    }
    fn verify(&self) -> Result<()> {
        for (path, expected, label) in [
            (&self.tart, vm::TART_SHA, "Tart launcher"),
            (&self.binary, vm::BINARY_SHA, "Tart binary"),
            (&self.softnet, vm::SOFTNET_SHA, "Softnet"),
        ] {
            let stat = fs::metadata(path)?;
            if !stat.is_file()
                || stat.permissions().mode() & 0o111 == 0
                || digest(path)? != expected
            {
                return Err(err(format!(
                    "{label} differs from the pinned audited build"
                )));
            }
        }
        Ok(())
    }
    fn command(&self, args: &[&str]) -> Result<Command> {
        self.verify()?;
        let mut c = Command::new(&self.tart);
        c.args(args);
        vm::clean_env(&mut c);
        Ok(c)
    }
    fn call(
        &self,
        args: &[&str],
        input: Vec<u8>,
        timeout: Duration,
        limit: usize,
    ) -> Result<Vec<u8>> {
        let output = capture(self.command(args)?, input, timeout, limit)?;
        if output.code != 0 {
            return Err(err(format!(
                "Tart {} failed with exit {}",
                args.first().copied().unwrap_or("command"),
                output.code
            )));
        }
        Ok(output.stdout)
    }
    fn list(&self) -> Result<Vec<Value>> {
        let data = self.call(
            &["list", "--source", "local", "--format", "json"],
            vec![],
            Duration::from_secs(10),
            1024 * 1024,
        )?;
        let rows: Value = serde_json::from_slice(&data)
            .map_err(|_| err("Tart returned malformed VM inventory"))?;
        let rows = rows
            .as_array()
            .ok_or_else(|| err("Tart VM inventory must be an array"))?;
        for row in rows {
            if !row.is_object() || !row["Name"].is_string() || !row["Running"].is_boolean() {
                return Err(err("Tart VM inventory has an invalid record"));
            }
        }
        Ok(rows.clone())
    }
    fn guest(&self, args: &[&str], input: Vec<u8>, interactive: bool) -> Result<Vec<u8>> {
        let mut argv = vec!["exec"];
        if interactive {
            argv.push("-i");
        }
        argv.push(vm::VM);
        argv.extend_from_slice(args);
        self.call(&argv, input, Duration::from_secs(30), 65536)
    }
}
fn existing_vm(rows: &[Value]) -> Result<bool> {
    let matches = rows
        .iter()
        .filter(|row| row["Name"] == vm::VM)
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Err(err("ambiguous Computer Use VM inventory"));
    }
    if matches.first().is_some_and(|r| r["Running"] == true) {
        return Err(err(
            "Refusing to provision a Computer Use VM already running under another process",
        ));
    }
    Ok(!matches.is_empty())
}
fn disk_space() -> Result<u64> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| err("HOME is required for the VM disk-space check"))?;
    let stat = nix::sys::statvfs::statvfs(Path::new(&home))
        .map_err(|_| err("Could not determine free disk space"))?;
    Ok((stat.blocks_available() as u64).saturating_mul(stat.fragment_size() as u64))
}
fn sleep_cancelled(duration: Duration) -> Result<()> {
    let until = Instant::now() + duration;
    while Instant::now() < until {
        if super::cancelled() {
            return Err(Error::new("cancelled", "Computer Use setup cancelled"));
        }
        thread::sleep(
            Duration::from_millis(50).min(until.saturating_duration_since(Instant::now())),
        );
    }
    Ok(())
}
fn provisioning_commands() -> Vec<Vec<&'static str>> {
    vec![
        vec![
            "/usr/bin/sudo",
            KICKSTART,
            "-activate",
            "-configure",
            "-access",
            "-on",
            "-users",
            "admin",
            "-privs",
            "-all",
            "-clientopts",
            "-setvnclegacy",
            "-vnclegacy",
            "yes",
            "-setvncpw",
            "-vncpw",
            "gdmsetup",
            "-restart",
            "-agent",
        ],
        vec![
            "/usr/bin/sudo",
            "/bin/launchctl",
            "enable",
            "system/com.apple.screensharing",
        ],
        vec![
            "/usr/bin/sudo",
            "/bin/launchctl",
            "kickstart",
            "-k",
            "system/com.apple.screensharing",
        ],
        vec![
            "/usr/bin/defaults",
            "write",
            "NSGlobalDomain",
            "AppleKeyboardUIMode",
            "-int",
            "3",
        ],
    ]
}
/// No host changes occur unless this explicit setup command is invoked. `--check` is read-only.
pub fn run(args: &[String]) -> Result<()> {
    if args == ["--help"] || args == ["-h"] {
        println!(
            "usage: gdm computer-use setup [--check]\nPrepare the pinned gdm-cu-vm guest. --check only validates host prerequisites and VM ownership.\nRequires the audited Tart 2.36.0/Softnet binaries and at least 60 GiB available disk.\nHost package installation and root ownership/SUID changes must be reviewed and performed manually."
        );
        return Ok(());
    }
    let check = args == ["--check"];
    if !args.is_empty() && !check {
        return Err(Error::new(
            "usage",
            "computer-use setup accepts only --check or --help",
        ));
    }
    super::signals()?;
    let tools = Toolchain::inspect()?;
    let free = disk_space()?;
    if free < MIN_FREE_BYTES {
        return Err(err(
            "At least 60 GiB free disk is required for the isolated macOS VM",
        ));
    }
    let exists = existing_vm(&tools.list()?)?;
    if check {
        return print_json(
            &json!({"schemaVersion":"gdm-computer-use-setup/v1","readyForSetup":true,"vmName":vm::VM,"vmExists":exists,"image":IMAGE,"tartVersion":VERSION,"availableBytes":free,"minimumBytes":MIN_FREE_BYTES,"hostChangesPerformed":false}),
        );
    }
    if !exists {
        let mut pulled = false;
        for attempt in 1..=3 {
            if tools
                .call(
                    &["clone", "--concurrency", "1", IMAGE, vm::VM],
                    vec![],
                    Duration::from_secs(1800),
                    4 * 1024 * 1024,
                )
                .is_ok()
            {
                pulled = true;
                break;
            }
            if super::cancelled() {
                return Err(Error::new("cancelled", "Computer Use setup cancelled"));
            }
            if attempt < 3 {
                eprintln!(
                    "Image pull interrupted; retrying cached layers in 30 seconds ({attempt}/3)"
                );
                sleep_cancelled(Duration::from_secs(30))?;
            }
        }
        if !pulled {
            return Err(err(
                "Failed to pull the pinned macOS image after 3 attempts",
            ));
        }
    }
    // Recheck ownership before configuring and starting; never attach to an existing owner's VM.
    existing_vm(&tools.list()?)?;
    tools.call(
        &[
            "set",
            vm::VM,
            "--cpu",
            "4",
            "--memory",
            "4096",
            "--display",
            "1280x800",
        ],
        vec![],
        Duration::from_secs(30),
        65536,
    )?;
    existing_vm(&tools.list()?)?;
    let mut command = tools.command(&[
        "run",
        vm::VM,
        "--no-graphics",
        "--no-clipboard",
        "--net-softnet",
        "--net-softnet-block=0.0.0.0/0",
    ])?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut owned = Owned::spawn(&mut command)?;
    let boundary = Boundary::new();
    boundary.add(owned.child.id())?;
    let result = (|| -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            boundary.check()?;
            if owned.exit_code()?.is_some() {
                return Err(err("Tart exited before its Guest Agent became ready"));
            }
            if tools.guest(&["/usr/bin/true"], vec![], false).is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                return Err(err("Tart Guest Agent did not become ready"));
            }
            sleep_cancelled(Duration::from_secs(2))?;
        }
        for args in provisioning_commands() {
            boundary.check()?;
            tools.guest(&args, vec![], false)?;
        }
        tools.guest(
            &["/usr/bin/sudo", "/usr/bin/tee", MARKER_PATH],
            format!("{MARKER}\n").into_bytes(),
            true,
        )?;
        tools.guest(
            &["/usr/bin/sudo", "/bin/chmod", "644", MARKER_PATH],
            vec![],
            false,
        )?;
        let marker = tools.guest(&["/bin/cat", MARKER_PATH], vec![], false)?;
        if marker != MARKER.as_bytes() && marker != format!("{MARKER}\n").as_bytes() {
            return Err(err("Guest identity marker readback failed"));
        }
        tools.guest(&["/bin/sync"], vec![], false)?;
        sleep_cancelled(Duration::from_secs(1))?;
        boundary.check()?;
        tools.verify()?;
        Ok(())
    })();
    drop(boundary);
    owned.stop();
    result?;
    println!(
        "Computer Use VM ready: {} ({VERSION}, guest loopback RFB over Agent stdio)",
        vm::VM
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn running_and_ambiguous_inventory_is_never_provisioned() {
        assert!(existing_vm(&[json!({"Name":vm::VM,"Running":true})]).is_err());
        assert!(
            existing_vm(&[
                json!({"Name":vm::VM,"Running":false}),
                json!({"Name":vm::VM,"Running":false})
            ])
            .is_err()
        );
        assert!(!existing_vm(&[]).unwrap());
        assert!(existing_vm(&[json!({"Name":vm::VM,"Running":false})]).unwrap());
    }
    #[test]
    fn image_is_digest_pinned_and_privileged_commands_are_guest_arguments() {
        assert!(IMAGE.contains("@sha256:"));
        assert_eq!(IMAGE.rsplit(':').next().unwrap().len(), 64);
        for argv in provisioning_commands() {
            assert!(argv[0].starts_with("/usr/bin/"));
            assert!(
                !argv
                    .iter()
                    .any(|a| a.contains("brew") || a.contains("chown") || a.contains("4755"))
            );
        }
        assert_eq!(vm::VM, "gdm-cu-vm");
    }
}
