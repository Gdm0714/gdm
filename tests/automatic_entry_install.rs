use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        fs::create_dir(root.join("home")).unwrap();
        Self { _temp: t, root }
    }
    fn path(&self, t: &str) -> PathBuf {
        self.root.join(match t {
            "codex" => "codex/hooks.json",
            "claude" => "home/.claude/settings.json",
            _ => "gid/extensions/gdm-entry-v1.json",
        })
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_gdm"))
            .args(["--language", "en"])
            .args(args)
            .current_dir(&self.root)
            .env("HOME", self.root.join("home"))
            .env("GDM_CONFIG_DIR", self.root.join("gdm-config"))
            .env("CODEX_HOME", self.root.join("codex"))
            .env("GID_CONFIG_DIR", self.root.join("gid"))
            .env("PATH", self.root.join("bin"))
            .output()
            .unwrap()
    }
    fn install(&self, t: &str, dry: bool) -> Output {
        let mut a = vec![
            "entry",
            "install",
            "--target",
            t,
            "--binary",
            env!("CARGO_BIN_EXE_gdm"),
            "--json",
        ];
        if dry {
            a.push("--dry-run");
        }
        self.run(&a)
    }
    fn fake_gid(&self, fail: bool) {
        fs::create_dir(self.root.join("bin")).unwrap();
        let p = self.root.join("bin/gid");
        fs::write(
            &p,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\nexit {}\n",
                self.root.join("argv").display(),
                if fail { 1 } else { 0 }
            ),
        )
        .unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
