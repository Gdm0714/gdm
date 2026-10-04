use super::config::*;
use crate::{
    computer_use::process::Owned,
    support::{Error, Result},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Debug)]
pub struct Options {
    pub action: String,
    pub config: String,
    pub case_name: Option<String>,
    pub json: bool,
}
impl Options {
    pub fn parse(args: &[String]) -> Result<Self> {
        let action = args.first().map(String::as_str).unwrap_or("");
        if !["list", "doctor", "build", "install", "test", "capture"].contains(&action) {
            return Err(err("usage", super::USAGE));
        }
        let mut o = Self {
            action: action.into(),
            config: ".gdm-device.json".into(),
            case_name: None,
            json: false,
        };
        let mut seen = std::collections::HashSet::new();
        let mut it = args[1..].iter();
        while let Some(flag) = it.next() {
            if !seen.insert(flag) {
                return Err(err("usage", "중복 인자"));
            }
            match flag.as_str() {
                "--json" => o.json = true,
                "--config" if action != "list" => o.config = argument(&mut it)?,
                "--case" if action == "capture" => o.case_name = Some(argument(&mut it)?),
                _ => return Err(err("usage", "지원하지 않는 인자")),
            }
        }
        Ok(o)
    }
}
fn argument(it: &mut std::slice::Iter<'_, String>) -> Result<String> {
    it.next()
        .filter(|s| !s.is_empty() && !s.starts_with('-'))
        .cloned()
        .ok_or_else(|| err("usage", "인자 값이 필요합니다"))
}
pub struct DeviceCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
    pub timeout: Duration,
    pub cleanup: bool,
}
pub struct CommandResult {
    pub exit_code: i32,
    pub timed_out: bool,
}
pub trait Runner {
    fn run(&mut self, c: &DeviceCommand) -> Result<CommandResult>;
    fn cancelled(&self) -> bool {
        false
    }
    fn sleep(&mut self, d: Duration) {
        std::thread::sleep(d);
    }
}
pub struct ProcessRunner;
impl Runner for ProcessRunner {
    fn cancelled(&self) -> bool {
        crate::computer_use::cancelled()
    }
    fn run(&mut self, c: &DeviceCommand) -> Result<CommandResult> {
        if !c.cleanup && self.cancelled() {
            return Ok(CommandResult {
                exit_code: 130,
                timed_out: false,
            });
        }
        let out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&c.stdout)?;
        let error = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&c.stderr)?;
        let mut cmd = Command::new(&c.executable);
        cmd.args(&c.args)
            .current_dir(&c.cwd)
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(error);
        let mut child = Owned::spawn(&mut cmd)?;
        let start = Instant::now();
        loop {
            let timed_out = start.elapsed() > c.timeout;
            if timed_out || (!c.cleanup && self.cancelled()) {
                child.stop();
                return Ok(CommandResult {
                    exit_code: 130,
                    timed_out,
                });
            }
            // Bound on-disk logs as well as runtime; never buffer an xcodebuild log in memory.
            if [&c.stdout, &c.stderr]
                .iter()
                .any(|p| fs::metadata(p).is_ok_and(|m| m.len() > 64 * 1024 * 1024))
            {
                child.stop();
                return Err(err("device_output_limit", "실기기 로그 크기 상한 초과"));
            }
            if let Some(code) = child.exit_code()? {
                child.stop();
                return Ok(CommandResult {
                    exit_code: code,
                    timed_out: false,
                });
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
fn mkdir(p: &Path, recursive: bool) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(recursive)
        .mode(0o700)
        .create(p)?;
    Ok(())
}
fn write_new(p: &Path, data: &[u8]) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(p)?
        .write_all(data)?;
    Ok(())
}
fn read_json(p: &Path) -> Result<Value> {
    serde_json::from_slice(&small(p, 4 * 1024 * 1024)?)
        .map_err(|_| err("device_invalid", "증거 JSON 오류"))
}
fn error_value(e: &Error) -> Value {
    json!({"code":e.code,"message":e.message})
}
struct Run<'a> {
    cwd: PathBuf,
    dir: PathBuf,
    receipt: Value,
    runner: &'a mut dyn Runner,
}
impl Run<'_> {
    fn check(&self) -> Result<()> {
        if self.runner.cancelled() {
            Err(err("device_cancelled", "실기기 작업을 중단했습니다"))
        } else {
            Ok(())
        }
    }
    fn step(
        &mut self,
        name: &str,
        exe: &str,
        args: Vec<String>,
        timeout: u64,
        cleanup: bool,
    ) -> Result<PathBuf> {
        if !cleanup {
            self.check()?;
        }
        let n = self.receipt["steps"].as_array().expect("steps").len() + 1;
        let prefix = self.dir.join(format!("{n:02}-{name}"));
        let out = prefix.with_extension("stdout");
        let stderr = prefix.with_extension("stderr");
        self.receipt["steps"].as_array_mut().expect("steps").push(json!({"name":name,"executable":exe,"args":args,"exitCode":null,"stdout":out,"stderr":stderr}));
        let result = self.runner.run(&DeviceCommand {
            executable: exe.into(),
            args,
            cwd: self.cwd.clone(),
            stdout: out.clone(),
            stderr: stderr.clone(),
            timeout: Duration::from_secs(timeout),
            cleanup,
        })?;
        self.receipt["steps"][n - 1]["exitCode"] = json!(result.exit_code);
        self.receipt["steps"][n - 1]["timedOut"] = json!(result.timed_out);
        if result.exit_code != 0 || result.timed_out {
            return Err(Error::new(
                if result.timed_out {
                    "device_timeout"
                } else {
                    "device_command_failed"
                },
                format!("{name} 실패. 로그: {}", stderr.display()),
            ));
        }
        Ok(out)
    }
    fn ctl(&mut self, name: &str, args: Vec<String>, cleanup: bool) -> Result<Value> {
        let path = self.dir.join(format!(
            "{}-{name}.json",
            self.receipt["steps"].as_array().expect("steps").len() + 1
        ));
        let mut argv = vec![
            "devicectl".into(),
            "--timeout".into(),
            "20".into(),
            "--json-output".into(),
            path.to_string_lossy().into(),
            "--quiet".into(),
        ];
        argv.extend(args);
        self.step(name, "xcrun", argv, 25, cleanup)?;
        let value = read_json(&path)?;
        if value["info"]["outcome"] != "success" {
            return Err(err("device_invalid", "devicectl 성공 결과 없음"));
        }
        Ok(value)
    }
}
fn strings(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| (*s).into()).collect()
}
pub fn execute(
    cwd: &Path,
    o: &Options,
    runner: &mut dyn Runner,
    lock_root: Option<&Path>,
) -> Result<Value> {
    let cwd = fs::canonicalize(cwd)?;
    let config = if o.action == "list" {
        None
    } else {
        Some(parse_config(
            serde_json::from_slice(&small(&cwd.join(&o.config), 128 * 1024)?)
                .map_err(|_| err("device_invalid", "실기기 설정 JSON 오류"))?,
            &cwd,
        )?)
    };
    let case = config
        .as_ref()
        .and_then(|c| c.capture.as_ref())
        .and_then(|c| {
            c.cases.iter().find(|v| {
                Some(v.name.as_str())
                    == o.case_name
                        .as_deref()
                        .or_else(|| c.cases.first().map(|c| c.name.as_str()))
            })
        })
        .cloned();
    if o.action == "capture" && case.is_none() {
        return Err(err("device_invalid", "등록된 격리 캡처 장면이 필요합니다"));
    }
    if o.action == "test" && config.as_ref().is_none_or(|c| c.test_targets.is_empty()) {
        return Err(err("device_invalid", "격리 testTargets가 필요합니다"));
    }
    let root = contained(&cwd, ".gdm-artifacts/device")?;
    mkdir(&root, true)?;
    let id = uuid::Uuid::new_v4().to_string();
    let dir = root.join(&id);
    mkdir(&dir, false)?;
    let receipt_path = dir.join("receipt.json");
    let mut r = Run {
        cwd: cwd.clone(),
        dir,
        runner,
        receipt: json!({"schemaVersion":"gdm-device-receipt/v1","action":o.action,"runID":id,"startedAt":chrono::Utc::now().to_rfc3339(),"success":false,"receiptPath":receipt_path,"steps":[]}),
    };
    if let Some(c) = &config {
        r.receipt["device"] = json!(c.device);
        r.receipt["bundleID"] = json!(c.bundle_id);
        r.receipt["configSHA256"] = json!(hex::encode(Sha256::digest(serde_json::to_vec(c)?)));
    }
    let mut lock = None;
    let mut restore = false;
    let outcome = (|| -> Result<()> {
        if let Some(c) = &config {
            let default =
                std::env::temp_dir().join(format!("gdm-device-{}", nix::unistd::getuid()));
            let root = lock_root.unwrap_or(&default);
            if !root.exists() {
                mkdir(root, false)?;
            }
            let m = fs::symlink_metadata(root)?;
            if !m.is_dir()
                || m.file_type().is_symlink()
                || m.uid() != nix::unistd::getuid().as_raw()
            {
                return Err(err("device_invalid", "실기기 잠금 폴더 소유자 오류"));
            }
            let path = root.join(c.device.id.to_lowercase());
            mkdir(&path, false).map_err(|_| {
                Error::new(
                    "device_busy",
                    format!("실기기 잠금이 남아 있습니다: {}", path.display()),
                )
            })?;
            lock = Some(path.clone());
            write_new(
                &path.join("owner.json"),
                &serde_json::to_vec(
                    &json!({"pid":std::process::id(),"cwd":cwd,"runID":id,"receiptPath":receipt_path}),
                )?,
            )?;
            inspect_device(
                &r.ctl(
                    "details",
                    strings(&["device", "info", "details", "--device", &c.device.id]),
                    false,
                )?,
                c,
            )?;
            inspect_unlocked(
                &r.ctl(
                    "lock-state",
                    strings(&["device", "info", "lockState", "--device", &c.device.id]),
                    false,
                )?,
                c,
            )?;
        }
        if o.action == "list" {
            let value = r.ctl("list", strings(&["list", "devices"]), false)?;
            let rows = value["result"]["devices"]
                .as_array()
                .ok_or_else(|| err("device_invalid", "기기 목록 JSON 오류"))?;
            r.receipt["devices"]=json!(rows.iter().map(|d|json!({"id":d["identifier"],"udid":d["hardwareProperties"]["udid"],"name":d["deviceProperties"]["name"],"platform":d["hardwareProperties"]["platform"],"reality":d["hardwareProperties"]["reality"],"connection":d["connectionProperties"]["tunnelState"]})).collect::<Vec<_>>());
        } else {
            let c = config.as_ref().expect("config validated");
            match o.action.as_str() {
                "build" | "test" => {
                    let project = contained(&cwd, &c.project)?;
                    let derived = contained(&cwd, &c.derived_data_path)?;
                    let mut a = strings(&[
                        "-n",
                        "10",
                        "xcodebuild",
                        &o.action,
                        "-project",
                        &project.to_string_lossy(),
                        "-scheme",
                        &c.scheme,
                        "-configuration",
                        "Debug",
                        "-destination",
                        &format!("platform=iOS,id={}", c.device.udid),
                        "-derivedDataPath",
                        &derived.to_string_lossy(),
                        "-jobs",
                        "2",
                        "-allowProvisioningUpdates",
                    ]);
                    if o.action == "test" {
                        restore = true;
                        let bundle = r.dir.join("Tests.xcresult");
                        a.extend(strings(&[
                            "-parallel-testing-enabled",
                            "NO",
                            "-resultBundlePath",
                            &bundle.to_string_lossy(),
                        ]));
                        a.extend(c.test_targets.iter().map(|t| format!("-only-testing:{t}")));
                        r.step("xctest", "nice", a, 1200, false)?;
                        let path = r.step(
                            "test-summary",
                            "xcrun",
                            strings(&[
                                "xcresulttool",
                                "get",
                                "test-results",
                                "summary",
                                "--path",
                                &bundle.to_string_lossy(),
                                "--compact",
                            ]),
                            30,
                            false,
                        )?;
                        let summary = read_json(&path)?;
                        inspect_summary(&summary, c)?;
                        r.receipt["testSummary"] = json!({"path":path,"total":summary["totalTestCount"],"passed":summary["passedTests"]});
                    } else {
                        r.step("build", "nice", a, 1200, false)?;
                    }
                }
                "install" => {
                    let app = contained(&cwd, &c.app_path)?;
                    if !fs::symlink_metadata(&app)?.is_dir() {
                        return Err(err("device_invalid", ".app 폴더가 없습니다"));
                    }
                    let path = r.step(
                        "bundle-id",
                        "/usr/libexec/PlistBuddy",
                        strings(&[
                            "-c",
                            "Print :CFBundleIdentifier",
                            &app.join("Info.plist").to_string_lossy(),
                        ]),
                        30,
                        false,
                    )?;
                    if String::from_utf8_lossy(&small(&path, 4 * 1024 * 1024)?).trim()
                        != c.bundle_id
                    {
                        return Err(err("device_mismatch", "설치 앱 bundleID 불일치"));
                    }
                    r.step(
                        "codesign",
                        "codesign",
                        strings(&["--verify", "--deep", "--strict", &app.to_string_lossy()]),
                        30,
                        false,
                    )?;
                    r.ctl(
                        "install",
                        strings(&[
                            "device",
                            "install",
                            "app",
                            "--device",
                            &c.device.id,
                            &app.to_string_lossy(),
                        ]),
                        false,
                    )?;
                }
                "capture" => {
                    let case = case.as_ref().expect("case validated");
                    let filename = format!("gdm-{id}.png");
                    restore = true;
                    let mut a = strings(&[
                        "device",
                        "process",
                        "launch",
                        "--device",
                        &c.device.id,
                        "--terminate-existing",
                        &c.bundle_id,
                        "--",
                        &c.capture.as_ref().expect("capture").isolation_argument,
                        &filename,
                    ]);
                    a.extend(case.arguments.clone());
                    r.ctl("capture-launch", a, false)?;
                    let mut path = None;
                    for n in 1..=8 {
                        r.check()?;
                        r.runner.sleep(Duration::from_secs(1));
                        let p = r.dir.join(format!("capture-{n}.png"));
                        match r.ctl(
                            &format!("capture-copy-{n}"),
                            strings(&[
                                "device",
                                "copy",
                                "from",
                                "--device",
                                &c.device.id,
                                "--domain-type",
                                "appDataContainer",
                                "--domain-identifier",
                                &c.bundle_id,
                                "--source",
                                &format!("Documents/{filename}"),
                                "--destination",
                                &p.to_string_lossy(),
                            ]),
                            false,
                        ) {
                            Ok(_) => {
                                path = Some(p);
                                break;
                            }
                            Err(e) => {
                                if n == 8 || r.runner.cancelled() {
                                    return Err(e);
                                }
                            }
                        }
                    }
                    let path =
                        path.ok_or_else(|| err("device_capture_invalid", "새 캡처가 없습니다"))?;
                    let bytes = small(&path, 30 * 1024 * 1024)?;
                    let (width, height) = inspect_png(&bytes)?;
                    r.receipt["capture"] = json!({"path":path,"sha256":hex::encode(Sha256::digest(bytes)),"width":width,"height":height,"case":case.name});
                }
                "doctor" => {}
                _ => return Err(err("usage", super::USAGE)),
            }
        }
        r.check()?;
        Ok(())
    })();
    match outcome {
        Ok(()) => r.receipt["success"] = json!(true),
        Err(e) => r.receipt["error"] = error_value(&e),
    }
    if restore && let Some(c) = &config {
        match r.ctl(
            "restore-app",
            strings(&[
                "device",
                "process",
                "launch",
                "--device",
                &c.device.id,
                "--terminate-existing",
                &c.bundle_id,
            ]),
            true,
        ) {
            Ok(_) => r.receipt["restore"] = json!({"success":true}),
            Err(e) => {
                r.receipt["restore"] = json!({"success":false,"error":e.message});
                r.receipt["success"] = json!(false);
                if r.receipt.get("error").is_none() {
                    r.receipt["error"] =
                        error_value(&err("device_restore_failed", "앱 정상 실행 복원 실패"));
                }
            }
        }
    }
    r.receipt["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
    let saved = write_new(&receipt_path, &serde_json::to_vec_pretty(&r.receipt)?);
    if let Some(path) = lock {
        fs::remove_dir_all(path)?;
    }
    saved?;
    Ok(r.receipt)
}
