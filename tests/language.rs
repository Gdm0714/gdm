use std::process::{Command, Output};

fn run(root: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gdm"));
    command
        .current_dir(root)
        .args(args)
        .env("GDM_CONFIG_DIR", root.join("config"))
        .env("LC_ALL", "en_US.UTF-8")
        .env_remove("GDM_LANGUAGE");
    for (key, value) in env {
        command.env(key, value);
    }
    command.output().unwrap()
}
fn text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn real_cli_selects_and_persists_languages_without_changing_other_settings() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("config")).unwrap();
    std::fs::write(root.path().join("config/other"), "preserve").unwrap();
    let english = run(root.path(), &["--help"], &[]);
    assert!(english.status.success());
    assert!(text(&english).contains("An evidence-driven workflow"));
    let korean = run(
        root.path(),
        &["--language", "ko", "--help"],
        &[("GDM_LANGUAGE", "invalid")],
    );
    assert!(korean.status.success());
    assert!(text(&korean).contains("사용법"));
    assert!(run(root.path(), &["language", "ko"], &[]).status.success());
    assert!(text(&run(root.path(), &["--help"], &[])).contains("사용법"));
    assert!(
        text(&run(root.path(), &["--help"], &[("GDM_LANGUAGE", "en")]))
            .contains("An evidence-driven workflow")
    );
    assert!(
        run(root.path(), &["language", "auto"], &[])
            .status
            .success()
    );
    assert!(
        text(&run(root.path(), &["--help"], &[("LC_ALL", "ja_JP.UTF-8")]))
            .contains("An evidence-driven workflow")
    );
    assert_eq!(
        run(root.path(), &["--language", "fr", "--help"], &[])
            .status
            .code(),
        Some(2)
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("config/other")).unwrap(),
        "preserve"
    );
}

#[test]
fn real_english_workflow_preserves_korean_user_text_and_json_contract() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root.path())
            .status()
            .unwrap()
            .success()
    );
    let init = run(
        root.path(),
        &[
            "plan",
            "init",
            "--slug",
            "language-test",
            "--brief",
            "한국어 사용자 설명",
            "--require",
            "Keep user text",
        ],
        &[],
    );
    assert!(init.status.success(), "{}", text(&init));
    let add = run(
        root.path(),
        &[
            "plan",
            "add",
            "--slug",
            "language-test",
            "--desc",
            "English output",
            "--cmd",
            "true",
            "--expect",
            "Exit zero",
            "--kind",
            "behavior",
        ],
        &[],
    );
    assert!(add.status.success(), "{}", text(&add));
    let pass = run(root.path(), &["pass", "c1", "--slug", "language-test"], &[]);
    assert!(pass.status.success(), "{}", text(&pass));
    let export = run(
        root.path(),
        &["protocol", "export", "--slug", "language-test"],
        &[],
    );
    assert!(export.status.success(), "{}", text(&export));
    let snapshot: serde_json::Value = serde_json::from_slice(&export.stdout).unwrap();
    assert_eq!(snapshot["schemaVersion"], "gdm-work-snapshot/v1");
    assert!(text(&export).contains("한국어 사용자 설명"));
    let done = run(root.path(), &["done", "--slug", "language-test"], &[]);
    assert!(done.status.success(), "{}", text(&done));
}
