// Chat providers besides the Claude client in claude.rs: Google Gemini and
// OpenAI through their OpenAI-compatible endpoints, and local servers (Ollama,
// LM Studio) speaking the same protocol. Port of chatOpenAICompatible() in
// ClaudeService.swift and of LocalChat.swift.
//
// Keys stay on this side of the IPC boundary, like the Claude key.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::claude::{Chat, ChatContext, ChatReply, SYSTEM_PROMPT};
use crate::island::WINDOW_LABEL;
use crate::secrets;
use crate::settings::Settings;

const MAX_TOKENS: u32 = 4096;
/// Text files are inlined into the first message up to this many characters.
const MAX_INLINE_CHARS: usize = 24_000;
/// Streamed replies reach the island at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(66);

const BINARY_EXTS: &[&str] = &["pdf", "jpg", "jpeg", "png", "gif", "webp"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    Anthropic,
    Google,
    OpenAI,
    Ollama,
    LmStudio,
}

impl Provider {
    /// Unknown ids fall back to Claude, so an old settings.json still chats.
    pub fn parse(id: &str) -> Provider {
        match id {
            "google" => Provider::Google,
            "openai" => Provider::OpenAI,
            "ollama" => Provider::Ollama,
            "lmstudio" => Provider::LmStudio,
            _ => Provider::Anthropic,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::Google => "Google",
            Provider::OpenAI => "OpenAI",
            Provider::Ollama => "Ollama",
            Provider::LmStudio => "LM Studio",
        }
    }

    /// Required for the cloud providers; optional for a local server, which
    /// only needs one when it sits behind an authenticating proxy.
    fn key(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic-api-key",
            Provider::Google => "google-api-key",
            Provider::OpenAI => "openai-api-key",
            Provider::Ollama => "ollama-api-key",
            Provider::LmStudio => "lmstudio-api-key",
        }
    }

    fn is_local(self) -> bool {
        matches!(self, Provider::Ollama | Provider::LmStudio)
    }

    /// A local server's models are whatever its owner installed, so there is
    /// no default: one has to be picked.
    pub fn default_model(self) -> &'static str {
        match self {
            Provider::Anthropic => crate::claude::DEFAULT_MODEL,
            Provider::Google => "gemini-2.0-flash",
            Provider::OpenAI => "gpt-4o",
            Provider::Ollama | Provider::LmStudio => "",
        }
    }
}

/// The model the chat uses for `provider`, falling back to its default.
pub fn model_for(settings: &Settings, provider: Provider) -> String {
    let chosen = match provider {
        Provider::Anthropic => &settings.model,
        Provider::Google => &settings.google_model,
        Provider::OpenAI => &settings.openai_model,
        Provider::Ollama => &settings.ollama_model,
        Provider::LmStudio => &settings.lmstudio_model,
    };
    let chosen = chosen.trim();
    if chosen.is_empty() { provider.default_model().to_string() } else { chosen.to_string() }
}

/// Removes trailing slashes and the `/api` or `/v1` people paste from the
/// server's own documentation. Only http(s) URLs are accepted.
pub fn normalise_url(raw: &str) -> Option<String> {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    for suffix in ["/api", "/v1"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.to_string();
        }
    }
    let lower = s.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || s.len() < 10 {
        return None;
    }
    Some(s)
}

/// Base of the OpenAI-compatible API, without a trailing slash.
fn api_root(settings: &Settings, provider: Provider) -> Result<String, String> {
    match provider {
        Provider::Google => Ok("https://generativelanguage.googleapis.com/v1beta/openai".into()),
        Provider::OpenAI => Ok("https://api.openai.com/v1".into()),
        Provider::Ollama | Provider::LmStudio => {
            let raw = if provider == Provider::Ollama { &settings.ollama_url } else { &settings.lmstudio_url };
            normalise_url(raw)
                .map(|base| format!("{base}/v1"))
                .ok_or_else(|| format!("Connect {} in Settings → Chat first.", provider.name()))
        }
        Provider::Anthropic => Err("Claude doesn't use the OpenAI-compatible API.".into()),
    }
}

