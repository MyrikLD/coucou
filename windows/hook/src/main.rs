//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook <EventName>` (the name is also read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);
/// A question gets a little longer; its hook entry allows 130 s.
const QUESTION_BUDGET: Duration = Duration::from_secs(125);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;
/// File edits carry their text whole up to this size, for the island's live
/// diff — the same ceiling the diff itself has.
const MAX_EDIT_LEN: usize = 200 * 1024;
const EDIT_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write"];

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

mod statusline;

fn main() {
    if std::env::args().skip(1).any(|a| a == "--statusline") {
        statusline::run();
        std::process::exit(0);
    }

    // `--ask` is the PreToolUse hook matched on AskUserQuestion: the island
    // answers the question and Claude Code gets the answers as the tool's input.
    let ask = std::env::args().skip(1).any(|a| a == "--ask");

    let Some(Event { line: payload, name: event, questions }) = read_event(ask) else {
        std::process::exit(0)
    };
    if ask && questions.is_none() {
        std::process::exit(0);
    }

    let waits_for_answer = ask || event == "PermissionRequest";
    let budget = if ask {
        QUESTION_BUDGET
    } else if waits_for_answer {
        DECISION_BUDGET
    } else {
        FIRE_AND_FORGET_BUDGET
    };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        let output = match &questions {
            Some(questions) => answers_json(&decision, questions),
            None => decision_json(&decision),
        };
        if let Some(json) = output {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// The documented way to answer AskUserQuestion from a PreToolUse hook: allow
/// the tool with the answers filled into its input. `reply` is the island's
/// `{"answers": {question: label | [labels]}}`; anything else prints nothing.
fn answers_json(reply: &str, questions: &serde_json::Value) -> Option<String> {
    let reply: serde_json::Value = serde_json::from_str(reply.trim()).ok()?;
    let answers = reply.get("answers")?.as_object()?;
    let valid = !answers.is_empty()
        && answers.values().all(|v| match v {
            serde_json::Value::String(s) => !s.is_empty(),
            serde_json::Value::Array(items) => !items.is_empty() && items.iter().all(|i| i.is_string()),
            _ => false,
        });
    if !valid {
        return None;
    }
    Some(
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": { "questions": questions, "answers": answers },
            }
        })
        .to_string(),
    )
}

struct Event {
    /// The payload to forward, one JSON line.
    line: String,
    name: String,
    /// `--ask` only: the AskUserQuestion questions, untruncated, to hand back.
    questions: Option<serde_json::Value>,
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event(ask: bool) -> Option<Event> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    // Parse argv: "coucou-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with coucou_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg.starts_with("--") {
                continue;
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    let questions = if ask && map.get("tool_name").and_then(|v| v.as_str()) == Some("AskUserQuestion") {
        map.insert("coucou_kind".into(), serde_json::Value::String("ask_user_question".into()));
        map.get("tool_input").and_then(|i| i.get("questions")).filter(|q| q.is_array()).cloned()
    } else {
        None
    };

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    // Lets the app walk up to the terminal window this session runs in.
    #[cfg(unix)]
    if let Some(map) = payload.as_object_mut() {
        map.insert("hook_ppid".into(), serde_json::Value::from(std::os::unix::process::parent_id()));
    }

    let is_edit = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .is_some_and(|t| EDIT_TOOLS.contains(&t));
    let edit_input = if is_edit {
        payload.as_object_mut().and_then(|m| m.remove("tool_input"))
    } else {
        None
    };
    truncate_strings(&mut payload, MAX_FIELD_LEN);
    if let Some(mut input) = edit_input {
        truncate_strings(&mut input, MAX_EDIT_LEN);
        if let Some(map) = payload.as_object_mut() {
            map.insert("tool_input".into(), input);
        }
    }

    let mut line = payload.to_string();
    line.push('\n');
    Some(Event { line, name: event, questions })
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value, max: usize) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > max {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = max;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(|v| truncate_strings(v, max)),
        serde_json::Value::Object(map) => map.values_mut().for_each(|v| truncate_strings(v, max)),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn answers_go_back_as_the_tools_input() {
        let questions = serde_json::json!([{ "question": "Which?", "options": [] }]);
        let out = answers_json(r#"{"answers":{"Which?":"A","Many?":["x","y"]}}"#, &questions).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let o = &v["hookSpecificOutput"];
        assert_eq!(o["hookEventName"], "PreToolUse");
        assert_eq!(o["permissionDecision"], "allow");
        assert_eq!(o["updatedInput"]["questions"], questions);
        assert_eq!(o["updatedInput"]["answers"]["Many?"], serde_json::json!(["x", "y"]));
    }

    #[test]
    fn a_malformed_answer_prints_nothing() {
        let q = serde_json::json!([]);
        for bad in ["", "allow", r#"{"answers":{}}"#, r#"{"answers":{"Q":1}}"#, r#"{"answers":{"Q":""}}"#] {
            assert!(answers_json(bad, &q).is_none(), "{bad}");
        }
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v, MAX_FIELD_LEN);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
