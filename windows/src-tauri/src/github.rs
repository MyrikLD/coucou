// GitHub — port of GithubPoller.swift, GitHubPulse.swift and GitHubActivity.swift.
//
// Three requests, merged into the one `integration_github` card:
//   * stats    — repositories and stars, every 5 minutes;
//   * pulse    — my open PRs with their CI, PRs waiting for my review, and the
//                default-branch CI of my latest repositories (GraphQL), every
//                minute while a CI runs and every 5 minutes otherwise;
//   * activity — the contribution calendar (GraphQL), every 30 minutes.
// A pulse that differs from the previous one can raise one event — CI failed,
// review requested, CI passed — which badges the pill like the other pollers.

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::integrations::{emit, enabled, status_error, IntegrationEvent, IntegrationUpdate, PAUSED};
use crate::secrets;

const ID: &str = "integration_github";
const API: &str = "https://api.github.com";

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Ci {
    Pending,
    Success,
    Failure,
    Unknown,
}

impl Ci {
    fn parse(raw: Option<&str>) -> Ci {
        match raw.map(str::to_ascii_uppercase).as_deref() {
            Some("PENDING" | "EXPECTED") => Ci::Pending,
            Some("SUCCESS") => Ci::Success,
            Some("ERROR" | "FAILURE") => Ci::Failure,
            _ => Ci::Unknown,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Pr {
    id: String,
    title: String,
    url: String,
    repo: String,
    number: i64,
    is_draft: bool,
    ci: Ci,
    /// "approved", "changesRequested", "pending" or "unknown".
    review: &'static str,
    #[serde(skip)]
    head: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct RepoCi {
    repo: String,
    url: String,
    branch: String,
    ci: Ci,
    #[serde(skip)]
    head: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Pulse {
    login: String,
    my_prs: Vec<Pr>,
    to_review: Vec<Pr>,
    main_ci: Vec<RepoCi>,
}

impl Pulse {
    fn has_pending(&self) -> bool {
        self.my_prs.iter().any(|p| p.ci == Ci::Pending) || self.main_ci.iter().any(|r| r.ci == Ci::Pending)
    }
}

#[derive(Default)]
struct Card {
    stats: Option<Value>,
    pulse: Option<Pulse>,
    activity: Option<Value>,
}

static CARD: Mutex<Card> = Mutex::new(Card { stats: None, pulse: None, activity: None });

/// Everything known so far, as one card.
fn card_data() -> Value {
    let card = CARD.lock().unwrap();
    let mut data = card.stats.clone().unwrap_or_else(|| json!({}));
    data["pulse"] = card.pulse.as_ref().map(|p| json!(p)).unwrap_or(Value::Null);
    data["activity"] = card.activity.clone().unwrap_or(Value::Null);
    data
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default()
}

fn get(http: &reqwest::Client, token: &str, path: &str) -> reqwest::RequestBuilder {
    http.get(format!("{API}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Coucou")
}

async fn graphql(token: &str, query: &str) -> Result<Value, String> {
    let response = client()
        .post(format!("{API}/graphql"))
        .bearer_auth(token)
        .header("User-Agent", "Coucou")
        .json(&json!({ "query": query }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status.as_u16(), "Token lacks the needed scope"));
    }
    let root: Value = response.json().await.map_err(|e| e.to_string())?;
    // Partial errors still come with data, which is worth showing.
    root.get("data").filter(|d| d.is_object()).cloned().ok_or_else(|| "GitHub returned no data".into())
}

fn error(app: &AppHandle, message: String) {
    emit(app, IntegrationUpdate { id: ID, data: card_data(), error: Some(message), event: None });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

pub async fn poll_stats(app: AppHandle) {
    let Some(token) = secrets::get("github-token") else { return };
    let http = client();
    let Ok(response) = get(&http, &token, "/user").send().await else { return };
    if !response.status().is_success() {
        error(&app, status_error(response.status().as_u16(), "Token lacks the needed scope"));
        return;
    }
    let user: Value = response.json().await.unwrap_or(json!({}));
    let public = user.get("public_repos").and_then(Value::as_i64).unwrap_or(0);
    let private = user
        .get("owned_private_repos")
        .or_else(|| user.get("total_private_repos"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let stars: i64 = match get(&http, &token, "/user/repos?per_page=100&affiliation=owner&sort=pushed").send().await {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.as_array().cloned())
            .map(|list| list.iter().filter_map(|r| r.get("stargazers_count").and_then(Value::as_i64)).sum())
            .unwrap_or(0),
        _ => 0,
    };

    CARD.lock().unwrap().stats = Some(json!({ "totalRepos": public + private, "totalStars": stars }));
    emit(&app, IntegrationUpdate { id: ID, data: card_data(), error: None, event: None });
}

// ── Pulse ─────────────────────────────────────────────────────────────────────

const PULSE_QUERY: &str = r#"query {
  viewer {
    login
    pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft reviewDecision
        repository { nameWithOwner url }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      }
    }
    repositories(first: 10, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        nameWithOwner url isArchived
        defaultBranchRef { name target { ... on Commit { oid statusCheckRollup { state } } } }
      }
    }
  }
  reviewRequested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 20) {
    nodes {
      ... on PullRequest {
        number title url isDraft
        repository { nameWithOwner url }
      }
    }
  }
}"#;

fn nodes<'a>(v: Option<&'a Value>) -> impl Iterator<Item = &'a Value> {
    v.and_then(|c| c.get("nodes")).and_then(Value::as_array).into_iter().flatten()
}