fn auth_header(provider: Provider) -> Result<String, String> {
    match secrets::get(provider.key()) {
        Some(key) => Ok(format!("Bearer {key}")),
        None if provider.is_local() => Ok("Bearer ollama".into()),
        None => Err(format!("{} API key missing. Configure it in Settings.", provider.name())),
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(timeout).build().map_err(|e| e.to_string())
}

// ── Model lists ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// Models offered in the picker above the chat box, newest first where the API
/// says so. An error is a sentence the picker shows as is.
pub async fn list_models(settings: &Settings, provider: Provider) -> Result<Vec<ModelInfo>, String> {
    match provider {
        Provider::Anthropic => list_anthropic().await,
        Provider::Google | Provider::OpenAI => list_cloud(settings, provider).await,
        Provider::Ollama | Provider::LmStudio => list_local(settings, provider).await,
    }
}

async fn get_json(request: reqwest::RequestBuilder) -> Option<Value> {
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

fn data_items(json: &Value) -> Vec<Value> {
    json.get("data").and_then(Value::as_array).cloned().unwrap_or_default()
}

async fn list_anthropic() -> Result<Vec<ModelInfo>, String> {
    let key = secrets::get("anthropic-api-key")
        .ok_or_else(|| "Add your Anthropic API key in Settings.".to_string())?;
    let json = get_json(
        client(Duration::from_secs(10))?
            .get("https://api.anthropic.com/v1/models?limit=100")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
    )
    .await
    .ok_or_else(|| "Couldn't load the model list.".to_string())?;
    Ok(data_items(&json)
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let label = m.get("display_name").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(ModelInfo { id, label })
        })
        .collect())
}

async fn list_cloud(settings: &Settings, provider: Provider) -> Result<Vec<ModelInfo>, String> {
    let auth = auth_header(provider)?;
    let root = api_root(settings, provider)?;
    let json = get_json(client(Duration::from_secs(10))?.get(format!("{root}/models")).header("Authorization", auth))
        .await
        .ok_or_else(|| "Couldn't load the model list.".to_string())?;

    let excluded: &[&str] = if provider == Provider::Google {
        &["embed", "imagen", "veo", "aqa", "tts", "audio", "live"]
    } else {
        &[
            "embed", "tts", "whisper", "dall-e", "audio", "realtime", "moderat", "codex",
            "computer-use", "transcribe", "image", "sora", "babbage", "davinci", "instruct",
        ]
    };
    let mut models: Vec<(String, i64)> = data_items(&json)
        .iter()
        .filter_map(|m| {
            let raw = m.get("id")?.as_str()?;
            let id = raw.strip_prefix("models/").unwrap_or(raw).to_string();
            let lower = id.to_lowercase();
            if excluded.iter().any(|x| lower.contains(x)) {
                return None;
            }
            Some((id, m.get("created").and_then(Value::as_i64).unwrap_or(0)))
        })
        .collect();
    if provider == Provider::OpenAI {
        models.sort_by(|a, b| b.1.cmp(&a.1));
    }
    Ok(models.into_iter().map(|(id, _)| ModelInfo { label: id.clone(), id }).collect())
}

async fn list_local(settings: &Settings, provider: Provider) -> Result<Vec<ModelInfo>, String> {
    let root = api_root(settings, provider)?;
    let json = get_json(
        client(Duration::from_secs(5))?.get(format!("{root}/models")).header("Authorization", auth_header(provider)?),
    )
    .await
    .ok_or_else(|| unreachable_message(provider))?;
    let excluded = ["embed", "bge-", "all-minilm", "clip", "rerank"];
    let models: Vec<ModelInfo> = data_items(&json)
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let lower = id.to_lowercase();
            if excluded.iter().any(|x| lower.contains(x)) {
                return None;
            }
            Some(ModelInfo { label: id.clone(), id })
        })
        .collect();
    if models.is_empty() {
        return Err(match provider {
            Provider::Ollama => "No chat model installed. Run `ollama pull llama3.2`, then reopen this list.".into(),
            _ => "No model loaded. Load one in LM Studio, then reopen this list.".into(),
        });
    }
    Ok(models)
}

#[derive(Serialize)]
pub struct LocalProbe {
    /// The URL as it will be stored.
    pub url: String,
    pub models: usize,
}

