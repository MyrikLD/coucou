// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, isSession, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { washRGBA, type BotEmoteName, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { buildMail } from "./mail";
import { buildQuestionCard } from "./question";
import { diffFileName, type FileDiff } from "../core/diff";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import {
  dominantPct, effectivePct, pillLabel, planColor, resetLabel, updatedLabel, type PlanWindow,
} from "../core/plan";
import { buildWardrobe } from "./wardrobe";
import type { OutfitSelection } from "../mochi/outfits";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
  emote(name: BotEmoteName): void;
  /** Question card: the answers go to Claude Code. */
  answerQuestion(answers: Record<string, string | string[]>): void;
  /** Question card: let the terminal ask instead. */
  replyInTerminal(): void;
  /** Wardrobe click: keeps the outfit and saves it. */
  chooseOutfit(selection: OutfitSelection): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** True while the view animates on its own and needs frames to finish. */
  busy?(): boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const planDot = h("i", { class: "dot", style: "width:6px;height:6px" });
  const planText = h("span", {});
  const planPill = h("button", {
    class: "plan-pill",
    title: "Claude plan",
    onclick: () => {
      actions.blip();
      State.showingPlanDetail = !State.showingPlanDetail;
      State.notify();
    },
  }, planDot, planText);
  let planHover = false;
  planPill.addEventListener("mouseenter", () => { planHover = true; paintPlanPill(); });
  planPill.addEventListener("mouseleave", () => { planHover = false; paintPlanPill(); });

  function paintPlanPill() {
    const color = planColor(dominantPct(State.planUsage));
    const active = State.showingPlanDetail || planHover;
    planDot.style.background = color;
    planText.textContent = pillLabel(State.planUsage);
    planText.style.color = active ? lighten(color, 0.3) : "#6B7079";
    planPill.style.background = active ? `${color}2e` : "#0E0F11";
    planPill.style.borderColor = active ? `${color}8c` : `${color}24`;
  }

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    h("div", { class: "header-actions" }, planPill, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
      const showPlan = v === "overview" && State.settings.showPlan && State.planRelayInstalled;
      planPill.style.display = showPlan ? "" : "none";
      if (showPlan) paintPlanPill();
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker((id) => {
    const task = State.focusTask;
    State.openDiff = task ? State.findDiff(task.id, id) : null;
    if (State.openDiff) actions.blip();
    State.notify();
  });
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "plan" | "diff" | null = null;
  let openDiffId: number | null = null;
  let planKey = "";
  let cardKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    busy: () => mode === "ticker" && ticker.animating,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
      // Countdowns move on their own; a 30 s step is what the Mac card uses.
      if (mode === "plan" && planKey !== planCardKey()) State.notify();
    },
    sync() {
      const task = State.focusTask;
      const planOpen = State.showingPlanDetail && State.settings.showPlan && State.planRelayInstalled;
      if (planOpen) {
        const key = planCardKey();
        if (mode !== "plan" || key !== planKey) {
          planKey = key;
          mode = "plan";
          cardKey = "";
          clear(leftBody);
          leftBody.append(planCard());
        }
        jump.style.display = "none";
        syncPills();
        return;
      }
      if (mode === "plan") mode = null;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
        ticker.reset();
        State.openDiff = null;
      }

      const diff = State.openDiff;
      if (diff) {
        if (mode !== "diff" || openDiffId !== diff.id) {
          mode = "diff";
          openDiffId = diff.id;
          cardKey = "";
          clear(leftBody);
          leftBody.append(diffCard(diff, () => {
            State.openDiff = null;
            actions.blip();
            State.notify();
          }));
        }
        jump.style.display = "none";
        syncPills();
        return;
      }
      if (mode === "diff") {
        mode = null;
        openDiffId = null;
      }

      // Session companions, and the Claude Code pill while it has something to
      // show, keep the ticker; every other pill shows its own card, exactly like
      // IntegrationCardView.
      const sessionActive = task != null && (isSession(task.id) ||
        (task.id === "integration_claude" && (task.state !== "idle" || task.steps.length > 0)));

      if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", {
            class: "tool",
            // A titled companion says which project it works in.
            text: isSession(task.id) && task.baseName && task.name !== task.baseName
              ? task.baseName
              : task.source === "claudeCode" ? "Claude Code" : "n8n",
          }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";
      syncPills();
    },
  };

  /** Four pills fit; beyond that three are shown and the fourth slot is "+N". */
  function syncPills() {
    const all = State.otherTasks;
    const overflow = all.length > 4;
    const others = overflow ? all.slice(0, 3) : all;
    const hidden = overflow ? all.slice(3) : [];
    const pillKey = others
      .map((t) => `${t.id}:${t.name}:${t.pillBadge ?? ""}${t.id === "integration_music" ? `:${State.musicPlaying}` : ""}`)
      .join("|") + `|+${hidden.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join(",")}`;
    if (pillKey !== pillIds) {
      pillIds = pillKey;
      clear(pills);
      for (const t of others) pills.append(buildPill(t, actions));
      if (overflow) pills.append(buildOverflowPill(hidden, actions));
      pruneMiniBots();
    }
  }
}

// ── Diff card ─────────────────────────────────────────────────────────────────