fn pr_from(node: &Value, review: &'static str, with_ci: bool) -> Option<Pr> {
    let number = node.get("number")?.as_i64()?;
    let repo = node.pointer("/repository/nameWithOwner")?.as_str()?.to_string();
    let commit = with_ci.then(|| node.pointer("/commits/nodes/0/commit")).flatten();
    Some(Pr {
        id: format!("{repo}#{number}"),
        title: node.get("title")?.as_str()?.to_string(),
        url: node.get("url")?.as_str()?.to_string(),
        repo,
        number,
        is_draft: node.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        ci: Ci::parse(commit.and_then(|c| c.pointer("/statusCheckRollup/state")).and_then(Value::as_str)),
        review,
        head: commit.and_then(|c| c.get("oid")).and_then(Value::as_str).map(str::to_string),
    })
}

fn parse_pulse(data: &Value) -> Option<Pulse> {
    let viewer = data.get("viewer")?;
    let mut seen = std::collections::HashSet::new();
    let my_prs = nodes(viewer.get("pullRequests"))
        .filter_map(|n| {
            let review = match n.get("reviewDecision").and_then(Value::as_str) {
                Some("APPROVED") => "approved",
                Some("CHANGES_REQUESTED") => "changesRequested",
                Some("REVIEW_REQUIRED") => "pending",
                _ => "unknown",
            };
            pr_from(n, review, true)
        })
        .filter(|p| seen.insert(p.id.clone()))
        .collect();
    let main_ci = nodes(viewer.get("repositories"))
        .filter(|n| !n.get("isArchived").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|n| {
            let branch = n.get("defaultBranchRef")?;
            let target = branch.get("target");
            Some(RepoCi {
                repo: n.get("nameWithOwner")?.as_str()?.to_string(),
                url: n.get("url")?.as_str()?.to_string(),
                branch: branch.get("name")?.as_str()?.to_string(),
                ci: Ci::parse(target.and_then(|t| t.pointer("/statusCheckRollup/state")).and_then(Value::as_str)),
                head: target.and_then(|t| t.get("oid")).and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    let to_review = nodes(data.get("reviewRequested"))
        .filter_map(|n| pr_from(n, "pending", false))
        .filter(|p| seen.insert(p.id.clone()))
        .collect();
    Some(Pulse {
        login: viewer.get("login").and_then(Value::as_str).unwrap_or_default().to_string(),
        my_prs,
        to_review,
        main_ci,
    })
}

/// The one event worth raising for this change, by priority: a failed CI, then
/// a new review request, then a CI that passed. None on the first pulse.
fn event(old: Option<&Pulse>, new: &Pulse) -> Option<IntegrationEvent> {
    let old = old?;
    let mut failed: Option<String> = None;
    let mut passed: Option<String> = None;
    let mut review: Option<String> = None;

    for pr in &new.my_prs {
        let prev = old.my_prs.iter().find(|p| p.id == pr.id);
        let same_commit = prev.is_some_and(|p| p.head == pr.head);
        let label = format!("{} — {}", pr.id, pr.title);
        match (pr.ci, prev) {
            (Ci::Failure, Some(p)) if same_commit && p.ci != Ci::Failure => failed = failed.or(Some(label)),
            (Ci::Success, Some(p)) if same_commit && p.ci == Ci::Pending => passed = passed.or(Some(label)),
            (Ci::Failure, _) if !same_commit => failed = failed.or(Some(label)),
            (Ci::Success, _) if !same_commit => passed = passed.or(Some(label)),
            _ => {}
        }
    }
    for repo in &new.main_ci {
        let prev = old.main_ci.iter().find(|r| r.repo == repo.repo);
        let same_commit = prev.is_some_and(|r| r.head == repo.head);
        let newly_failed = repo.ci == Ci::Failure && (!same_commit || prev.is_some_and(|r| r.ci != Ci::Failure));
        if newly_failed {
            failed = failed.or(Some(format!("{} · {}", repo.repo, repo.branch)));
        }
    }
    for pr in &new.to_review {
        if !old.to_review.iter().any(|p| p.id == pr.id) {
            review = review.or(Some(format!("{} — {}", pr.id, pr.title)));
        }
    }

    if let Some(detail) = failed {
        return Some(IntegrationEvent { success: false, label: "CI failed".into(), detail: Some(detail) });
    }
    if let Some(detail) = review {
        return Some(IntegrationEvent { success: true, label: "Review requested".into(), detail: Some(detail) });
    }
    passed.map(|detail| IntegrationEvent { success: true, label: "CI passed".into(), detail: Some(detail) })
}

/// Returns whether a CI is still running, which shortens the next wait.
pub async fn poll_pulse(app: AppHandle) -> bool {
    let Some(token) = secrets::get("github-token") else { return false };
    let data = match graphql(&token, PULSE_QUERY).await {
        Ok(d) => d,
        Err(e) => {
            error(&app, e);
            return false;
        }
    };
    let Some(pulse) = parse_pulse(&data) else { return false };
    let pending = pulse.has_pending();
    let ev = {
        let mut card = CARD.lock().unwrap();
        let ev = event(card.pulse.as_ref(), &pulse);
        card.pulse = Some(pulse);
        ev
    };
    emit(&app, IntegrationUpdate { id: ID, data: card_data(), error: None, event: ev });
    pending
}

// ── Activity ──────────────────────────────────────────────────────────────────

const ACTIVITY_QUERY: &str = r#"query {
  viewer {
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel weekday } }
      }
    }
  }
}"#;

