// "Send by email" for a dropped file — port of MailView.sendMail() in
// IslandViewContent.swift. Resend sends it when a key and a sender address are
// set; otherwise the desktop's mail client opens a draft (Linux), which the user
// sends themselves.
//
// Only ever called from the Send button: nothing here sends on its own.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;

use crate::{files, platform, secrets};

/// Resend refuses attachments over 40 MB once base64-encoded.
const MAX_ATTACHMENT: u64 = 28 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MailOutcome {
    /// Resend accepted the message.
    Sent,
    /// A draft is open in the mail client.
    Drafted,
}

/// One address, nothing a shell or a command line could read as anything else.
fn valid_recipient(to: &str) -> bool {
    let Some((local, domain)) = to.split_once('@') else { return false };
    !local.is_empty()
        && domain.contains('.')
        && !to.starts_with('-')
        && to.len() <= 254
        && !to.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ',' | ';' | '<' | '>' | '"'))
}

/// The attachment must be a file Coucou copied into its own inbox, so the page
/// can't have an arbitrary path mailed out.
fn inbox_file(path: &str) -> Result<PathBuf, String> {
    let inbox = std::fs::canonicalize(files::inbox_dir()).map_err(|_| "The file is gone.".to_string())?;
    let file = std::fs::canonicalize(path).map_err(|_| "The file is gone.".to_string())?;
    if !file.starts_with(&inbox) || !file.is_file() {
        return Err("Only a dropped file can be attached.".into());
    }
    Ok(file)
}

pub async fn send(
    to: &str,
    subject: &str,
    body: &str,
    attachment: Option<&str>,
) -> Result<MailOutcome, String> {
    let to = to.trim();
    if to.is_empty() {
        return Err("Missing recipient.".into());
    }
    if !valid_recipient(to) {
        return Err("That doesn't look like an email address.".into());
    }
    let file = attachment.map(inbox_file).transpose()?;

    match (secrets::get("resend-api-key"), secrets::get("resend-from")) {
        (Some(key), Some(from)) => {
            send_via_resend(&key, &from, to, subject, body, file.as_deref()).await?;
            Ok(MailOutcome::Sent)
        }
        (Some(_), None) => Err("Set sender address in Settings.".into()),
        _ => {
            platform::compose_mail(to, subject, body, file.as_deref())?;
            Ok(MailOutcome::Drafted)
        }
    }
}

async fn send_via_resend(
    key: &str,
    from: &str,
    to: &str,
    subject: &str,
    body: &str,
    file: Option<&Path>,
) -> Result<(), String> {
    let mut payload = json!({
        "from": from,
        "to": [to],
        "subject": subject,
        "text": if body.is_empty() { " " } else { body },
    });
    if let Some(file) = file {
        let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        if size > MAX_ATTACHMENT {
            return Err("The file is too large to send by email.".into());
        }
        let bytes = std::fs::read(file).map_err(|e| format!("Couldn't read the file: {e}"))?;
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        payload["attachments"] = json!([{ "filename": name, "content": crate::claude::base64_for(&bytes) }]);
    }

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?
        .post("https://api.resend.com/emails")
        .bearer_auth(key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    crate::log::line(format!("resend: HTTP {}", response.status()));
    Err("Resend error — check API key & sender.".into())
}

#[cfg(test)]
mod tests {
    use super::valid_recipient;

    #[test]
    fn only_a_single_plain_address_passes() {
        assert!(valid_recipient("ada@example.com"));
        assert!(valid_recipient("first.last+tag@sub.example.org"));
        assert!(!valid_recipient("-attach=/etc/passwd@x.io"));
        assert!(!valid_recipient("a@b.c, c@d.e"));
        assert!(!valid_recipient("a b@c.de"));
        assert!(!valid_recipient("nobody"));
        assert!(!valid_recipient("@example.com"));
        assert!(!valid_recipient("Ada <ada@example.com>"));
    }
}