/** DiffCardView — the lines one edit changed, with three lines of context. */
function diffCard(diff: FileDiff, onBack: () => void): HTMLElement {
  const head = h("div", { class: "diff-head" },
    h("button", { class: "diff-back", onclick: onBack },
      svg(ICONS.chevronLeft, 8, { stroke: 2.4 }),
      h("span", { text: diffFileName(diff.path), title: diff.path }),
    ),
    h("span", { class: "grow" }),
  );
  if (diff.added > 0) head.append(h("span", { class: "add", text: `+${diff.added}` }));
  if (diff.removed > 0) head.append(h("span", { class: "del", text: `−${diff.removed}` }));
  head.append(h("button", {
    class: "diff-open",
    title: "Open the file",
    onclick: () => void Bridge.openFile(diff.path),
  }, svg(ICONS.arrowUpRight, 8)));

  const body = h("div", { class: "diff-lines" });
  if (diff.tooLarge) {
    body.append(h("div", { class: "diff-note", text: "Diff too large" }));
  } else if (diff.lines.length === 0) {
    body.append(h("div", { class: "diff-note", text: "No changes" }));
  } else {
    const sign = { added: "+", removed: "−", context: " " } as const;
    for (const line of diff.lines) {
      body.append(h("div", { class: `diff-line ${line.kind}` },
        h("i", { text: sign[line.kind] }),
        h("span", { text: line.text }),
      ));
    }
  }
  return h("div", { class: "diff-card" }, head, body);
}

// ── Claude plan card ──────────────────────────────────────────────────────────

/** Changes whenever the card's text would: new data, or the next 30 s step. */
function planCardKey(): string {
  return `${State.planUsage?.updatedAt ?? 0}~${Math.floor(Date.now() / 30_000)}`;
}

/** ClaudePlanCardView — two gauges with their reset times. */
function planCard(): HTMLElement {
  const usage = State.planUsage;
  const now = Date.now();
  const row = (label: string, w: PlanWindow | null, weekly: boolean) => {
    const el = h("div", { class: "plan-row" }, h("span", { class: "plan-label", text: label }));
    if (!w) {
      el.append(h("span", { class: "plan-dim", text: "—" }));
      return el;
    }
    const pct = effectivePct(w, now);
    const color = planColor(pct);
    const fill = h("i", { style: `width:${(50 * pct) / 100}px;background:${color}` });
    el.append(
      h("span", { class: "plan-bar" }, fill),
      h("span", { class: "plan-pct", text: `${Math.round(pct)}%` }),
      h("span", { class: "plan-dim", text: `↻ ${resetLabel(w, weekly, now)}` }),
    );
    return el;
  };
  return h(
    "div",
    { class: "int-card" },
    h("div", { class: "int-head" },
      dot(planColor(dominantPct(usage)), 7),
      h("b", { text: "Claude plan" }),
      h("span", { text: updatedLabel(usage, now) }),
    ),
    h("div", { class: "plan-rows" },
      row("5 hours", usage?.fiveHour ?? null, false),
      row("Week", usage?.sevenDay ?? null, true),
    ),
  );
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: isSession(task.id) ? "pill session" : "pill", title: task.name, onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.id === "integration_music" && State.integrations[task.id]?.data.title != null) {
    pill.classList.add("has-music");
    pill.style.setProperty("--c", task.color);
    const control = (icon: string, action: "playPause" | "next", title: string) =>
      h("button", {
        title,
        onclick: (e: Event) => {
          e.stopPropagation();
          void Bridge.musicControl(action);
        },
      }, svg(icon, 8));
    pill.append(
      h("div", { class: "pill-music" },
        control(State.musicPlaying ? ICONS.pause : ICONS.play, "playPause", State.musicPlaying ? "Pause" : "Play"),
        control(ICONS.forward, "next", "Next"),
      ),
    );
  }

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

/** "+N": the pills that didn't fit. A click brings the first of them into focus. */
function buildOverflowPill(hidden: AgentTask[], actions: ViewActions): HTMLElement {
  const badge = hidden.find((t) => t.pillBadge)?.pillBadge ?? null;
  const pill = h(
    "div",
    {
      class: "pill overflow",
      title: hidden.map((t) => t.name).join(", "),
      onclick: () => actions.setFocus((hidden.find((t) => t.pillBadge) ?? hidden[0]).id),
    },
    h("span", { class: "lbl", text: `+${hidden.length}` }),
  );
  if (badge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const inner = h("i", { style: `background:${colors[badge]}` });
    pill.append(h("div", { class: "pill-badge" }, inner));
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      const asking = State.tasks.find((t) => t.id === State.pendingApproval?.taskId) ?? State.focusTask;
      who.append(agentWho(asking, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code finished"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", { text: "Auto-close" });
  const autoInput = h("input", {
    type: "number", min: "1", max: "120", step: "1", class: "num-input",
  }) as HTMLInputElement;
  const commitAutoClose = () => {
    const value = Math.round(Number(autoInput.value));
    const seconds = Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(120, value)) : 15;
    autoInput.value = String(seconds);
    if (seconds !== State.settings.autoCloseInterval) actions.setAutoClose(seconds);
  };
  // The island only takes the keyboard while this field is being edited.
  autoInput.addEventListener("focus", () => void Bridge.focusWindow(true));
  autoInput.addEventListener("blur", () => {
    commitAutoClose();
    void Bridge.focusWindow(false);
  });
  autoInput.addEventListener("change", commitAutoClose);
  autoInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") autoInput.blur();
    e.stopPropagation();
  });
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, autoInput, h("span", { class: "num-unit", text: "s" })),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      if (document.activeElement !== autoInput) autoInput.value = String(Math.round(s.autoCloseInterval));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestionCard(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("mail", buildMail(actions));
  // Not in the Windows v1: window attach + web result.
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
