//! Synthetic adversarial artifact tests. No fixture value is a live credential.
//! Construct signatures at runtime so this source is itself safe audit input.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use gdm::runtime::credentials::contains_credentials;

fn encode(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(value)
}

fn jwt(header: &str, payload: &str, signature: &str) -> String {
    [encode(header), encode(payload), encode(signature)].join(".")
}

#[test]
fn identifiers_property_chains_and_detector_source_are_public() {
    let cases = [
        "com.godongmin.fitcoach.fitcoachFlutter",
        "com.godongmin.fitcoach.fitcoach_flutter",
        "configuration.accountConfiguration.dailyNutritionTarget",
        "https://fitcoach-gdm0714.web.app/privacy.html",
        "1:1009801877754:android:4e384c0a66122a78585143",
        r"const detector = /ghp_|github_pat_|AKIA|Bearer |BEGIN [A-Z ]*PRIVATE KEY/;",
        r"const detector = /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]+/;",
        r"const detector = /AKIA[A-Z0-9]{16}|sk-(?:proj-)?[a-zA-Z0-9_-]+/;",
        r"const detector = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;",
        "BEGIN PRIVATE KEY describes a header; no key material follows.",
        "ghp_ github_pat_ AKIA",
        "공개 근황 식별자와 UTF-8 문구 🫧",
    ];
    for (index, value) in cases.into_iter().enumerate() {
        assert!(!contains_credentials(value), "public case {index}");
    }
}

#[test]
fn authorization_interpolation_and_concatenation_are_not_token_values() {
    let cases = [
        "const headers = {Authorization: `Bearer ${token}`};",
        "const header = 'Bearer ' + token;",
        "const header = \"Bearer \" + token;",
        "'Authorization': 'Bearer ${await user.getIdToken()}'",
        "const prefix = 'Bearer ';",
        "const pattern = /Bearer [a-z0-9]+/;",
    ];
    for (index, value) in cases.into_iter().enumerate() {
        assert!(
            !contains_credentials(value),
            "source interpolation case {index}"
        );
    }
}

#[test]
fn valid_jose_headers_detect_short_segments_and_unusual_header_layouts() {
    let cases = [
        jwt(r#"{"alg":"HS256","typ":"JWT"}"#, "{}", "x"),
        jwt(r#"{ "typ": "JWT", "alg" : "RS256" }"#, "0", "s"),
        jwt(r#"{"kid":"fixture","alg":"ES256"}"#, "{}", "sig"),
    ];
    for (index, value) in cases.into_iter().enumerate() {
        assert!(
            contains_credentials(&value),
            "JOSE short segment case {index}"
        );
        assert!(
            contains_credentials(&format!("const token = '{value}';")),
            "JOSE code case {index}"
        );
    }
}

#[test]
fn unsigned_jwt_and_direct_jwe_are_still_sensitive_artifact_content() {
    let unsigned = [encode(r#"{"alg":"none"}"#), encode("{}"), String::new()].join(".");
    let encrypted = [
        encode(r#"{"alg":"dir","enc":"A256GCM"}"#),
        String::new(),
        encode("iv"),
        encode("cipher"),
        encode("tag"),
    ]
    .join(".");
    assert!(contains_credentials(&unsigned), "unsigned JWT missed");
    assert!(contains_credentials(&encrypted), "direct JWE missed");
}

#[test]
fn arbitrary_base64_objects_are_not_a_jwt_heuristic() {
    for header in [
        r#"{"name":"public"}"#,
        r#"{"alg":null}"#,
        "not a JSON object",
    ] {
        let value = jwt(header, "some public data", "text marker");
        assert!(
            !contains_credentials(&value),
            "non-JOSE content classified as token"
        );
    }
}

#[test]
fn synthetic_sensitive_patterns_remain_blocked_in_every_surrounding_context() {
    let values = [
        ["Bearer ", "fixtureOpaqueCredential7826"].concat(),
        ["Bearer ", "fake"].concat(),
        ["bEaReR\t", "short-fixture"].concat(),
        ["sk-", "proj-", &"A1b2C3d4".repeat(8)].concat(),
        ["ghp", "_", &"Z9y8X7w6".repeat(5)].concat(),
        ["github", "_pat_", &"F1e2D3c4".repeat(10)].concat(),
        ["AK", "IA", "A1B2C3D4E5F6G7H8"].concat(),
        ["-----BEGIN ", "PRIVATE KEY-----"].concat(),
        ["-----BEGIN EC ", "PRIVATE KEY-----"].concat(),
        ["-----BEGIN RSA ", "PRIVATE KEY-----"].concat(),
        ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].concat(),
        jwt(r#"{"alg":"HS256"}"#, "{}", "x"),
    ];
    for (index, value) in values.into_iter().enumerate() {
        for (wrapper, text) in [
            ("plain", value.clone()),
            ("code", format!("const fixture = '{value}';")),
            ("fence", format!("```javascript\n{value}\n```")),
            ("comment", format!("// com.godongmin.fitcoach\n// {value}")),
            (
                "mixed",
                format!("public.identifier.chain\n{value}\n公開の説明"),
            ),
        ] {
            assert!(
                contains_credentials(&text),
                "sensitive case {index} in {wrapper}"
            );
        }
    }
}

#[test]
fn earlier_public_text_does_not_mask_a_later_credential() {
    let token = jwt(r#"{"alg":"HS256"}"#, "{}", "x");
    let text = format!("com.godongmin.fitcoach.fitcoachFlutter\nconst pattern = /ghp_/;\n{token}");
    assert!(contains_credentials(&text));
    // A preceding dot pair must not consume the encoded header as a property
    // segment and hide its own compact credential suffix from the next match.
    for prefix in ["public.settings.", "before.property."] {
        assert!(
            contains_credentials(&format!("{prefix}{token}")),
            "dot-separated prefix masked a later protected header"
        );
    }
}
