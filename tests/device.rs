use gdm::{device::*, support::Result};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};
fn config() -> Value {
    json!({"version":1,"device":{"id":"12345678-1234-1234-1234-123456789012","udid":"00008030-0012345678901234","name":"Test iPhone"},"bundleID":"com.example.test","project":"App.xcodeproj","scheme":"App","derivedDataPath":"build","appPath":"build/App.app","testTargets":["Tests/IsolatedTests"],"capture":{"isolationArgument":"-capture","cases":[{"name":"home","arguments":["-isolated"]}]}})
}
fn details() -> Value {
    let c = config();
    json!({"info":{"outcome":"success"},"result":{"identifier":c["device"]["id"],"hardwareProperties":{"udid":c["device"]["udid"],"reality":"physical","platform":"iOS"},"deviceProperties":{"name":c["device"]["name"],"bootState":"booted","developerModeStatus":"enabled","ddiServicesAvailable":true},"connectionProperties":{"pairingState":"paired","tunnelState":"connected"}}})
}
fn summary() -> Value {
    let c = config();
    json!({"result":"Passed","totalTestCount":1,"passedTests":1,"failedTests":0,"expectedFailures":0,"testFailures":[],"devicesAndConfigurations":[{"device":{"deviceId":c["device"]["udid"],"deviceName":c["device"]["name"],"platform":"iOS"},"passedTests":1,"failedTests":0,"expectedFailures":0}]})
}
fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut bytes, 1, 1);
        enc.set_color(png::ColorType::Rgb);
        enc.write_header()
            .unwrap()
            .write_image_data(&[1, 2, 3])
            .unwrap();
    }
    bytes
}
#[derive(Default)]
struct Fake {
    calls: Vec<Vec<String>>,
    fail_copy: bool,
    locked: bool,
    cancel: bool,
    cancel_copy: bool,
    restore_fail: bool,
    zero: bool,
    wrong_bundle: bool,
    missing_png: bool,
}
impl Runner for Fake {
    fn sleep(&mut self, _: Duration) {}
    fn cancelled(&self) -> bool {
        self.cancel
    }
    fn run(&mut self, c: &DeviceCommand) -> Result<CommandResult> {
        self.calls.push(c.args.clone());
        fs::write(&c.stdout, "")?;
        fs::write(&c.stderr, "")?;
        let has = |s: &str| c.args.iter().any(|a| a == s);
        let arg = |s: &str| c.args[c.args.iter().position(|a| a == s).unwrap() + 1].clone();
        if has("copy") && (self.fail_copy || self.cancel_copy) {
            if self.cancel_copy {
                self.cancel = true;
            }
            return Ok(CommandResult {
                exit_code: 1,
                timed_out: false,
            });
        }
        if has("launch") && !has("-capture") {
            assert!(c.cleanup);
            if self.restore_fail {
                return Ok(CommandResult {
                    exit_code: 1,
                    timed_out: false,
                });
            }
        }
        if has("--json-output") {
            let value = if has("details") {
                details()
            } else if has("lockState") {
                json!({"info":{"outcome":"success"},"result":{"deviceIdentifier":config()["device"]["id"],"unlockedSinceBoot":true,"passcodeRequired":self.locked}})
            } else if has("list") {
                json!({"info":{"outcome":"success"},"result":{"devices":[]}})
            } else {
                json!({"info":{"outcome":"success"}})
            };
            fs::write(arg("--json-output"), serde_json::to_vec(&value)?)?;
        }
        if has("copy") && !self.missing_png {
            fs::write(arg("--destination"), png())?;
        }
        if c.executable.ends_with("PlistBuddy") {
            fs::write(
                &c.stdout,
                if self.wrong_bundle {
                    "com.wrong.app"
                } else {
                    "com.example.test"
                },
            )?;
        }
        if has("xcresulttool") {
            let mut s = summary();
            if self.zero {
                s["totalTestCount"] = json!(0);
            }
            fs::write(&c.stdout, serde_json::to_vec(&s)?)?;
        }
        Ok(CommandResult {
            exit_code: 0,
            timed_out: false,
        })
    }
}
fn fixture() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    fs::write(
        t.path().join(".gdm-device.json"),
        serde_json::to_vec(&config()).unwrap(),
    )
    .unwrap();
    fs::create_dir_all(t.path().join("build/App.app")).unwrap();
    t
}
fn run(t: &Path, action: &str, f: &mut Fake) -> Value {
    execute(
        t,
        &Options::parse(&[action.into(), "--json".into()]).unwrap(),
        f,
        Some(&t.join("locks")),
    )
    .unwrap()
}
#[test]
fn config_rejects_escape_unknown_fields_and_unsafe_targets() {
    for (key, value) in [
        ("project", json!("../App.xcodeproj")),
        ("extra", json!(1)),
        ("testTargets", json!(["foo;rm"])),
    ] {
        let mut c = config();
        c[key] = value;
        assert!(parse_config(c, Path::new("/tmp/project")).is_err());
    }
    let mut c = config();
    c["capture"]["cases"][0]["arguments"] = json!(["-capture"]);
    assert!(parse_config(c, Path::new("/tmp/project")).is_err());
}
#[test]
fn parser_rejects_duplicates_and_wrong_options() {
    for a in [
        vec!["list", "--config", "x"],
        vec!["doctor", "--case", "x"],
        vec!["list", "--json", "--json"],
        vec!["capture", "--case"],
    ] {
        assert!(Options::parse(&a.iter().map(|x| x.to_string()).collect::<Vec<_>>()).is_err());
    }
}
#[test]
fn physical_and_summary_guards() {
    let c = parse_config(config(), Path::new("/tmp/project")).unwrap();
    let mut d = details();
    d["result"]["hardwareProperties"]["reality"] = json!("simulated");
    assert_eq!(
        inspect_device(&d, &c).unwrap_err().code,
        "device_not_physical"
    );
    let mut s = summary();
    s["devicesAndConfigurations"][0]["device"]["deviceId"] = json!("wrong");
    assert_eq!(
        inspect_summary(&s, &c).unwrap_err().code,
        "device_test_mismatch"
    );
}
#[test]
fn png_integrity() {
    let p = png();
    assert_eq!(inspect_png(&p).unwrap(), (1, 1));
    let mut bad = p.clone();
    bad[20] ^= 1;
    assert!(inspect_png(&bad).is_err());
    assert!(inspect_png(&p[..p.len() - 1]).is_err());
}
#[test]
fn all_actions_and_receipt() {
    for action in ["list", "doctor", "build", "install", "test", "capture"] {
        let t = fixture();
        let mut f = Fake::default();
        let r = run(t.path(), action, &mut f);
        assert_eq!(r["success"], true, "{r}");
        let persisted: Value =
            serde_json::from_slice(&fs::read(r["receiptPath"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(persisted, r);
        if action == "test" {
            assert!(
                f.calls
                    .iter()
                    .any(|a| a.contains(&"-only-testing:Tests/IsolatedTests".into()))
            );
        }
    }
}
#[test]
fn capture_unique_and_normal_restore() {
    let t = fixture();
    let mut f = Fake::default();
    let a = run(t.path(), "capture", &mut f);
    let b = run(t.path(), "capture", &mut f);
    assert_ne!(a["capture"]["path"], b["capture"]["path"]);
    assert_eq!(a["restore"]["success"], true);
    assert_eq!(f.calls.last().unwrap().last().unwrap(), "com.example.test");
    assert!(!f.calls.last().unwrap().contains(&"-capture".into()));
}
#[test]
fn copy_failure_retries_eight_and_restores() {
    let t = fixture();
    let mut f = Fake {
        fail_copy: true,
        ..Default::default()
    };
    let r = run(t.path(), "capture", &mut f);
    assert_eq!(r["success"], false);
    assert_eq!(r["restore"]["success"], true);
    assert_eq!(
        f.calls
            .iter()
            .filter(|a| a.contains(&"copy".into()))
            .count(),
        8
    );
    assert!(r.get("capture").is_none());
}
#[test]
fn missing_png_and_restore_failure_do_not_pass() {
    for mut f in [
        Fake {
            missing_png: true,
            ..Default::default()
        },
        Fake {
            restore_fail: true,
            ..Default::default()
        },
    ] {
        let t = fixture();
        assert_eq!(run(t.path(), "capture", &mut f)["success"], false);
    }
}
#[test]
fn cancelled_capture_still_restores() {
    let t = fixture();
    let mut f = Fake {
        cancel_copy: true,
        ..Default::default()
    };
    let r = run(t.path(), "capture", &mut f);
    assert_eq!(r["success"], false);
    assert_eq!(r["restore"]["success"], true);
}
#[test]
fn locked_device_has_no_mutations() {
    let t = fixture();
    let mut f = Fake {
        locked: true,
        ..Default::default()
    };
    let r = run(t.path(), "capture", &mut f);
    assert_eq!(r["error"]["code"], "device_locked");
    assert_eq!(f.calls.len(), 2);
}
#[test]
fn wrong_bundle_and_zero_tests_rejected() {
    let t = fixture();
    let mut f = Fake {
        wrong_bundle: true,
        ..Default::default()
    };
    let r = run(t.path(), "install", &mut f);
    assert_eq!(r["error"]["code"], "device_mismatch");
    assert!(!f.calls.iter().any(|a| a.contains(&"install".into())));
    let mut f = Fake {
        zero: true,
        ..Default::default()
    };
    let r = run(t.path(), "test", &mut f);
    assert_eq!(r["error"]["code"], "device_test_failed");
    assert_eq!(r["restore"]["success"], true);
}
#[test]
fn symlink_and_busy_lock_preserved() {
    let t = fixture();
    let target = t.path().join("elsewhere");
    fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, t.path().join(".gdm-artifacts")).unwrap();
    let mut f = Fake::default();
    let o = Options::parse(&["doctor".into()]).unwrap();
    assert!(execute(t.path(), &o, &mut f, None).is_err());
    assert!(f.calls.is_empty());
    fs::remove_file(t.path().join(".gdm-artifacts")).unwrap();
    let lock = t
        .path()
        .join("locks")
        .join(config()["device"]["id"].as_str().unwrap());
    fs::create_dir_all(&lock).unwrap();
    let r = run(t.path(), "doctor", &mut f);
    assert_eq!(r["error"]["code"], "device_busy");
    assert!(lock.exists());
    assert!(f.calls.is_empty());
}
#[test]
fn process_argv_timeout_and_no_overwrite() {
    let t = fixture();
    let literal = "$(touch forbidden) `touch forbidden`; hi";
    let c = DeviceCommand {
        executable: "/usr/bin/printf".into(),
        args: vec!["%s".into(), literal.into()],
        cwd: t.path().into(),
        stdout: t.path().join("out"),
        stderr: t.path().join("err"),
        timeout: Duration::from_secs(3),
        cleanup: false,
    };
    assert_eq!(ProcessRunner.run(&c).unwrap().exit_code, 0);
    assert_eq!(fs::read_to_string(&c.stdout).unwrap(), literal);
    assert!(!t.path().join("forbidden").exists());
    assert!(ProcessRunner.run(&c).is_err());
    let c = DeviceCommand {
        executable: "/bin/sleep".into(),
        args: vec!["5".into()],
        stdout: t.path().join("out2"),
        stderr: t.path().join("err2"),
        timeout: Duration::from_millis(30),
        ..c
    };
    assert!(ProcessRunner.run(&c).unwrap().timed_out);
}
#[test]
fn cli_help_and_invalid_args_do_not_touch_devices_or_state() {
    let t = tempfile::tempdir().unwrap();
    let binary = env!("CARGO_BIN_EXE_gdm");
    let help = std::process::Command::new(binary)
        .args(["device", "--help"])
        .current_dir(t.path())
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("capture"));
    for args in [
        vec!["device", "doctor", "--case", "dark"],
        vec!["device", "list", "--config", "a"],
        vec!["device", "test", "--simulator"],
    ] {
        let output = std::process::Command::new(binary)
            .args(args)
            .current_dir(t.path())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
    }
    assert!(!t.path().join(".gdm-artifacts").exists());
    assert!(!t.path().join(".gdm").exists());
}
#[test]
fn empty_test_targets_and_unknown_capture_case_fail_before_runner() {
    let t = fixture();
    let mut c = config();
    c["testTargets"] = json!([]);
    fs::write(
        t.path().join(".gdm-device.json"),
        serde_json::to_vec(&c).unwrap(),
    )
    .unwrap();
    let mut f = Fake::default();
    for args in [vec!["test"], vec!["capture", "--case", "missing"]] {
        let options =
            Options::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
        assert!(execute(t.path(), &options, &mut f, None).is_err());
    }
    assert!(f.calls.is_empty());
    assert!(!t.path().join(".gdm-artifacts").exists());
}
