use gdm::runtime::state;
use serde_json::Value;
#[test]
fn native_work_contract_and_hashes_match_legacy_oracle_corpus() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("state_oracle.json")).unwrap();
    let mut mismatches = vec![];
    for case in cases {
        let result = state::validate_work(case["input"].clone());
        if let Some(code) = case["errorCode"].as_str() {
            if result.as_ref().err().map(|e| e.code.as_str()) != Some(code) {
                mismatches.push(format!(
                    "{} expected error {} got {:?}",
                    case["name"], code, result
                ));
            }
        } else {
            match result {
                Err(e) => mismatches.push(format!("{}: {e}", case["name"])),
                Ok(work) => {
                    if work != case["expected"] {
                        mismatches.push(format!("{} normalized value mismatch", case["name"]));
                    }
                    if state::checks_hash(&work) != case["checksHash"] {
                        mismatches.push(format!("{} checks hash mismatch", case["name"]));
                    }
                    if state::verification_plan_fingerprint(&work) != case["planFingerprint"] {
                        mismatches.push(format!("{} plan fingerprint mismatch", case["name"]));
                    }
                }
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
