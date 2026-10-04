// Conversation titles for the session companions. Claude Code writes the title
// it generates (`ai-title`) and the one set with /rename (`custom-title`) into
// the session transcript; the latest of them names the companion.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Titles are repeated through the transcript, so the tail always has one.
const TAIL_BYTES: u64 = 256 * 1024;
const MAX_TITLE_CHARS: usize = 48;

/// Only a transcript under a `.claude` directory is read, whatever the payload
/// says the path is.
fn transcript(path: &str) -> Option<PathBuf> {
    let p = std::fs::canonicalize(path).ok()?;
    let is_jsonl = p.extension().and_then(|e| e.to_str()) == Some("jsonl");
    let under_claude = p.components().any(|c| c.as_os_str() == ".claude");
    (is_jsonl && under_claude && p.is_file()).then_some(p)
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The newest custom title in the tail, else the newest generated one.
fn latest_title(tail: &str) -> Option<String> {
    let mut generated: Option<String> = None;
    for line in tail.lines().rev() {
        if !line.contains("-title\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        match entry.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(t) = entry.get("customTitle").and_then(Value::as_str) {
                    return Some(t.to_string());
                }
            }
            Some("ai-title") if generated.is_none() => {
                generated = entry.get("aiTitle").and_then(Value::as_str).map(str::to_string);
            }
            _ => {}
        }
    }
    generated
}

pub fn session_title(transcript_path: &str) -> Option<String> {
    let title = latest_title(&read_tail(&transcript(transcript_path)?)?)?;
    let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    Some(match title.char_indices().nth(MAX_TITLE_CHARS) {
        Some((cut, _)) => format!("{}…", &title[..cut]),
        None => title,
    })
}

#[cfg(test)]
mod tests {
    use super::latest_title;

    #[test]
    fn a_custom_title_beats_newer_generated_ones() {
        let tail = concat!(
            r#"{"type":"ai-title","aiTitle":"Old"}"#, "\n",
            r#"{"type":"custom-title","customTitle":"Mine"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"Newer"}"#, "\n",
        );
        assert_eq!(latest_title(tail).as_deref(), Some("Mine"));
    }

    #[test]
    fn the_newest_generated_title_wins_otherwise() {
        let tail = concat!(
            r#"{"type":"ai-title","aiTitle":"First"}"#, "\n",
            r#"{"type":"user","message":"mentions \"ai-title\" in text"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"Second"}"#, "\n",
            r#"{"partial line"#,
        );
        assert_eq!(latest_title(tail).as_deref(), Some("Second"));
        assert_eq!(latest_title(r#"{"type":"user"}"#), None);
    }
}
