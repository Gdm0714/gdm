use crate::support::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Status,
    Start,
    Stop,
    Screenshot,
    GetState,
    Click {
        x: u16,
        y: u16,
        #[serde(default)]
        button: Button,
        #[serde(default = "one", rename = "clickCount")]
        click_count: u8,
    },
    TypeText {
        text: String,
    },
    PressKey {
        key: String,
        #[serde(default)]
        modifiers: Vec<String>,
    },
    Scroll {
        x: u16,
        y: u16,
        dx: i16,
        dy: i16,
    },
    Drag {
        x: u16,
        y: u16,
        #[serde(rename = "toX")]
        to_x: u16,
        #[serde(rename = "toY")]
        to_y: u16,
        #[serde(default)]
        button: Button,
    },
    OpenApp {
        app: String,
    },
}
fn one() -> u8 {
    1
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    #[default]
    Left,
    Right,
    Middle,
}
impl Button {
    pub fn mask(self) -> u8 {
        match self {
            Self::Left => 1,
            Self::Middle => 2,
            Self::Right => 4,
        }
    }
}
impl Action {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Click { click_count, .. } if !matches!(click_count, 1 | 2) => {
                return Err(Error::new("usage", "clickCount must be 1 or 2"));
            }
            Self::TypeText { text } => {
                text_keys(text)?;
            }
            Self::PressKey { key, modifiers } => {
                named_key(key)?;
                modifier_keys(modifiers)?;
            }
            Self::Scroll { dx, dy, .. } if !(-20..=20).contains(dx) || !(-20..=20).contains(dy) => {
                return Err(Error::new("usage", "scroll ticks must be from -20 to 20"));
            }
            Self::OpenApp { app }
                if app.is_empty()
                    || app.len() > 64
                    || !app
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || " ._-".contains(c)) =>
            {
                return Err(Error::new("usage", "unsupported guest app name"));
            }
            _ => {}
        }
        Ok(())
    }
    pub fn candidate_allowed(&self) -> bool {
        matches!(
            self,
            Self::Click { .. }
                | Self::TypeText { .. }
                | Self::PressKey { .. }
                | Self::Scroll { .. }
                | Self::Drag { .. }
                | Self::OpenApp { .. }
        )
    }
}
pub fn text_keys(text: &str) -> Result<Vec<u32>> {
    if text.is_empty() || text.chars().count() > 2000 {
        return Err(Error::new(
            "usage",
            "guest text must contain 1 to 2000 characters",
        ));
    }
    text.chars()
        .map(|c| match c {
            '\n' => Ok(0xff0d),
            '\t' => Ok(0xff09),
            ' '..='~' => Ok(c as u32),
            _ => Err(Error::new(
                "usage",
                "guest typing currently supports printable ASCII, newline and tab",
            )),
        })
        .collect()
}
pub fn named_key(name: &str) -> Result<u32> {
    let n = name.to_ascii_lowercase();
    if n.len() == 1 && n.as_bytes()[0].is_ascii_graphic() {
        return Ok(n.as_bytes()[0] as u32);
    }
    Ok(match n.as_str() {
        "backspace" => 0xff08,
        "tab" => 0xff09,
        "return" | "enter" => 0xff0d,
        "escape" | "esc" => 0xff1b,
        "delete" => 0xffff,
        "home" => 0xff50,
        "left" => 0xff51,
        "up" => 0xff52,
        "right" => 0xff53,
        "down" => 0xff54,
        "pageup" => 0xff55,
        "pagedown" => 0xff56,
        "end" => 0xff57,
        "space" => 0x20,
        _ => {
            let f = n
                .strip_prefix('f')
                .and_then(|n| n.parse::<u32>().ok())
                .filter(|n| (1..=12).contains(n));
            if let Some(f) = f {
                0xffbd + f
            } else {
                return Err(Error::new("usage", "unsupported guest key"));
            }
        }
    })
}
pub fn modifier_keys(names: &[String]) -> Result<Vec<u32>> {
    if names.len() > 4 {
        return Err(Error::new("usage", "too many modifiers"));
    }
    let mut keys = Vec::new();
    for name in names {
        let k = match name.as_str() {
            "shift" => 0xffe1,
            "ctrl" => 0xffe3,
            "alt" => 0xffe9,
            "cmd" => 0xffeb,
            _ => return Err(Error::new("usage", "unsupported guest modifier")),
        };
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computer_use_rejects_shell_and_extra_fields() {
        assert!(
            serde_json::from_str::<Action>(r#"{"action":"exec","command":"rm -rf /"}"#).is_err()
        );
        assert!(
            serde_json::from_str::<Action>(r#"{"action":"click","x":1,"y":2,"command":"bad"}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<Action>(r#"{"action":"click","x":-1,"y":2}"#).is_err());
    }
    #[test]
    fn computer_use_validates_entire_text_before_typing() {
        assert!(text_keys("safe한글").is_err());
        assert_eq!(text_keys("A\n").unwrap(), vec![65, 0xff0d]);
    }
}
