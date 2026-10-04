// "Now playing" pill — the Linux counterpart of MusicController.swift.
//
// Any MPRIS player on the session bus (Spotify, browsers, mpv, Rhythmbox…) is
// watched through D-Bus signals only: NameOwnerChanged for players coming and
// going, PropertiesChanged for play/pause and track changes. Nothing is polled,
// so an idle player costs nothing. The island gets a `music` event with the
// track of the player that is playing, or else of the one touched last.

use serde::Serialize;

#[derive(Serialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// Bus name of the player, e.g. `org.mpris.MediaPlayer2.spotify`.
    pub player: String,
    /// Human name the player gives itself ("Spotify", "Firefox"…).
    pub identity: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub art_url: Option<String>,
    pub playing: bool,
    pub position_ms: Option<u64>,
    pub length_ms: Option<u64>,
    pub can_raise: bool,
}

/// MusicController.shortTitle: cut at " - ", then drop trailing (…) / […] groups.
pub fn short_title(raw: &str) -> String {
    let mut s = raw.split(" - ").next().unwrap_or(raw).to_string();
    loop {
        let t = s.trim_end();
        let open = match t.chars().last() {
            Some(')') => '(',
            Some(']') => '[',
            _ => break,
        };
        match t.rfind(open) {
            Some(idx) if !t[..idx].trim().is_empty() => s = t[..idx].trim().to_string(),
            _ => break,
        }
    }
    let result = s.trim();
    if result.is_empty() { raw.to_string() } else { result.to_string() }
}

/// MusicController.shortArtist: drop " feat. …" / " ft. …".
pub fn short_artist(raw: &str) -> String {
    let lower = raw.to_lowercase();
    for tag in [" feat.", " ft."] {
        if let Some(idx) = lower.find(tag) {
            let result = raw[..idx].trim();
            return if result.is_empty() { raw.to_string() } else { result.to_string() };
        }
    }
    raw.to_string()
}

