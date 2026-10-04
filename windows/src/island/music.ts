// Now playing pill — island side of MusicController.swift. Rust watches the
// MPRIS players and sends a `music` event; this keeps the pill's name, card and
// dance in step and peeks the island out when playback starts.

import { Bridge, onEvent, type MusicTrack } from "../core/bridge";
import { State } from "../core/state";
import type { Island } from "./island";

const PILL = "integration_music";
const DEFAULT_NAME = "Music";

export async function registerMusicHandlers(island: Island) {
  State.musicSupported = (await Bridge.musicSupported()) ?? false;
  if (!State.musicSupported) return;
  void onEvent<MusicTrack | null>("music", (track) => apply(island, track));
  await refreshMusic(island);
}

/** No event reaches the island while the pill is off or the app is paused. */
export async function refreshMusic(island: Island) {
  if (!State.musicSupported) return;
  apply(island, (await Bridge.musicState()) ?? null);
}

function apply(island: Island, track: MusicTrack | null) {
  const active = State.settings.activeIntegrations.includes(PILL);
  const shown = active && !State.paused ? track : null;
  const wasPlaying = State.musicPlaying;
  const playing = shown?.playing ?? false;

  State.musicPlaying = playing;
  State.integrations[PILL] = {
    data: shown ? { ...shown } : {},
    error: null,
    loaded: shown != null,
    configured: true,
  };
  const task = State.tasks.find((t) => t.id === PILL);
  if (task) {
    task.name = shown?.title || DEFAULT_NAME;
    task.dancing = playing;
  }
  State.notify();

  if (playing && !wasPlaying) island.revealSilently();
}
