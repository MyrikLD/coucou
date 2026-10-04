// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, isSession, sessionTaskId } from "../core/state";
import { parseQuestions } from "../core/ask";
import { diffForTool, makeDiffStep } from "../core/diff";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  coucou_agent?: string;
  /** The relay's parent process, inside the session's terminal (Linux). */
  hook_ppid?: number;
  /** The conversation's title, read from its transcript by the app. */
  session_title?: string;
  /** "ask_user_question" from coucou-hook --ask. */
  coucou_kind?: string;
}

/** A finished or idle companion falls asleep after this long without events… */
const SLEEP_AFTER_MS = 5 * 60_000;
/** …and leaves after this long, in case its SessionEnd never came. */
const LEAVE_AFTER_MS = 20 * 60_000;

/** Same rule as HookServer.validateAgent on macOS. "claude" is reserved. */
function validateAgent(raw: string | undefined): string | null {
  if (!raw || raw.length > 24 || raw === "claude") return null;
  if (!/^[a-z0-9-]+$/.test(raw)) return null;
  return raw;
}

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

function agentColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(h) % FALLBACK_COLORS.length];
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "Claude Code";
  t.pillBadge = null;
  State.diffs.delete(CLAUDE_ID);
}

/** Clears the question card if nobody answered before the relay gave up. */
let questionTimeout: number | null = null;

/** Hands an unanswered question back to the terminal. */
export function releaseQuestion(island: Island) {
  const q = State.pendingQuestion;
  if (!q) return;
  if (questionTimeout != null) window.clearTimeout(questionTimeout);
  questionTimeout = null;
  void Bridge.approvalDecline(q.requestId);
  State.pendingQuestion = null;
  State.isPinned = false;
  island.dropPin();
  State.updateTask(q.taskId, "working");
  State.setPillBadge(q.taskId, null);
}

/** The island's answers go back through the relay as the tool's input. */
export function answerQuestion(island: Island, answers: Record<string, string | string[]>) {
  const q = State.pendingQuestion;
  if (!q) return;
  if (questionTimeout != null) window.clearTimeout(questionTimeout);
  questionTimeout = null;
  void Bridge.questionAnswer(q.requestId, answers);
  State.pendingQuestion = null;
  State.isPinned = false;
  island.dropPin();
  State.updateTask(q.taskId, "working");
  State.setPillBadge(q.taskId, null);
  Sound.play("approve");
  island.setView(State.defaultView());
}

/** AskUserQuestion from coucou-hook --ask — handled like a permission request. */
function handleQuestion(island: Island, payload: HookPayload, taskId: string, focused: boolean) {
  const requestId = payload.request_id ?? "";
  const items = parseQuestions(payload.tool_input);
  // Malformed, or another card already up: the terminal asks instead.
  if (!items || State.pendingQuestion || State.pendingApproval) {
    if (requestId) void Bridge.approvalDecline(requestId);
    return;
  }
  State.pendingQuestion = { requestId, taskId, items };
  if (requestId) void Bridge.approvalAck(requestId);
  State.updateTask(taskId, "question");
  State.isPinned = true;
  Sound.play("question");
  if (focused) {
    island.alert("question");
  } else {
    State.setPillBadge(taskId, "approval");
    island.reveal();
  }
  questionTimeout = window.setTimeout(() => {
    questionTimeout = null;
    if (State.pendingQuestion?.requestId !== requestId) return;
    State.pendingQuestion = null;
    State.isPinned = false;
    island.dropPin();
    State.setPillBadge(taskId, null);
    if (State.view === "question") island.setView(State.defaultView());
    State.notify();
  }, 124_000);
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  window.setInterval(sweepSessions, 60_000);
}

/** Puts quiet companions to sleep and lets abandoned ones go. */
function sweepSessions() {
  const now = performance.now();
  let changed = false;
  for (const t of [...State.tasks]) {
    if (!isSession(t.id) || t.lastEvent == null) continue;
    if (State.pendingApproval?.taskId === t.id) continue;
    const quiet = now - t.lastEvent;
    if (quiet > LEAVE_AFTER_MS) {
      State.removeTask(t.id);
      changed = true;
    } else if (quiet > SLEEP_AFTER_MS && (t.state === "idle" || t.state === "finished")) {
      t.state = "sleeping";
      changed = true;
    }
  }
  if (changed) State.notify();
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid coucou_agent → dynamic "agent_<name>" pill
  // ("claude" is reserved). Otherwise every Claude Code session gets its own
  // companion; a payload without a session id lands on the Claude Code pill.
  const validAgent = validateAgent(payload.coucou_agent);
  const isExternalAgent = validAgent !== null;
  const sessionId = !isExternalAgent && name !== "SessionEnd" ? payload.session_id ?? "" : "";
  const session = sessionId ? State.upsertSession(sessionId, projectName, cwd, payload.session_title) : null;
  if (session && payload.hook_ppid) session.sessionPid = payload.hook_ppid;
  const endingId = name === "SessionEnd" && payload.session_id
    ? State.tasks.find((t) => t.id === sessionTaskId(payload.session_id!))?.id
    : undefined;
  const agentId = validAgent ? `agent_${validAgent}` : session?.id ?? endingId ?? CLAUDE_ID;

  const focused = State.focusId === agentId;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** Ensure the agent pill exists; session companions already do. */
  const ensurePill = () => {
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, validAgent!, agentColor(validAgent!));
    } else if (!session) {
      upsert(projectName, cwd);
    }
  };

  if (payload.coucou_kind === "ask_user_question") {
    handleQuestion(island, payload, agentId, focused);
    State.notify();
    return;
  }

  switch (name) {
    case "SessionStart":
      ensurePill();
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      const tool = payload.tool_name ?? "Tool";
      // The question card covers it, from its own hook.
      if (tool === "AskUserQuestion") break;
      State.updateTask(agentId, "working");
      const diff = diffForTool(tool, payload.tool_input ?? {});
      if (diff) {
        State.addDiff(agentId, diff);
        State.appendStep(agentId, makeDiffStep(diff));
      } else {
        State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      }
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(agentId, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(agentId, "working");
      State.appendStep(agentId, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop":
      State.updateTask(agentId, "finished");
      if (payload.message) State.appendStep(agentId, payload.message.slice(0, 60));
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      window.setTimeout(() => {
        if (isExternalAgent) {
          State.removeTask(agentId);
        } else if (State.tasks.find((t) => t.id === agentId)?.state === "finished") {
          State.updateTask(agentId, "idle");
          State.setPillBadge(agentId, null);
        }
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(agentId, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      if (isExternalAgent || isSession(agentId)) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession();
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(agentId, "• subagent done");
      break;

    case "PermissionRequest": {
      // External agents do not get an approval card — showing one would look like
      // a Claude Code request. Decline immediately so the agent re-asks in its
      // terminal. Approval support for other agents will come with Codex support.
      if (isExternalAgent) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      ensurePill();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        taskId: agentId,
        tool,
        command: approvalTarget(tool, input),
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(agentId, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(agentId, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(agentId, "working");
        State.setPillBadge(agentId, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