pub use imp::*;

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    use std::sync::atomic::Ordering;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    use futures_lite::StreamExt;
    use tauri::{AppHandle, Emitter, Manager};
    use tokio::sync::mpsc;
    use zbus::fdo::{DBusProxy, PropertiesProxy};
    use zbus::names::{BusName, InterfaceName};
    use zbus::zvariant::{OwnedValue, Value};
    use zbus::{Connection, MatchRule, MessageStream};

    use super::{short_artist, short_title, Track};
    use crate::island::WINDOW_LABEL;
    use crate::{integrations, log};

    const PREFIX: &str = "org.mpris.MediaPlayer2.";
    const PATH: &str = "/org/mpris/MediaPlayer2";
    const ROOT_IFACE: &str = "org.mpris.MediaPlayer2";
    const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
    const PILL_ID: &str = "integration_music";
    /// playerctld mirrors whichever player is active; listing it too would show
    /// every track twice.
    const PROXIES: &[&str] = &["org.mpris.MediaPlayer2.playerctld"];

    struct Player {
        owner: String,
        identity: String,
        can_raise: bool,
        status: String,
        meta: HashMap<String, OwnedValue>,
        touched: Instant,
    }

    #[derive(Default)]
    struct Registry {
        players: HashMap<String, Player>,
        /// Bus name of the player the island is showing.
        current: Option<String>,
        last: Option<Track>,
    }

    static CONN: OnceLock<Connection> = OnceLock::new();
    static REGISTRY: std::sync::LazyLock<Mutex<Registry>> =
        std::sync::LazyLock::new(|| Mutex::new(Registry::default()));

    enum Event {
        Owner { name: String, new_owner: String },
        Changed { sender: String },
    }

    pub fn start(app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            if let Err(err) = run(app).await {
                log::line(format!("music: {err}"));
            }
        });
    }

    async fn run(app: AppHandle) -> zbus::Result<()> {
        let conn = Connection::session().await?;
        let _ = CONN.set(conn.clone());
        let dbus = DBusProxy::new(&conn).await?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Event>();

        let mut owners = dbus.receive_name_owner_changed().await?;
        let owner_tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(signal) = owners.next().await {
                let Ok(args) = signal.args() else { continue };
                let name = args.name().to_string();
                if !name.starts_with(PREFIX) {
                    continue;
                }
                let new_owner = args.new_owner().as_ref().map(|o| o.to_string()).unwrap_or_default();
                if owner_tx.send(Event::Owner { name, new_owner }).is_err() {
                    break;
                }
            }
        });

        let rule = MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.DBus.Properties")?
            .member("PropertiesChanged")?
            .path(PATH)?
            .build();
        let mut changes = MessageStream::for_match_rule(rule, &conn, None).await?;
        tauri::async_runtime::spawn(async move {
            while let Some(Ok(msg)) = changes.next().await {
                let sender = msg.header().sender().map(|s| s.to_string()).unwrap_or_default();
                if tx.send(Event::Changed { sender }).is_err() {
                    break;
                }
            }
        });

        for name in dbus.list_names().await? {
            let name = name.to_string();
            if name.starts_with(PREFIX) && !PROXIES.contains(&name.as_str()) {
                add_player(&conn, &dbus, &name).await;
            }
        }
        publish(&app, &conn).await;

        while let Some(event) = rx.recv().await {
            match event {
                Event::Owner { name, new_owner } => {
                    if PROXIES.contains(&name.as_str()) {
                        continue;
                    }
                    if new_owner.is_empty() {
                        REGISTRY.lock().unwrap().players.remove(&name);
                    } else {
                        add_player(&conn, &dbus, &name).await;
                    }
                }
                Event::Changed { sender } => {
                    let name = {
                        let reg = REGISTRY.lock().unwrap();
                        reg.players.iter().find(|(_, p)| p.owner == sender).map(|(n, _)| n.clone())
                    };
                    let Some(name) = name else { continue };
                    refresh_player(&conn, &name).await;
                }
            }
            publish(&app, &conn).await;
        }
        Ok(())
    }

    async fn props(conn: &Connection, name: &str) -> zbus::Result<PropertiesProxy<'static>> {
        PropertiesProxy::builder(conn)
            .destination(name.to_string())?
            .path(PATH)?
            .build()
            .await
    }

    async fn add_player(conn: &Connection, dbus: &DBusProxy<'_>, name: &str) {
        let Ok(bus) = BusName::try_from(name) else { return };
        let Ok(owner) = dbus.get_name_owner(bus).await else { return };
        let (identity, can_raise) = match props(conn, name).await {
            Ok(p) => match p.get_all(InterfaceName::from_static_str_unchecked(ROOT_IFACE)).await {
                Ok(root) => (
                    root.get("Identity").and_then(|v| as_str(v)).unwrap_or_default(),
                    root.get("CanRaise").and_then(|v| bool::try_from(&**v).ok()).unwrap_or(false),
                ),
                Err(_) => (String::new(), false),
            },
            Err(_) => (String::new(), false),
        };
        REGISTRY.lock().unwrap().players.insert(
            name.to_string(),
            Player {
                owner: owner.to_string(),
                identity,
                can_raise,
                status: String::new(),
                meta: HashMap::new(),
                touched: Instant::now(),
            },
        );
        refresh_player(conn, name).await;
    }

    /// Re-reads status and metadata. PropertiesChanged may only list a property
    /// as invalidated, so the values are always fetched rather than taken from it.
    async fn refresh_player(conn: &Connection, name: &str) {
        let Ok(p) = props(conn, name).await else { return };
        let Ok(mut all) = p.get_all(InterfaceName::from_static_str_unchecked(PLAYER_IFACE)).await else {
            return;
        };
        let status = all.get("PlaybackStatus").and_then(|v| as_str(v)).unwrap_or_default();
        let meta = all
            .remove("Metadata")
            .and_then(|v| HashMap::<String, OwnedValue>::try_from(v).ok())
            .unwrap_or_default();
        let mut reg = REGISTRY.lock().unwrap();
        let Some(player) = reg.players.get_mut(name) else { return };
        if player.status != status || title_of(&player.meta) != title_of(&meta) {
            player.touched = Instant::now();
        }
        player.status = status;
        player.meta = meta;
    }

    fn as_str(v: &Value<'_>) -> Option<String> {
        match v {
            Value::Value(inner) => as_str(inner),
            Value::Array(items) => items.inner().first().and_then(as_str),
            other => <&str>::try_from(other).ok().map(str::to_string),
        }
    }

    fn as_u64(v: &Value<'_>) -> Option<u64> {
        match v {
            Value::Value(inner) => as_u64(inner),
            Value::I64(n) => u64::try_from(*n).ok(),
            Value::U64(n) => Some(*n),
            Value::I32(n) => u64::try_from(*n).ok(),
            Value::U32(n) => Some(*n as u64),
            Value::F64(n) if *n >= 0.0 => Some(*n as u64),
            _ => None,
        }
    }

    fn title_of(meta: &HashMap<String, OwnedValue>) -> Option<String> {
        meta.get("xesam:title").and_then(|v| as_str(v))
    }

    fn non_empty(s: Option<String>) -> Option<String> {
        s.filter(|s| !s.trim().is_empty())
    }

    /// The player that is playing, most recent first; else the one touched last.
    fn pick(reg: &Registry) -> Option<String> {
        let latest = |playing: bool| {
            reg.players
                .iter()
                .filter(|(_, p)| !playing || p.status == "Playing")
                .max_by_key(|(_, p)| p.touched)
                .map(|(n, _)| n.clone())
        };
        latest(true).or_else(|| latest(false))
    }

    fn enabled(app: &AppHandle) -> bool {
        app.try_state::<crate::Shared>()
            .map(|shared| {
                let settings = shared.settings.lock().unwrap();
                settings.active_integrations.iter().any(|x| x == PILL_ID)
            })
            .unwrap_or(false)
    }

    /// The chosen player's track, with its position read fresh: players do not
    /// signal Position changes.
    async fn current_track(conn: &Connection) -> Option<Track> {
        let chosen = {
            let mut reg = REGISTRY.lock().unwrap();
            let name = pick(&reg);
            reg.current = name.clone();
            name.and_then(|n| {
                let p = reg.players.get(&n)?;
                let meta = &p.meta;
                Some(Track {
                    player: n.clone(),
                    identity: p.identity.clone(),
                    title: non_empty(title_of(meta)).map(|t| short_title(&t)),
                    artist: non_empty(meta.get("xesam:artist").and_then(|v| as_str(v)))
                        .map(|a| short_artist(&a)),
                    album: non_empty(meta.get("xesam:album").and_then(|v| as_str(v))),
                    art_url: non_empty(meta.get("mpris:artUrl").and_then(|v| as_str(v))),
                    playing: p.status == "Playing",
                    position_ms: None,
                    length_ms: meta.get("mpris:length").and_then(|v| as_u64(v)).map(|us| us / 1000),
                    can_raise: p.can_raise,
                })
            })
        };

        match chosen {
            Some(mut t) => {
                if let Ok(p) = props(conn, &t.player).await {
                    if let Ok(v) = p
                        .get(InterfaceName::from_static_str_unchecked(PLAYER_IFACE), "Position")
                        .await
                    {
                        t.position_ms = as_u64(&v).map(|us| us / 1000);
                    }
                }
                Some(t)
            }
            None => None,
        }
    }

    async fn publish(app: &AppHandle, conn: &Connection) {
        let track = current_track(conn).await;
        let changed = {
            let mut reg = REGISTRY.lock().unwrap();
            let same = match (&reg.last, &track) {
                (Some(a), Some(b)) => Track { position_ms: None, ..a.clone() } == Track { position_ms: None, ..b.clone() },
                (None, None) => true,
                _ => false,
            };
            reg.last = track.clone();
            !same
        };
        if changed && !integrations::PAUSED.load(Ordering::Relaxed) && enabled(app) {
            let _ = app.emit_to(WINDOW_LABEL, "music", track);
        }
    }

    /// What the pill should show right now — read when it is switched on or the
    /// app is unpaused, since no event was sent while it was off.
    pub fn snapshot() -> Option<Track> {
        REGISTRY.lock().unwrap().last.clone()
    }

    pub async fn control(action: &str) {
        let Some(conn) = CONN.get() else { return };
        let Some(name) = REGISTRY.lock().unwrap().current.clone() else { return };
        let (iface, method) = match action {
            "playPause" => (PLAYER_IFACE, "PlayPause"),
            "next" => (PLAYER_IFACE, "Next"),
            "previous" => (PLAYER_IFACE, "Previous"),
            "raise" => (ROOT_IFACE, "Raise"),
            _ => return,
        };
        if let Err(err) = conn.call_method(Some(name.as_str()), PATH, Some(iface), method, &()).await {
            log::line(format!("music: {method} on {name} failed: {err}"));
        }
    }

    pub const SUPPORTED: bool = true;
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::Track;
    use tauri::AppHandle;

    pub fn start(_app: AppHandle) {}

    pub fn snapshot() -> Option<Track> {
        None
    }

    pub async fn control(_action: &str) {}

    pub const SUPPORTED: bool = false;
}

#[cfg(test)]
mod tests {
    use super::{short_artist, short_title};

    #[test]
    fn titles_lose_versions_and_remaster_tags() {
        assert_eq!(short_title("Song - 2011 Remaster"), "Song");
        assert_eq!(short_title("Song (Live) [Deluxe]"), "Song");
        assert_eq!(short_title("(Intro)"), "(Intro)");
        assert_eq!(short_title(""), "");
    }

    #[test]
    fn artists_lose_featured_guests() {
        assert_eq!(short_artist("Main feat. Guest"), "Main");
        assert_eq!(short_artist("Main Ft. Guest"), "Main");
        assert_eq!(short_artist("Solo"), "Solo");
    }
}