fn parse_activity(data: &Value) -> Option<Value> {
    let calendar = data.pointer("/viewer/contributionsCollection/contributionCalendar")?;
    let total = calendar.get("totalContributions")?.as_i64()?;
    let weeks: Vec<Value> = calendar
        .get("weeks")?
        .as_array()?
        .iter()
        .filter_map(|w| {
            let days: Vec<Value> = w
                .get("contributionDays")?
                .as_array()?
                .iter()
                .filter_map(|d| {
                    let level = match d.get("contributionLevel")?.as_str()? {
                        "FIRST_QUARTILE" => 1,
                        "SECOND_QUARTILE" => 2,
                        "THIRD_QUARTILE" => 3,
                        "FOURTH_QUARTILE" => 4,
                        _ => 0,
                    };
                    Some(json!({
                        "date": d.get("date")?.as_str()?,
                        "count": d.get("contributionCount")?.as_i64()?,
                        "level": level,
                        "weekday": d.get("weekday")?.as_i64()?,
                    }))
                })
                .collect();
            (!days.is_empty()).then_some(Value::Array(days))
        })
        .collect();
    let login = data.pointer("/viewer/login").and_then(Value::as_str).unwrap_or_default();
    Some(json!({ "total": total, "weeks": weeks, "login": login }))
}

pub async fn poll_activity(app: AppHandle) {
    let Some(token) = secrets::get("github-token") else { return };
    let Ok(data) = graphql(&token, ACTIVITY_QUERY).await else { return };
    let Some(activity) = parse_activity(&data) else { return };
    CARD.lock().unwrap().activity = Some(activity);
    emit(&app, IntegrationUpdate { id: ID, data: card_data(), error: None, event: None });
}

// ── Schedule ──────────────────────────────────────────────────────────────────

fn may_poll(app: &AppHandle) -> bool {
    !PAUSED.load(Ordering::Relaxed) && enabled(app, ID)
}