/// Settings → Connect: checks a local server answers with at least one model
/// before its URL is saved. An empty field tries the server's usual address.
pub async fn probe_local(provider: Provider, raw: &str) -> Result<LocalProbe, String> {
    let fallback = if provider == Provider::Ollama { "http://127.0.0.1:11434" } else { "http://127.0.0.1:1234" };
    let candidate = if raw.trim().is_empty() { fallback } else { raw };
    let url = normalise_url(candidate).ok_or_else(|| "Only http:// and https:// URLs are supported.".to_string())?;
    let mut settings = Settings::default();
    if provider == Provider::Ollama {
        settings.ollama_url = url.clone();
    } else {
        settings.lmstudio_url = url.clone();
    }
    let root = api_root(&settings, provider)?;
    let json = get_json(
        client(Duration::from_secs(5))?.get(format!("{root}/models")).header("Authorization", auth_header(provider)?),
    )
    .await
    .ok_or_else(|| format!("Couldn't reach {} at {url}. Is it running, and is the API key right?", provider.name()))?;
    let models = data_items(&json).len();
    if models == 0 {
        return Err(format!("No models yet — download one in {} first.", provider.name()));
    }
    Ok(LocalProbe { url, models })
}

fn unreachable_message(provider: Provider) -> String {
    match provider {
        Provider::Ollama => "Ollama isn't running. Open it, then ask again.".into(),
        _ => "Start the local server in LM Studio, then ask again.".into(),
    }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct ChatDelta {
    text: String,
}

/// One chat turn through an OpenAI-compatible endpoint. Local servers stream,
/// and the visible text reaches the island as `chat-delta` events on the way.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    provider: Provider,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let root = api_root(settings, provider)?;
    let auth = auth_header(provider)?;
    let model = model_for(settings, provider);
    if model.is_empty() {
        return Err("Pick a model above the chat box first.".into());
    }

    let user_text = match (chat.is_empty(), &context) {
        (true, Some(ctx)) => with_context(ctx, &query),
        _ => query,
    };

    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    messages.extend(chat.snapshot().iter().map(simplified));
    messages.push(json!({ "role": "user", "content": user_text }));
    chat.push(json!({ "role": "user", "content": user_text }));

    let result = if provider.is_local() {
        stream(app, &root, &auth, &model, provider, &messages).await
    } else {
        complete(&root, &auth, &model, &messages).await
    };

    match result {
        Ok(text) if !text.is_empty() => {
            chat.push(json!({ "role": "assistant", "content": text }));
            Ok(ChatReply { text })
        }
        Ok(_) => {
            chat.pop();
            Err("No response text.".into())
        }
        Err(err) => {
            chat.pop();
            Err(err)
        }
    }
}

/// File or window context folded into the first message as plain text. Text
/// files are inlined; binary files are only named, as these endpoints take no
/// document blocks.
fn with_context(context: &ChatContext, query: &str) -> String {
    match context {
        ChatContext::Window { app_name, title, url } => {
            let mut prefix = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                prefix.push_str(&format!(", URL: {url}"));
            }
            format!("{prefix}\n\n{query}")
        }
        ChatContext::File { name, path } => {
            let ext = std::path::Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let text = if BINARY_EXTS.contains(&ext.as_str()) {
                None
            } else {
                std::fs::read_to_string(path).ok().filter(|t| !t.is_empty())
            };
            match text {
                Some(text) => format!("File: {name}\n\n{}\n\n{query}", truncate_chars(&text, MAX_INLINE_CHARS)),
                None => format!("File: {name}\n\n{query}"),
            }
        }
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}\n[truncated]", &text[..cut]),
        None => text.to_string(),
    }
}

/// A history entry as these endpoints want it: content as one string. Claude
/// turns carry block arrays (files, tool calls); only their text survives.
fn simplified(message: &Value) -> Value {
    let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
    let content = match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    };
    json!({ "role": role, "content": content })
}

async fn complete(root: &str, auth: &str, model: &str, messages: &[Value]) -> Result<String, String> {
    let body = json!({ "model": model, "max_tokens": MAX_TOKENS, "messages": messages });
    let response = client(Duration::from_secs(90))?
        .post(format!("{root}/chat/completions"))
        .header("Authorization", auth)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(&text).unwrap_or_else(|| format!("HTTP {}", status.as_u16())));
    }
    let json: Value = serde_json::from_str(&text).map_err(|_| "Unexpected response format".to_string())?;
    json.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "Unexpected response format".into())
}

