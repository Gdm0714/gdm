use serde_json::Value;
use std::{fs, process::Command};
use tempfile::TempDir;

struct Fixture(TempDir);
impl Fixture {
    fn run(&self, args: &[&str]) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_gdm"))
            .args(["--language", "en"])
            .args(args)
            .current_dir(self.0.path())
            .env("GDM_CONFIG_DIR", self.0.path().join("config"))
            .output()
            .unwrap()
    }
    fn ok(&self, args: &[&str]) {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn new() -> Self {
        let f = Self(tempfile::tempdir().unwrap());
        fs::write(f.0.path().join(".gitignore"), ".gdm/\nconfig/\n").unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
            vec!["add", ".gitignore"],
            vec!["commit", "-m", "fixture"],
        ] {
            assert!(
                Command::new("git")
                    .args(args)
                    .current_dir(f.0.path())
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        f.ok(&[
            "plan",
            "init",
            "--slug",
            "models",
            "--brief",
            "Mixed model audit",
            "--audit",
            "--require",
            "Independent audit",
        ]);
        f.ok(&[
            "plan",
            "add",
            "--slug",
            "models",
            "--desc",
            "Observable result",
            "--cmd",
            "true",
            "--expect",
            "Success",
        ]);
        f.ok(&["pass", "c1", "--slug", "models"]);
        f
    }
    fn report(&self, models: &[&str], auditor: &str) {
        fs::write(
            self.0.path().join(".gdm/models/report.md"),
            format!(
                "**판정: 통과**\n{}auditModel: {auditor}\n",
                models
                    .iter()
                    .map(|m| format!("implementationModel: {m}\n"))
                    .collect::<String>()
            ),
        )
        .unwrap();
    }
    fn verdict(&self, models: &[&str], auditor: &str) -> std::process::Output {
        let mut args = vec![
            "audit",
            "verdict",
            "--slug",
            "models",
            "--pass",
            "--report",
            ".gdm/models/report.md",
            "--audit-model",
            auditor,
        ];
        for model in models {
            args.extend(["--implementation-model", model]);
        }
        self.run(&args)
    }
}

#[test]
fn mixed_implementation_models_roundtrip_and_same_second_model_is_rejected() {
    let f = Fixture::new();
    f.report(&["writer-a", "writer-b"], "WRITER-B");
    let rejected = f.verdict(&["writer-a", "writer-b"], "WRITER-B");
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("audit_independence"));
    f.report(&["writer-a", "writer-b"], "reviewer-c");
    assert!(
        f.verdict(&["writer-a", "writer-b"], "reviewer-c")
            .status
            .success()
    );
    let output = f.run(&["protocol", "export", "--slug", "models"]);
    assert!(output.status.success());
    let state: Value =
        serde_json::from_slice(&fs::read(f.0.path().join(".gdm/models/checks.json")).unwrap())
            .unwrap();
    assert_eq!(
        state["audit"]["implementationModels"],
        serde_json::json!(["writer-a", "writer-b"])
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("implementationModels"));
    f.ok(&["done", "--slug", "models"]);
}

#[test]
fn report_must_name_each_exact_model_and_duplicates_are_rejected() {
    let f = Fixture::new();
    f.report(&["writer-a", "writer-b-extra"], "reviewer");
    assert!(
        !f.verdict(&["writer-a", "writer-b"], "reviewer")
            .status
            .success()
    );
    f.report(&["writer-a", "WRITER-A"], "reviewer");
    let duplicate = f.verdict(&["writer-a", "WRITER-A"], "reviewer");
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("audit_model_mismatch"));
}

#[test]
fn old_scalar_audit_remains_compatible_and_array_tampering_fails() {
    let f = Fixture::new();
    f.report(&["writer"], "reviewer");
    assert!(f.verdict(&["writer"], "reviewer").status.success());
    let path = f.0.path().join(".gdm/models/checks.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["audit"]
        .as_object_mut()
        .unwrap()
        .remove("implementationModels");
    fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    f.ok(&["protocol", "export", "--slug", "models"]);
    state["audit"]["implementationModels"] = serde_json::json!(["different"]);
    fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    assert!(
        !f.run(&["protocol", "export", "--slug", "models"])
            .status
            .success()
    );
}
