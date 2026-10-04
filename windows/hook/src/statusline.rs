//! `coucou-hook --statusline`: Claude Code's status line command.
//!
//! Hands the plan's `rate_limits` to Coucou, then runs whatever status line the
//! user had before Coucou took the slot, so it keeps showing exactly as it did.
//! Same rule as the hooks: Coucou being closed or slow never holds Claude Code up.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::connect;

/// Whole budget for reaching Coucou.
const RELAY_BUDGET: Duration = Duration::from_millis(500);
/// The previous status line gets as long as Claude Code would give it.
const PREVIOUS_BUDGET: Duration = Duration::from_secs(10);

pub fn run() {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return;
    }
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    if let Some(line) = relay_line(&raw) {
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            if let Some(mut pipe) = connect() {
                let _ = pipe.write_all(line.as_bytes());
                let _ = pipe.flush();
            }
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(RELAY_BUDGET);
    }

    if let Some(output) = run_previous(&raw) {
        let mut out = std::io::stdout();
        let _ = out.write_all(&output);
        let _ = out.flush();
    }
}

/// Only what the plan gauge needs crosses over: the session and its limits.
fn relay_line(raw: &[u8]) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_slice(raw).ok()?;
    let limits = payload.get("rate_limits")?.clone();
    let relay = serde_json::json!({
        "coucou_kind": "statusline",
        "session_id": payload.get("session_id").cloned().unwrap_or_default(),
        "rate_limits": limits,
    });
    Some(format!("{relay}\n"))
}

/// Saved by the app next to bin/ when it took over someone else's status line.
fn previous_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.parent()?.join("statusline-previous.json"))
}

fn run_previous(raw: &[u8]) -> Option<Vec<u8>> {
    let text = std::fs::read(previous_path()?).ok()?;
    let previous: serde_json::Value = serde_json::from_slice(&text).ok()?;
    let command = previous.get("command")?.as_str()?.trim().to_string();
    if command.is_empty() {
        return None;
    }

    // Claude Code runs status line commands through sh (Git Bash on Windows).
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let input = raw.to_vec();
    std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let mut stdout = child.stdout.take()?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(PREVIOUS_BUDGET) {
        Ok(buf) => {
            let _ = child.wait();
            Some(buf)
        }
        Err(_) => {
            let _ = child.kill();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::relay_line;

    #[test]
    fn only_the_limits_and_session_are_relayed() {
        let raw = br#"{"session_id":"s1","cwd":"/secret","model":{"id":"x"},"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1}}}"#;
        let line = relay_line(raw).unwrap();
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["coucou_kind"], "statusline");
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["rate_limits"]["five_hour"]["used_percentage"], 12);
        assert!(v.get("cwd").is_none());
    }

    #[test]
    fn no_limits_means_nothing_to_relay() {
        assert!(relay_line(br#"{"session_id":"s1"}"#).is_none());
        assert!(relay_line(b"not json").is_none());
    }
}