async fn stream(
    app: &AppHandle,
    root: &str,
    auth: &str,
    model: &str,
    provider: Provider,
    messages: &[Value],
) -> Result<String, String> {
    let body = json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_TOKENS });
    let mut response = client(Duration::from_secs(300))?
        .post(format!("{root}/chat/completions"))
        .header("Authorization", auth)
        .json(&body)
        .send()
        .await
        .map_err(|_| unreachable_message(provider))?;

    let status = response.status();
    if status.as_u16() == 404 {
        return Err(format!("{model} isn't installed. Pick another model above the chat box."));
    }
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(error_message(&text).unwrap_or_else(|| format!("HTTP {}", status.as_u16())));
    }

    let mut pending: Vec<u8> = Vec::new();
    let mut accumulated = String::new();
    let mut last_emit = Instant::now().checked_sub(DELTA_INTERVAL).unwrap_or_else(Instant::now);
    while let Some(chunk) = response.chunk().await.map_err(|_| unreachable_message(provider))? {
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            if let Some(delta) = parse_sse_delta(String::from_utf8_lossy(&line).trim_end()) {
                accumulated.push_str(&delta);
            }
        }
        if last_emit.elapsed() >= DELTA_INTERVAL {
            last_emit = Instant::now();
            emit_delta(app, progressive_filter(&accumulated));
        }
    }
    emit_delta(app, progressive_filter(&accumulated));
    Ok(filter_thinking(&accumulated))
}

fn emit_delta(app: &AppHandle, text: String) {
    let _ = app.emit_to(WINDOW_LABEL, "chat-delta", ChatDelta { text });
}

/// The API's own `error.message`, which is what makes a bad key obvious.
fn error_message(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `delta.content` from one SSE line; None for anything else, `[DONE]` included.
fn parse_sse_delta(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data: ")?;
    if payload == "[DONE]" {
        return None;
    }
    let json: Value = serde_json::from_str(payload).ok()?;
    json.pointer("/choices/0/delta/content").and_then(Value::as_str).map(str::to_string)
}

/// Drops completed `<think>…</think>` blocks (reasoning models like DeepSeek-R1).
fn filter_thinking(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        let Some(len) = rest[start..].find("</think>") else { break };
        out.push_str(&rest[..start]);
        rest = &rest[start + len + "</think>".len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// While streaming, a `<think>` block that hasn't closed yet stays hidden too.
fn progressive_filter(text: &str) -> String {
    let cleaned = filter_thinking(text);
    match cleaned.find("<think>") {
        Some(open) => cleaned[..open].trim().to_string(),
        None => cleaned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_lose_doc_suffixes_and_need_a_scheme() {
        assert_eq!(normalise_url("http://localhost:11434/"), Some("http://localhost:11434".into()));
        assert_eq!(normalise_url(" http://localhost:11434/v1 "), Some("http://localhost:11434".into()));
        assert_eq!(normalise_url("http://localhost:1234/api/"), Some("http://localhost:1234".into()));
        assert_eq!(normalise_url("localhost:11434"), None);
        assert_eq!(normalise_url("file:///etc/passwd"), None);
        assert_eq!(normalise_url(""), None);
    }

    #[test]
    fn sse_lines_yield_only_content_deltas() {
        assert_eq!(
            parse_sse_delta(r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#),
            Some("Hi".into())
        );
        assert_eq!(parse_sse_delta("data: [DONE]"), None);
        assert_eq!(parse_sse_delta(r#"data: {"choices":[{"delta":{}}]}"#), None);
        assert_eq!(parse_sse_delta(": keep-alive"), None);
    }

    #[test]
    fn think_blocks_are_hidden_closed_or_open() {
        assert_eq!(filter_thinking("<think>hmm</think>Answer"), "Answer");
        assert_eq!(filter_thinking("A<think>x</think>B<think>y</think>C"), "ABC");
        assert_eq!(progressive_filter("Sure. <think>still going"), "Sure.");
        assert_eq!(progressive_filter("<think>still going"), "");
    }

    #[test]
    fn claude_history_keeps_all_its_text() {
        let turn = json!({ "role": "user", "content": [
            { "type": "document", "source": {} },
            { "type": "text", "text": "File: a.pdf" },
            { "type": "text", "text": "What is it?" },
        ]});
        assert_eq!(simplified(&turn)["content"], "File: a.pdf\n\nWhat is it?");
    }

    #[test]
    fn inline_text_is_cut_on_a_char_boundary() {
        assert_eq!(truncate_chars("héllo", 2), "hé\n[truncated]");
        assert_eq!(truncate_chars("hé", 5), "hé");
    }
}
