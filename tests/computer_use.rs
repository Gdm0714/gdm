//! Native computer-use security regressions. Uses in-memory RFB and subprocess stdio only.
//! These tests never clone, boot, attach to, or provision a Tart guest.
use gdm::computer_use::{
    action::{Action, Button},
    process::{Owned, capture},
    rfb::{Frame, Rfb, apple_password, challenge_response},
};
use serde_json::{Value, json};
use std::{
    io::{self, Cursor, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[derive(Default)]
struct Wire {
    writes: Vec<Vec<u8>>,
    fail_write: Option<(u8, u8)>,
    fail_key_release: Option<u32>,
    fail_flush: Option<(u8, u8)>,
    flush_pending: bool,
}
#[derive(Clone, Default)]
struct Writer(Arc<Mutex<Wire>>);
impl Writer {
    fn packets(&self) -> Vec<Vec<u8>> {
        self.0.lock().unwrap().writes.clone()
    }
    fn clear(&self) {
        self.0.lock().unwrap().writes.clear();
    }
    fn fail_release_once(&self, type_: u8) {
        self.0.lock().unwrap().fail_write = Some((type_, 0));
    }
    fn fail_press_flush_once(&self, type_: u8) {
        self.0.lock().unwrap().fail_flush = Some((type_, 1));
    }
    fn fail_key_release_once(&self, key: u32) {
        self.0.lock().unwrap().fail_key_release = Some(key);
    }
}
impl Write for Writer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut wire = self.0.lock().unwrap();
        let prefix = buf.first().copied().zip(buf.get(1).copied());
        if prefix == Some((4, 0))
            && buf.len() == 8
            && wire
                .fail_key_release
                .is_some_and(|key| buf[4..] == key.to_be_bytes())
        {
            wire.fail_key_release = None;
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected one-shot modifier release failure",
            ));
        }
        if prefix == wire.fail_write && wire.fail_write.is_some() {
            wire.fail_write = None;
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected one-shot write failure",
            ));
        }
        wire.writes.push(buf.to_vec());
        if prefix == wire.fail_flush && wire.fail_flush.is_some() {
            wire.fail_flush = None;
            wire.flush_pending = true;
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        let mut wire = self.0.lock().unwrap();
        if wire.flush_pending {
            wire.flush_pending = false;
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected delivered-write flush failure",
            ))
        } else {
            Ok(())
        }
    }
}
fn init(width: u16, height: u16, name_len: u32) -> Vec<u8> {
    let mut b = vec![0; 24];
    b[..2].copy_from_slice(&width.to_be_bytes());
    b[2..4].copy_from_slice(&height.to_be_bytes());
    b[4] = 32;
    b[5] = 24;
    b[7] = 1;
    for offset in [8, 10, 12] {
        b[offset..offset + 2].copy_from_slice(&255u16.to_be_bytes());
    }
    b[14] = 16;
    b[15] = 8;
    b[20..24].copy_from_slice(&name_len.to_be_bytes());
    b
}
fn handshake(width: u16, height: u16) -> Vec<u8> {
    let mut b = b"RFB 003.008\n".to_vec();
    b.extend([1, 2]);
    b.extend(0u8..16);
    b.extend([0, 0, 0, 0]);
    b.extend(init(width, height, 0));
    b
}
fn update(x: u16, y: u16, width: u16, height: u16, encoding: i32, pixels: &[u8]) -> Vec<u8> {
    let mut b = vec![0, 0, 0, 1];
    for n in [x, y, width, height] {
        b.extend(n.to_be_bytes());
    }
    b.extend(encoding.to_be_bytes());
    b.extend(pixels);
    b
}
fn connected(width: u16, height: u16, tail: Vec<u8>) -> (Rfb<Cursor<Vec<u8>>, Writer>, Writer) {
    let mut bytes = handshake(width, height);
    bytes.extend(tail);
    let writer = Writer::default();
    let client = Rfb::connect(Cursor::new(bytes), writer.clone(), b"testpass").unwrap();
    (client, writer)
}
#[test]
fn native_authentication_matches_known_vectors_and_all_password_bytes() {
    assert_eq!(
        String::from_utf8(apple_password(b"gdmtest1").unwrap()).unwrap(),
        "70503C1AEEDBB1D3FF1C39567390ADCA"
    );
    let challenge = (0u8..16).collect::<Vec<_>>();
    assert_eq!(
        hex::encode(challenge_response(b"secret", &challenge).unwrap()),
        "ee22539f33a5983ec12f9c2edbc995dd"
    );
    let binary = [0x00, 0x11, 0x22, 0x33, 0x88, 0xaa, 0xdd, 0xff];
    assert_eq!(challenge_response(&binary, &challenge).unwrap().len(), 16);
    assert!(apple_password(&[0; 9]).is_err());
    assert!(challenge_response(b"password", &[0; 15]).is_err());
}
#[test]
fn authenticated_handshake_pixels_png_and_input_wire_sequences() {
    let pixels = [0, 0, 255, 0, 0, 255, 0, 0];
    let (mut client, writer) = connected(2, 1, update(0, 0, 2, 1, 0, &pixels));
    let packets = writer.packets();
    assert_eq!(packets[0], b"RFB 003.008\n");
    assert_eq!(packets[1], [2]);
    assert_eq!(
        packets[2],
        challenge_response(b"testpass", &(0u8..16).collect::<Vec<_>>()).unwrap()
    );
    assert_eq!(
        packets[4],
        [
            0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0
        ]
    );
    assert_eq!(packets[5], [2, 0, 0, 2, 0, 0, 0, 0, 255, 255, 255, 33]);
    let frame = client.screenshot().unwrap();
    assert_eq!((frame.width, frame.height), (2, 1));
    assert_eq!(frame.rgba, [255, 0, 0, 255, 0, 255, 0, 255]);
    assert_eq!(&frame.png().unwrap()[..8], b"\x89PNG\r\n\x1a\n");
    writer.clear();
    client
        .action(&Action::Click {
            x: 1,
            y: 0,
            button: Button::Left,
            click_count: 1,
        })
        .unwrap();
    client
        .action(&Action::TypeText { text: "A\n".into() })
        .unwrap();
    client
        .action(&Action::PressKey {
            key: "left".into(),
            modifiers: vec!["cmd".into()],
        })
        .unwrap();
    client
        .action(&Action::Scroll {
            x: 1,
            y: 0,
            dx: 0,
            dy: 1,
        })
        .unwrap();
    client.release_all();
    let packets = writer.packets();
    assert_eq!(packets[0], [5, 1, 0, 1, 0, 0]);
    assert_eq!(packets[1], [5, 0, 0, 1, 0, 0]);
    assert!(packets.contains(&vec![4, 1, 0, 0, 0, 0, 0, 65]));
    assert!(packets.contains(&vec![4, 0, 0, 0, 0, 0, 0, 65]));
    assert!(packets.contains(&vec![4, 1, 0, 0, 0, 0, 255, 235]));
    assert!(packets.contains(&vec![4, 0, 0, 0, 0, 0, 255, 235]));
    assert!(packets.contains(&vec![5, 8, 0, 1, 0, 0]));
    assert_eq!(packets.last().unwrap(), &vec![5, 0, 0, 1, 0, 0]);
}
#[test]
fn rejects_unauthenticated_wrong_auth_and_oversized_initialization() {
    for tail in [vec![1, 1], vec![0]] {
        let mut b = b"RFB 003.008\n".to_vec();
        b.extend(tail);
        assert!(Rfb::connect(Cursor::new(b), Writer::default(), b"testpass").is_err());
    }
    let mut wrong = handshake(2, 1);
    wrong[33] = 1;
    assert!(Rfb::connect(Cursor::new(wrong), Writer::default(), b"testpass").is_err());
    for (w, h) in [(0, 1), (1, 0), (4097, 1), (1, 2561), (30000, 30000)] {
        assert!(
            Rfb::connect(Cursor::new(handshake(w, h)), Writer::default(), b"testpass").is_err()
        );
    }
    let mut name = handshake(2, 1);
    let offset = name.len() - 4;
    name[offset..].copy_from_slice(&4097u32.to_be_bytes());
    assert!(Rfb::connect(Cursor::new(name), Writer::default(), b"testpass").is_err());
}
#[test]
fn bounds_updates_clipboard_encodings_and_rectangle_counts() {
    let cases = [
        update(0, 0, 3, 1, 0, &[]),
        update(1, 0, 2, 1, 0, &[]),
        update(0, 0, 1, 1, 16, &[]),
        update(1, 0, 2, 1, -223, &[]),
        update(0, 0, 4097, 1, -223, &[]),
        vec![0, 0, 0, 65],
        vec![99],
        {
            let mut b = vec![3, 0, 0, 0];
            b.extend(32769u32.to_be_bytes());
            b
        },
    ];
    for bytes in cases {
        let (mut client, _) = connected(2, 1, bytes);
        assert!(client.screenshot().is_err());
    }
}
#[test]
fn rejects_entire_invalid_action_before_sending_any_input() {
    let (mut client, writer) = connected(2, 1, vec![]);
    writer.clear();
    for action in [
        Action::TypeText {
            text: "valid한글".into(),
        },
        Action::Click {
            x: 2,
            y: 0,
            button: Button::Left,
            click_count: 1,
        },
        Action::Click {
            x: 0,
            y: 0,
            button: Button::Left,
            click_count: 3,
        },
        Action::Scroll {
            x: 0,
            y: 0,
            dx: 21,
            dy: 0,
        },
        Action::Drag {
            x: 0,
            y: 0,
            to_x: 2,
            to_y: 0,
            button: Button::Left,
        },
        Action::PressKey {
            key: "escape".into(),
            modifiers: vec!["unsafe".into()],
        },
    ] {
        assert!(client.action(&action).is_err());
        assert!(writer.packets().is_empty());
    }
    for raw in [
        json!({"action":"shell","command":"true"}),
        json!({"action":"click","x":0.5,"y":0}),
        json!({"action":"click","x":0,"y":0,"command":"true"}),
        json!({"action":"type_text"}),
        json!({"action":"open_app","app":"Terminal; ls"}),
    ] {
        let parsed = serde_json::from_value::<Action>(raw);
        assert!(parsed.is_err() || parsed.unwrap().validate().is_err());
    }
}
#[test]
fn keyboard_and_mouse_release_after_transient_transport_errors() {
    for (action, message_type) in [
        (Action::TypeText { text: "A".into() }, 4),
        (
            Action::Click {
                x: 1,
                y: 0,
                button: Button::Left,
                click_count: 1,
            },
            5,
        ),
    ] {
        let (mut client, writer) = connected(2, 1, vec![]);
        writer.clear();
        writer.fail_release_once(message_type);
        assert!(client.action(&action).is_err());
        let packets = writer.packets();
        assert!(packets.iter().any(|p| p[0] == message_type && p[1] == 1));
        assert_eq!(packets.last().unwrap()[..2], [message_type, 0]);
    }
    for (action, message_type) in [
        (Action::TypeText { text: "A".into() }, 4),
        (
            Action::Click {
                x: 1,
                y: 0,
                button: Button::Left,
                click_count: 1,
            },
            5,
        ),
    ] {
        let (mut client, writer) = connected(2, 1, vec![]);
        writer.clear();
        writer.fail_press_flush_once(message_type);
        assert!(client.action(&action).is_err());
        let packets = writer.packets();
        assert_eq!(packets[0][..2], [message_type, 1]);
        assert_eq!(packets.last().unwrap()[..2], [message_type, 0]);
    }
}
#[test]
fn modifiers_and_drag_are_released_on_failure() {
    let (mut client, writer) = connected(40, 2, vec![]);
    writer.clear();
    writer.fail_release_once(4);
    assert!(
        client
            .action(&Action::PressKey {
                key: "a".into(),
                modifiers: vec!["cmd".into(), "shift".into()]
            })
            .is_err()
    );
    let packets = writer.packets();
    for key in [97u32, 0xffeb, 0xffe1] {
        assert!(
            packets
                .iter()
                .any(|p| p[0] == 4 && p[1] == 0 && p[4..] == key.to_be_bytes())
        );
    }
    writer.clear();
    writer.fail_release_once(5);
    assert!(
        client
            .action(&Action::Drag {
                x: 0,
                y: 0,
                to_x: 30,
                to_y: 0,
                button: Button::Left
            })
            .is_err()
    );
    assert_eq!(writer.packets().last().unwrap()[..2], [5, 0]);
}
#[test]
fn modifier_release_failure_is_reported_and_retried() {
    let (mut client, writer) = connected(2, 1, vec![]);
    writer.clear();
    writer.fail_key_release_once(0xffeb);
    assert!(
        client
            .action(&Action::PressKey {
                key: "a".into(),
                modifiers: vec!["cmd".into(), "shift".into()]
            })
            .is_err()
    );
    for key in [97u32, 0xffeb, 0xffe1] {
        assert!(
            writer
                .packets()
                .iter()
                .any(|p| p[0] == 4 && p[1] == 0 && p[4..] == key.to_be_bytes())
        );
    }
}
#[test]
fn png_rejects_invalid_pixel_lengths_and_fingerprint_binds_dimensions() {
    let a = Frame {
        width: 2,
        height: 1,
        rgba: vec![0; 8],
    };
    let b = Frame {
        width: 1,
        height: 2,
        rgba: vec![0; 8],
    };
    assert_ne!(a.fingerprint(), b.fingerprint());
    assert!(
        Frame {
            width: 2,
            height: 2,
            rgba: vec![0; 1]
        }
        .png()
        .is_err()
    );
}
fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_gdm")
}
fn native(
    args: &[&str],
    input: Vec<u8>,
    cap: usize,
) -> gdm::support::Result<gdm::computer_use::process::Output> {
    let mut c = Command::new(binary());
    c.args(args)
        .env("GDM_TART_PATH", "/nonexistent/gdm-test-must-not-start-tart")
        .env_remove("TYPESAFE_API_KEY");
    capture(c, input, Duration::from_secs(10), cap)
}
fn responses(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
#[test]
fn native_stdio_rejects_unknown_actions_and_recovers_after_bad_json() {
    let input=b"not-json\n{\"id\":1,\"params\":{\"action\":\"exec\",\"command\":\"true\"}}\n{\"id\":2,\"params\":{\"action\":\"stop\"}}\n".to_vec();
    let result = native(&["computer-use", "serve"], input, 65536).unwrap();
    assert_eq!(
        result.code,
        0,
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let values = responses(&result.stdout);
    assert_eq!(values.len(), 3);
    assert_eq!(values[0]["error"]["code"], -32700);
    assert_eq!(values[1]["id"], 1);
    assert!(values[1].get("error").is_some());
    assert_eq!(values[2]["id"], 2);
    assert!(
        values[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("stopped")
    );
}
#[test]
fn native_mcp_handshake_tool_list_and_fail_closed_calls() {
    let requests = [
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gdm_computer_use","arguments":{"action":"shell","command":"true"}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"gdm_computer_choose","arguments":{"goal":"fixture","observation":"screen","observation_sha256":"a".repeat(64),"candidates":[{"id":"one","description":"click","action":{"action":"click","x":0,"y":0}}]}}}),
        json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"gdm_computer_use","arguments":{"action":"stop"}}}),
    ];
    let input = requests
        .iter()
        .map(|v| format!("{v}\n"))
        .collect::<String>()
        .into_bytes();
    let result = native(&["computer-use", "mcp"], input, 65536).unwrap();
    assert_eq!(
        result.code,
        0,
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let out = responses(&result.stdout);
    assert_eq!(out.len(), 6);
    assert!(out[0].get("error").is_some());
    assert_eq!(out[1]["result"]["serverInfo"]["name"], "gdm-computer-use");
    let tools = out[2]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 3);
    assert!(tools.iter().any(|t| t["name"] == "gdm_computer_step"));
    assert!(
        tools
            .iter()
            .all(|tool| tool["inputSchema"]["additionalProperties"] == false)
    );
    assert_eq!(out[3]["result"]["isError"], true);
    assert_eq!(out[4]["result"]["isError"], true);
    assert!(
        out[4].to_string().contains("observation") || out[4].to_string().contains("screenshot")
    );
    assert!(out[5]["result"].get("isError").is_none());
}
#[test]
fn native_rejects_oversized_stdin_without_starting_a_guest() {
    let result = native(
        &["computer-use", "serve"],
        vec![b'x'; 1024 * 1024 + 2],
        65536,
    )
    .unwrap();
    assert_ne!(result.code, 0);
    assert!(String::from_utf8_lossy(&result.stderr).contains("1 MiB"));
}
#[test]
fn setup_help_and_invalid_options_do_not_inspect_or_change_host() {
    let help = native(&["computer-use", "setup", "--help"], vec![], 65536).unwrap();
    assert_eq!(help.code, 0);
    assert!(String::from_utf8_lossy(&help.stdout).contains("performed manually"));
    let invalid = native(&["computer-use", "setup", "--install-host"], vec![], 65536).unwrap();
    assert_ne!(invalid.code, 0);
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("accepts only"));
    let pinned = native(&["computer-use", "setup", "--check"], vec![], 65536).unwrap();
    assert_ne!(pinned.code, 0);
    let error = String::from_utf8_lossy(&pinned.stderr);
    assert!(error.contains("pinned") || error.contains("requires macOS"));
}
#[test]
fn native_eof_and_signal_shutdown_do_not_require_a_vm() {
    let empty = native(&["computer-use", "mcp"], vec![], 65536).unwrap();
    assert_eq!(empty.code, 0);
    let mut c = Command::new(binary());
    c.args(["computer-use", "serve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GDM_TART_PATH", "/nonexistent/gdm-test-must-not-start-tart");
    let mut owned = Owned::spawn(&mut c).unwrap();
    let start = Instant::now();
    let mut stdin = owned.child.stdin.take().unwrap();
    stdin
        .write_all(b"{\"id\":1,\"params\":{\"action\":\"stop\"}}\n")
        .unwrap();
    let stdout = owned.child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let mut reader = std::io::BufReader::new(stdout);
        let result = std::io::BufRead::read_line(&mut reader, &mut line);
        let _ = tx.send((result, line));
    });
    let (result, line) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("native service must start and reply before shutdown");
    result.unwrap();
    assert!(line.contains("stopped"));
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(owned.child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    loop {
        if let Some(code) = owned.exit_code().unwrap() {
            assert_eq!(code, 0);
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(7));
        std::thread::sleep(Duration::from_millis(20));
    }
    owned.stop();
    drop(stdin);
}
