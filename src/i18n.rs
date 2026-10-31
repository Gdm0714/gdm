//! Localizes GDM-owned messages only. Commands, evidence and user text stay intact.
use std::{path::PathBuf, sync::OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Korean,
    English,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preference {
    Auto,
    Korean,
    English,
}

impl Preference {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "auto" => Ok(Self::Auto),
            "ko" => Ok(Self::Korean),
            "en" => Ok(Self::English),
            _ => Err(
                "Language must be auto, ko or en / 언어는 auto, ko, en 중 하나여야 합니다".into(),
            ),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Korean => "ko",
            Self::English => "en",
        }
    }
}

static LANGUAGE: OnceLock<Language> = OnceLock::new();
#[cfg(test)]
thread_local! { static TEST_LANGUAGE: std::cell::Cell<Option<Language>> = const { std::cell::Cell::new(None) }; }

pub fn from_locale(value: &str) -> Language {
    let code = value
        .trim()
        .split(['_', '-', '.', '@'])
        .next()
        .unwrap_or("");
    if code.eq_ignore_ascii_case("ko") {
        Language::Korean
    } else {
        Language::English
    }
}
fn system_language() -> Language {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            return from_locale(&value);
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output()
        && output.status.success()
        && let Some(first) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !matches!(*line, "(" | ")"))
    {
        return from_locale(first.trim_matches(['"', ',', ' ']));
    }
    Language::English
}
pub fn config_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("GDM_CONFIG_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path).join("language"));
    }
    if let Some(path) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path).join("gdm/language"));
    }
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(|p| PathBuf::from(p).join(".config/gdm/language"))
        .ok_or_else(|| "Cannot locate your configuration directory. Set GDM_CONFIG_DIR.".into())
}
fn stored_preference() -> Preference {
    config_path()
        .ok()
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() < 64))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .filter(|s| s.len() < 64)
        .and_then(|s| Preference::parse(s.trim()).ok())
        .unwrap_or(Preference::Auto)
}
pub fn resolve(
    explicit: Option<Preference>,
    environment: Option<Preference>,
    stored: Preference,
    system: Language,
) -> Language {
    match explicit.or(environment).unwrap_or(stored) {
        Preference::Korean => Language::Korean,
        Preference::English => Language::English,
        Preference::Auto => system,
    }
}
pub fn configure(explicit: Option<Preference>) -> Result<(), String> {
    let environment = if explicit.is_some() {
        None
    } else {
        std::env::var("GDM_LANGUAGE")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|v| Preference::parse(&v))
            .transpose()?
    };
    let language = resolve(
        explicit,
        environment,
        stored_preference(),
        system_language(),
    );
    let _ = LANGUAGE.set(language);
    Ok(())
}
pub fn language() -> Language {
    #[cfg(test)]
    {
        TEST_LANGUAGE.with(|v| v.get().unwrap_or(Language::Korean))
    }
    #[cfg(not(test))]
    {
        *LANGUAGE.get_or_init(|| {
            resolve(
                None,
                std::env::var("GDM_LANGUAGE")
                    .ok()
                    .and_then(|v| Preference::parse(&v).ok()),
                stored_preference(),
                system_language(),
            )
        })
    }
}
pub fn korean() -> bool {
    language() == Language::Korean
}
pub fn text(ko: &'static str, en: &'static str) -> &'static str {
    if korean() { ko } else { en }
}
pub fn save_preference(path: &std::path::Path, value: Preference) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Invalid language preference path")?;
    if path.is_symlink() {
        return Err("The language preference cannot be a symbolic link".into());
    }
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    writeln!(file, "{}", value.name()).map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn usage() -> String {
    text(include_str!("usage.txt"), include_str!("usage.en.txt"))
        .replace("{VERSION}", env!("CARGO_PKG_VERSION"))
}

#[macro_export]
macro_rules! lfmt { ($ko:literal, $en:literal $(, $($args:tt)*)?) => { if $crate::i18n::korean() { format!($ko $(, $($args)*)?) } else { format!($en $(, $($args)*)?) } }; }
#[macro_export]
macro_rules! lprint { ($ko:literal, $en:literal $(, $($args:tt)*)?) => { if $crate::i18n::korean() { println!($ko $(, $($args)*)?) } else { println!($en $(, $($args)*)?) } }; }
#[macro_export]
macro_rules! leprint { ($ko:literal, $en:literal $(, $($args:tt)*)?) => { if $crate::i18n::korean() { eprintln!($ko $(, $($args)*)?) } else { eprintln!($en $(, $($args)*)?) } }; }
#[macro_export]
macro_rules! lwrite { ($to:expr, $ko:literal, $en:literal $(, $($args:tt)*)?) => { if $crate::i18n::korean() { write!($to, $ko $(, $($args)*)?) } else { write!($to, $en $(, $($args)*)?) } }; }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locale_fallback_and_precedence() {
        for value in ["ko", "ko_KR.UTF-8", "ko-KR", "KO"] {
            assert_eq!(from_locale(value), Language::Korean);
        }
        for value in ["", "en_US.UTF-8", "C", "ja_JP", "kok_IN"] {
            assert_eq!(from_locale(value), Language::English);
        }
        assert_eq!(
            resolve(
                Some(Preference::Auto),
                Some(Preference::Korean),
                Preference::Korean,
                Language::English
            ),
            Language::English
        );
        assert_eq!(
            resolve(
                Some(Preference::English),
                Some(Preference::Korean),
                Preference::Korean,
                Language::Korean
            ),
            Language::English
        );
        assert_eq!(
            resolve(
                None,
                Some(Preference::English),
                Preference::Korean,
                Language::Korean
            ),
            Language::English
        );
        assert_eq!(
            resolve(None, None, Preference::Korean, Language::English),
            Language::Korean
        );
        assert!(Preference::parse("fr").is_err());
    }
    #[test]
    fn saves_only_the_preference() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("gdm/language");
        std::fs::write(root.path().join("unrelated"), "preserve").unwrap();
        save_preference(&file, Preference::English).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "en\n");
        save_preference(&file, Preference::Auto).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "auto\n");
        assert_eq!(
            std::fs::read_to_string(root.path().join("unrelated")).unwrap(),
            "preserve"
        );
    }
    #[test]
    fn messages_preserve_dynamic_user_content() {
        TEST_LANGUAGE.with(|v| v.set(Some(Language::English)));
        let slug = "한국어-project";
        assert_eq!(
            crate::lfmt!("작업 시작: {slug}", "Work started: {slug}"),
            "Work started: 한국어-project"
        );
        assert!(!usage().contains("작업 증거"));
        TEST_LANGUAGE.with(|v| v.set(None));
    }
}