fn value(o: Output) -> Value {
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_slice(&o.stdout).unwrap()
}
fn put(p: &Path, v: &Value) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, format!("{}\n", serde_json::to_string_pretty(v).unwrap())).unwrap();
}
#[test]
fn installs_preserve_settings_agent_gate_permissions_and_are_idempotent() {
    for t in ["codex", "claude"] {
        let f = Fixture::new();
        let p = f.path(t);
        let before = json!({"permissionMode":"ask","unrelated":true,"hooks":{"Stop":[{"matcher":"custom","hooks":[{"type":"command","command":"user-hook"},{"type":"command","command":"gdm agent hook --handler-id gdm-agent-gate-v1"}]}]}});
        put(&p, &before);
        fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        let original = fs::read(&p).unwrap();
        assert_eq!(value(f.install(t, false))["changed"], true);
        let after: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        assert_eq!(after["permissionMode"], "ask");
        assert_eq!(after["hooks"]["Stop"][0], before["hooks"]["Stop"][0]);
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            fs::read(p.with_extension("json.gdm-entry-backup")).unwrap(),
            original
        );
        let bytes = fs::read(&p).unwrap();
        assert_eq!(value(f.install(t, false))["changed"], false);
        assert_eq!(fs::read(&p).unwrap(), bytes);
    }
}
#[test]
fn dry_run_never_creates_target_roots() {
    let f = Fixture::new();
    for t in ["codex", "claude", "gid"] {
        let v = value(f.install(t, true));
        assert_eq!(v["dryRun"], true);
        assert!(!f.path(t).exists());
    }
    assert!(!f.root.join("codex").exists());
    assert!(!f.root.join("gid").exists());
}
#[test]
fn managed_uninstall_preserves_new_unrelated_settings_and_backup() {
    let f = Fixture::new();
    let p = f.path("claude");
    let before = json!({"permissionMode":"ask","hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]}});
    put(&p, &before);
    value(f.install("claude", false));
    let mut newer: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    newer["laterUserEdit"] = json!("preserve");
    put(&p, &newer);
    value(f.run(&["entry", "uninstall", "--target", "claude", "--json"]));
    let restored: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    assert_eq!(restored["hooks"], before["hooks"]);
    assert_eq!(restored["laterUserEdit"], "preserve");
    assert!(p.with_extension("json.gdm-entry-backup").exists());
}
#[test]
fn malformed_and_unsafe_paths_fail_without_touching_original() {
    let f = Fixture::new();
    let p = f.path("codex");
    fs::create_dir(p.parent().unwrap()).unwrap();
    fs::write(&p, "not json").unwrap();
    assert!(!f.install("codex", false).status.success());
    assert_eq!(fs::read_to_string(&p).unwrap(), "not json");
    fs::remove_file(&p).unwrap();
    let outside = f.root.join("outside");
    fs::write(&outside, "{}").unwrap();
    symlink(&outside, &p).unwrap();
    assert!(!f.install("codex", false).status.success());
    assert_eq!(fs::read_to_string(outside).unwrap(), "{}");
}
#[test]
fn gid_registration_uses_real_cli_argv_and_preserves_manifest_on_failure() {
    let f = Fixture::new();
    f.fake_gid(false);
    let v = value(f.install("gid", false));
    assert_eq!(v["registered"], true);
    let argv = fs::read_to_string(f.root.join("argv")).unwrap();
    assert_eq!(
        argv,
        format!("extension\nadd\n{}\n--trust\n", f.path("gid").display())
    );
    let m: Value = serde_json::from_slice(&fs::read(f.path("gid")).unwrap()).unwrap();
    assert_eq!(m["hooks"][0]["command"][0], env!("CARGO_BIN_EXE_gdm"));
    value(f.run(&["entry", "uninstall", "--target", "gid", "--json"]));
    assert!(!f.path("gid").exists());
    let failed = Fixture::new();
    failed.fake_gid(true);
    assert!(!failed.install("gid", false).status.success());
    assert!(!failed.path("gid").exists());
}
#[test]
fn failed_gid_reregistration_restores_existing_bytes_and_mode() {
    for changed in [false, true] {
        let f = Fixture::new();
        f.fake_gid(false);
        value(f.install("gid", false));
        let path = f.path("gid");
        if changed {
            let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            manifest["version"] = json!("0.9.0");
            put(&path, &manifest);
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let before = fs::read(&path).unwrap();
        fs::write(f.root.join("bin/gid"), "#!/bin/sh\nexit 1\n").unwrap();
        assert!(!f.install("gid", false).status.success());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
#[test]
fn absent_gid_reports_pending_registration_without_claiming_effective() {
    let f = Fixture::new();
    let v = value(f.install("gid", false));
    assert_eq!(v["registered"], false);
    assert_eq!(v["effective"], "unverified");
    assert!(f.path("gid").exists());
}
#[test]
fn unsafe_parent_and_backup_symlinks_are_rejected() {
    let f = Fixture::new();
    let outside = f.root.join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, f.root.join("codex")).unwrap();
    assert!(!f.install("codex", false).status.success());
    assert!(!outside.join("hooks.json").exists());
    let f = Fixture::new();
    let p = f.path("claude");
    put(&p, &json!({}));
    let other = f.root.join("backup");
    fs::write(&other, "untouched").unwrap();
    symlink(&other, p.with_extension("json.gdm-entry-backup")).unwrap();
    assert!(!f.install("claude", false).status.success());
    assert_eq!(fs::read_to_string(other).unwrap(), "untouched");
}
#[test]
fn multi_target_shell_install_rolls_back_earlier_configs_on_gid_failure() {
    let f = Fixture::new();
    f.fake_gid(true);
    let cargo = f.root.join("bin/cargo");
    fs::write(&cargo, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&cargo, fs::Permissions::from_mode(0o755)).unwrap();
    let target = f.root.join("target/release");
    fs::create_dir_all(&target).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_gdm"), target.join("gdm")).unwrap();
    let codex =
        json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-codex-hook"}]}]}});
    let claude = json!({"permissionMode":"ask","userSetting":"keep"});
    put(&f.path("codex"), &codex);
    put(&f.path("claude"), &claude);
    let codex_before = fs::read(f.path("codex")).unwrap();
    let claude_before = fs::read(f.path("claude")).unwrap();
    let installed = f.root.join("home/.local/bin/gdm");
    fs::create_dir_all(installed.parent().unwrap()).unwrap();
    fs::write(&installed, "old user binary").unwrap();
    let result = Command::new("/bin/bash")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("install/install.sh"))
        .current_dir(&f.root)
        .env("HOME", f.root.join("home"))
        .env("CODEX_HOME", f.root.join("codex"))
        .env("GID_CONFIG_DIR", f.root.join("gid"))
        .env("GDM_CONFIG_DIR", f.root.join("gdm-config"))
        .env("CARGO_TARGET_DIR", f.root.join("target"))
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", f.root.join("bin").display()),
        )
        .output()
        .unwrap();
    assert!(!result.status.success(), "unexpected install success");
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("gid registration failed"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read(f.path("codex")).unwrap(), codex_before);
    assert_eq!(fs::read(f.path("claude")).unwrap(), claude_before);
    assert_eq!(fs::read_to_string(installed).unwrap(), "old user binary");
    assert!(!f.path("gid").exists());
    assert!(!f.root.join("home/.claude/skills/gdm-go").exists());
}