/// Same first delays and cadences as GithubPoller.start().
pub fn start(app: AppHandle) {
    let stats_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(7)).await;
        loop {
            if may_poll(&stats_app) {
                poll_stats(stats_app.clone()).await;
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
    let pulse_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            let pending = may_poll(&pulse_app) && poll_pulse(pulse_app.clone()).await;
            tokio::time::sleep(Duration::from_secs(if pending { 60 } else { 300 })).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if may_poll(&app) {
                poll_activity(app.clone()).await;
            }
            tokio::time::sleep(Duration::from_secs(1800)).await;
        }
    });
}

/// The card's Refresh button.
pub async fn poll_all(app: AppHandle) {
    poll_stats(app.clone()).await;
    poll_pulse(app.clone()).await;
    poll_activity(app).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(id: &str, ci: Ci, head: &str) -> Pr {
        Pr {
            id: id.into(), title: "t".into(), url: String::new(), repo: "o/r".into(), number: 1,
            is_draft: false, ci, review: "unknown", head: Some(head.into()),
        }
    }

    fn pulse(prs: Vec<Pr>, review: Vec<Pr>) -> Pulse {
        Pulse { login: "me".into(), my_prs: prs, to_review: review, main_ci: vec![] }
    }

    #[test]
    fn the_first_pulse_is_silent() {
        assert!(event(None, &pulse(vec![pr("o/r#1", Ci::Failure, "a")], vec![])).is_none());
    }

    #[test]
    fn ci_transitions_raise_one_event_by_priority() {
        let old = pulse(vec![pr("o/r#1", Ci::Pending, "a"), pr("o/r#2", Ci::Pending, "b")], vec![]);
        let new = pulse(vec![pr("o/r#1", Ci::Success, "a"), pr("o/r#2", Ci::Failure, "b")], vec![]);
        let ev = event(Some(&old), &new).unwrap();
        assert!(!ev.success);
        assert_eq!(ev.label, "CI failed");
        assert!(ev.detail.unwrap().starts_with("o/r#2"));

        let still = pulse(vec![pr("o/r#1", Ci::Success, "a")], vec![]);
        assert!(event(Some(&new), &still).is_none(), "nothing changed, nothing raised");
    }

    #[test]
    fn a_new_commit_that_already_finished_counts() {
        let old = pulse(vec![pr("o/r#1", Ci::Success, "a")], vec![]);
        let new = pulse(vec![pr("o/r#1", Ci::Success, "b")], vec![]);
        assert_eq!(event(Some(&old), &new).unwrap().label, "CI passed");
    }

    #[test]
    fn a_new_review_request_is_announced() {
        let old = pulse(vec![], vec![]);
        let new = pulse(vec![], vec![pr("x/y#9", Ci::Unknown, "c")]);
        assert_eq!(event(Some(&old), &new).unwrap().label, "Review requested");
    }

    #[test]
    fn pulse_parsing_reads_the_documented_shape() {
        let data = json!({
            "viewer": {
                "login": "me",
                "pullRequests": { "nodes": [{
                    "number": 4, "title": "Fix", "url": "https://github.com/o/r/pull/4", "isDraft": false,
                    "reviewDecision": "APPROVED", "repository": { "nameWithOwner": "o/r" },
                    "commits": { "nodes": [{ "commit": { "oid": "abc", "statusCheckRollup": { "state": "SUCCESS" } } }] }
                }]},
                "repositories": { "nodes": [
                    { "nameWithOwner": "o/r", "url": "https://github.com/o/r", "isArchived": false,
                      "defaultBranchRef": { "name": "main", "target": { "oid": "d", "statusCheckRollup": { "state": "FAILURE" } } } },
                    { "nameWithOwner": "o/old", "url": "u", "isArchived": true, "defaultBranchRef": { "name": "main" } }
                ]}
            },
            "reviewRequested": { "nodes": [{ "number": 7, "title": "Add", "url": "u", "repository": { "nameWithOwner": "x/y" } }] }
        });
        let p = parse_pulse(&data).unwrap();
        assert_eq!(p.my_prs[0].ci, Ci::Success);
        assert_eq!(p.my_prs[0].review, "approved");
        assert_eq!(p.main_ci.len(), 1, "archived repos are skipped");
        assert_eq!(p.main_ci[0].ci, Ci::Failure);
        assert_eq!(p.to_review[0].id, "x/y#7");
    }
}
