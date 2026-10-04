// App state — mirror of AppState.swift (the parts the island needs).

import { colorForProject, type BotEmoteName, type BotStateName, type IslandMode, type IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { ChatProviderId } from "./providers";
import type { PlanUsage } from "./plan";
import type { AskItem } from "./ask";
import type { FileDiff } from "./diff";
import { parseOutfit, resolveOutfit, type OutfitId } from "../mochi/outfits";

/** One pill per Claude Code session: `session_<id>`. */
export const isSession = (id: string) => id.startsWith("session_");

export const sessionTaskId = (sessionId: string) =>
  `session_${sessionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 48)}`;

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Session companions: project folder name before any "#2" suffix. */
  baseName?: string;
  /** Session companions: a process of the session, to find its terminal window. */
  sessionPid?: number | null;
  /** Session companions: performance.now() of the last hook event. */
  lastEvent?: number;
  /** Mini Mochi dances in its pill (Now playing). */
  dancing?: boolean;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** The pill that asked. */
  taskId: string;
  tool: string;
  command: string;
}

export interface QuestionInfo {
  requestId: string;
  /** The pill that asked. */
  taskId: string;
  items: AskItem[];
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source, isIntegration: true,
});

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "Claude Code", "#F5F6F8", "claudeCode"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
  task("integration_music", "Music", "#FA2D48", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe", "integration_music",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  chatProvider: ChatProviderId;
  /** Per-provider model; empty means the provider's default. */
  googleModel: string;
  openaiModel: string;
  ollamaModel: string;
  lmstudioModel: string;
  /** Local server base URLs; empty means not connected. */
  ollamaUrl: string;
  lmstudioUrl: string;
  /** Claude plan usage pill in the island header. */
  showPlan: boolean;
  /** Mochi's outfit: "auto" follows the seasons, otherwise an outfit id. */
  outfit: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
  chatProvider: "anthropic",
  googleModel: "",
  openaiModel: "",
  ollamaModel: "",
  lmstudioModel: "",
  ollamaUrl: "",
  lmstudioUrl: "",
  showPlan: false,
  outfit: "auto",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;
  pendingQuestion: QuestionInfo | null = null;
  /** Per pill, the diffs its session made, oldest first, at most 50. */
  diffs = new Map<string, FileDiff[]>();
  /** The diff open in the overview card, if any. */
  openDiff: FileDiff | null = null;
  /** The desktop has a mail client to hand a draft to (from boot). */
  mailClient = false;
  /** Resend can send mail itself (key + sender stored). */
  resendReady = false;

  planUsage: PlanUsage | null = null;
  /** coucou-hook --statusline is in ~/.claude/settings.json. */
  planRelayInstalled = false;
  showingPlanDetail = false;
  /** The model picker above the chat box is open. */
  chatPickerOpen = false;
  /** Outfit hovered in the wardrobe, worn by Mochi as a preview. */
  wardrobePreview: OutfitId | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /** The Now playing pill has players to watch (Linux only). */
  musicSupported = false;
  musicPlaying = false;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  /** What Mochi wears right now: the wardrobe preview, else the saved choice. */
  get resolvedOutfit(): OutfitId {
    return this.wardrobePreview ?? resolveOutfit(parseOutfit(this.settings.outfit));
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /**
   * loadIntegrationTasks() — the Claude Code pill stands in while no session
   * runs; each live session then has its own companion. The rest is opt-in.
   */
  loadIntegrationTasks() {
    const sessions = this.tasks.some((t) => isSession(t.id));
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad = proto.id === "integration_claude"
        ? !sessions
        : this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Claude Code first, then sessions, then agent_* pills, then integrations in
    // declaration order. The sort is stable, so each group keeps arrival order.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    const rank = (id: string) =>
      id === "integration_claude" ? 0 : isSession(id) ? 1 : id.startsWith("agent_") ? 2 : 3;
    this.tasks.sort((a, b) =>
      rank(a.id) - rank(b.id) || (rank(a.id) === 3 ? order.indexOf(a.id) - order.indexOf(b.id) : 0));
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) {
      this.focusId = this.tasks[0]?.id ?? null;
    }
    this.notify();
  }

  addDiff(taskId: string, diff: FileDiff) {
    const list = this.diffs.get(taskId) ?? [];
    list.push(diff);
    if (list.length > 50) list.shift();
    this.diffs.set(taskId, list);
  }

  findDiff(taskId: string, id: number): FileDiff | null {
    return this.diffs.get(taskId)?.find((d) => d.id === id) ?? null;
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    this.diffs.delete(id);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? null;
    if (isSession(id)) this.loadIntegrationTasks();
    this.notify();
  }

  /**
   * The session's companion, created on its first event. Named after the
   * conversation once Claude Code has titled it; until then after the project
   * folder, with a second session in the same folder becoming "name #2".
   */
  upsertSession(sessionId: string, base: string, cwd: string, title?: string): AgentTask {
    const id = sessionTaskId(sessionId);
    const existing = this.tasks.find((t) => t.id === id);
    if (existing) {
      existing.lastEvent = performance.now();
      if (cwd) existing.sessionCwd = cwd;
      if (title) existing.name = title;
      return existing;
    }
    const taken = new Set(this.tasks.filter((t) => isSession(t.id)).map((t) => t.name));
    let n = 1;
    while (taken.has(n === 1 ? base : `${base} #${n}`)) n++;
    const task: AgentTask = {
      id,
      name: title || (n === 1 ? base : `${base} #${n}`),
      color: colorForProject(base),
      state: "idle", stepIndex: 0, steps: [],
      source: "claudeCode", isIntegration: false,
      sessionCwd: cwd || null,
      baseName: base,
      lastEvent: performance.now(),
    };
    this.tasks.push(task);
    const focus = this.focusId;
    if (!focus || focus === "integration_claude") this.focusId = id;
    this.loadIntegrationTasks();
    return task;
  }

  /** Creates a dynamic agent_ pill on first event; no-ops if it already exists.
   *  Inserted right after integration_claude so it appears in the visible slice(0,4). */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const firstOther = this.tasks.findIndex((t) => t.id !== "integration_claude" && !isSession(t.id));
    const at = firstOther < 0 ? this.tasks.length : firstOther;
    this.tasks.splice(at, 0, {
      id, name, color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
    if (!this.focusId) this.focusId = id;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (id === "integration_claude") return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = null;
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  get mailAvailable(): boolean {
    return this.mailClient || this.resendReady;
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
