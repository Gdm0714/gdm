use crate::support::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub device: Device,
    #[serde(rename = "bundleID")]
    pub bundle_id: String,
    pub project: String,
    pub scheme: String,
    pub derived_data_path: String,
    pub app_path: String,
    pub test_targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<Capture>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub udid: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub isolation_argument: String,
    pub cases: Vec<Case>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub name: String,
    pub arguments: Vec<String>,
}
pub(super) fn err(code: &str, message: &str) -> Error {
    Error::new(code, message)
}
fn text(s: &str, max: usize) -> Result<()> {
    if s.trim().is_empty() || s.chars().count() > max || s.chars().any(|c| c < ' ') {
        return Err(err(
            "device_invalid",
            "빈 값·제어 문자는 실기기 설정에 사용할 수 없습니다",
        ));
    }
    Ok(())
}
fn matches(s: &str, pattern: &str) -> bool {
    regex::Regex::new(pattern)
        .expect("constant regex")
        .is_match(s)
}
pub fn local_path(cwd: &Path, part: &str) -> Result<PathBuf> {
    text(part, 1024)?;
    if Path::new(part).is_absolute() {
        return Err(err("device_invalid", "프로젝트 상대 경로가 필요합니다"));
    }
    let mut relative = PathBuf::new();
    for c in Path::new(part).components() {
        match c {
            Component::Normal(c) => relative.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                if !relative.pop() {
                    return Err(err("device_invalid", "작업 폴더를 벗어난 경로"));
                }
            }
            _ => return Err(err("device_invalid", "잘못된 경로")),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(err("device_invalid", "작업 폴더 자체는 사용할 수 없습니다"));
    }
    Ok(cwd.join(relative))
}
pub(super) fn contained(cwd: &Path, part: &str) -> Result<PathBuf> {
    let p = local_path(cwd, part)?;
    let mut current = cwd.to_owned();
    for segment in p
        .strip_prefix(cwd)
        .map_err(|_| err("device_invalid", "경로 범위 오류"))?
        .components()
    {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(err(
                    "device_invalid",
                    "실기기 경로에 심볼릭 링크를 사용할 수 없습니다",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(p)
}
pub(super) fn small(path: &Path, max: u64) -> Result<Vec<u8>> {
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > max {
        return Err(err("device_invalid", "증거 파일 종류 또는 크기 오류"));
    }
    Ok(fs::read(path)?)
}
pub fn parse_config(value: Value, cwd: &Path) -> Result<Config> {
    if value.get("capture").is_some_and(Value::is_null) {
        return Err(err("device_invalid", "격리 캡처 설정은 객체여야 합니다"));
    }
    let c: Config = serde_json::from_value(value)
        .map_err(|_| err("device_invalid", "실기기 설정 필드를 확인해 주세요"))?;
    if c.version != 1
        || !matches(
            &c.device.id,
            r"(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$",
        )
        || !matches(&c.device.udid, r"(?i)^[a-z0-9-]{8,80}$")
        || !matches(&c.bundle_id, r"(?i)^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
    {
        return Err(err(
            "device_invalid",
            "설정 version, 기기 ID 또는 bundleID 오류",
        ));
    }
    for s in [&c.device.name, &c.scheme, &c.bundle_id] {
        text(s, 256)?;
    }
    for p in [&c.project, &c.derived_data_path, &c.app_path] {
        local_path(cwd, p)?;
    }
    if !c.project.ends_with(".xcodeproj")
        || !c.app_path.ends_with(".app")
        || c.test_targets.len() > 32
    {
        return Err(err(
            "device_invalid",
            "project, appPath 또는 testTargets 오류",
        ));
    }
    for t in &c.test_targets {
        text(t, 256)?;
        if !matches(t, r"^[A-Za-z0-9_./]+$") {
            return Err(err("device_invalid", "testTargets 오류"));
        }
    }
    if let Some(cap) = &c.capture {
        text(&cap.isolation_argument, 256)?;
        if !matches(&cap.isolation_argument, r"(?i)^-[a-z][a-z0-9-]*$")
            || cap.cases.is_empty()
            || cap.cases.len() > 20
        {
            return Err(err("device_invalid", "격리 캡처 설정 오류"));
        }
        let mut names = HashSet::new();
        for case in &cap.cases {
            if !matches(&case.name, r"^[a-z0-9][a-z0-9-]{0,63}$")
                || !names.insert(&case.name)
                || case.arguments.len() > 32
            {
                return Err(err("device_invalid", "캡처 장면 오류"));
            }
            for arg in &case.arguments {
                text(arg, 1024)?;
                if arg == &cap.isolation_argument {
                    return Err(err("device_invalid", "격리 인자 중복"));
                }
            }
        }
    }
    Ok(c)
}
pub fn inspect_device(v: &Value, c: &Config) -> Result<()> {
    let r = &v["result"];
    if !r["identifier"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case(&c.device.id))
        || r["hardwareProperties"]["udid"] != c.device.udid
        || r["deviceProperties"]["name"] != c.device.name
    {
        return Err(err("device_mismatch", "기기 이름·ID·UDID 불일치"));
    }
    let h = &r["hardwareProperties"];
    let p = &r["deviceProperties"];
    let conn = &r["connectionProperties"];
    if h["reality"] != "physical" || h["platform"] != "iOS" {
        return Err(err(
            "device_not_physical",
            "iOS 실기기만 사용할 수 있습니다",
        ));
    }
    if conn["pairingState"] != "paired"
        || conn["tunnelState"] != "connected"
        || p["bootState"] != "booted"
        || p["developerModeStatus"] != "enabled"
        || p["ddiServicesAvailable"] != true
    {
        return Err(err("device_not_ready", "기기 연결·개발자 모드 확인 필요"));
    }
    Ok(())
}
pub fn inspect_unlocked(v: &Value, c: &Config) -> Result<()> {
    let r = &v["result"];
    if !r["deviceIdentifier"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case(&c.device.id))
    {
        return Err(err("device_mismatch", "잠금 검사 대상 불일치"));
    }
    if r["unlockedSinceBoot"] != true || r["passcodeRequired"] != false {
        return Err(err(
            "device_locked",
            "iPhone 잠금을 풀고 다시 실행해 주세요",
        ));
    }
    Ok(())
}
pub fn inspect_summary(s: &Value, c: &Config) -> Result<()> {
    let positive = |v: &Value| v.as_u64().is_some_and(|n| n > 0);
    if s["result"] != "Passed"
        || !positive(&s["totalTestCount"])
        || !positive(&s["passedTests"])
        || s["failedTests"] != 0
        || s["expectedFailures"] != 0
        || !s["testFailures"].as_array().is_some_and(Vec::is_empty)
    {
        return Err(err("device_test_failed", "0개 또는 실패한 XCTest 결과"));
    }
    if !s["devicesAndConfigurations"].as_array().is_some_and(|a| {
        !a.is_empty()
            && a.iter().all(|r| {
                r["device"]["deviceId"] == c.device.udid
                    && r["device"]["deviceName"] == c.device.name
                    && r["device"]["platform"] == "iOS"
                    && r["failedTests"] == 0
                    && r["expectedFailures"] == 0
                    && positive(&r["passedTests"])
            })
    }) {
        return Err(err("device_test_mismatch", "XCTest 실기기 식별 불일치"));
    }
    Ok(())
}
pub fn inspect_png(b: &[u8]) -> Result<(u32, u32)> {
    let invalid = || err("device_capture_invalid", "유효한 새 PNG 캡처가 없습니다");
    if b.len() < 45 || b.len() > 30 * 1024 * 1024 || b[..8] != [137, 80, 78, 71, 13, 10, 26, 10] {
        return Err(invalid());
    }
    let u32at = |i: usize| u32::from_be_bytes(b[i..i + 4].try_into().expect("bounded chunk"));
    let (w, h) = (u32at(16), u32at(20));
    if !(1..=16384).contains(&w) || !(1..=16384).contains(&h) {
        return Err(invalid());
    }
    let mut pos = 8;
    let mut pixels = false;
    while pos + 12 <= b.len() {
        let len = u32at(pos) as usize;
        let end = pos + 12 + len;
        if end > b.len() {
            return Err(invalid());
        }
        let kind = &b[pos + 4..pos + 8];
        if (pos == 8 && (kind != b"IHDR" || len != 13)) || (pos != 8 && kind == b"IHDR") {
            return Err(invalid());
        }
        let mut crc = 0xffffffffu32;
        for byte in &b[pos + 4..end - 4] {
            crc ^= *byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    0xedb88320 ^ (crc >> 1)
                } else {
                    crc >> 1
                };
            }
        }
        if crc ^ 0xffffffff != u32at(end - 4) {
            return Err(invalid());
        }
        if kind == b"IDAT" && len > 0 {
            pixels = true;
        }
        if kind == b"IEND" {
            return if len == 0 && end == b.len() && pixels {
                Ok((w, h))
            } else {
                Err(invalid())
            };
        }
        pos = end;
    }
    Err(invalid())
}
