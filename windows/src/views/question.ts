// Claude Code's AskUserQuestion, answered from the island — port of QuestionView
// in IslandViewContent.swift. Single-select options answer on click; multi-select
// ones toggle and go with Send / Next; "Other…" takes free text.

import { h, clear, dot } from "./dom";
import { Bridge } from "../core/bridge";
import { buildAnswers } from "../core/ask";
import { washRGBA } from "../core/layout";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

export function buildQuestionCard(actions: ViewActions): ViewHost {
  const body = h("div", { class: "q-stack" });
  const card = h("div", { class: "card wash" }, body);
  card.style.setProperty("--wash", washRGBA("cyan"));
  const el = h("div", { class: "view" }, card);

  let forRequest: string | null = null;
  let index = 0;
  let selections: string[][] = [];
  let otherOpen = false;

  function reset(count: number) {
    index = 0;
    selections = Array.from({ length: count }, () => []);
    otherOpen = false;
  }

  function advance() {
    const q = State.pendingQuestion;
    if (!q) return;
    if (index >= q.items.length - 1) {
      actions.answerQuestion(buildAnswers(q.items, selections));
      return;
    }
    index += 1;
    otherOpen = false;
    actions.blip();
    render();
  }

  function render() {
    clear(body);
    const q = State.pendingQuestion;
    if (!q) {
      // Only the Notification hook spoke: nothing to answer here.
      const task = State.focusTask;
      body.append(
        who(task?.name ?? null, task?.color ?? null, "Claude Code is asking a question", null),
        h("div", { class: "title", text: task?.steps.at(-1) ?? "Claude needs an answer." }),
        h("div", { class: "sub", text: "Answer in your terminal." }),
      );
      return;
    }

    const task = State.tasks.find((t) => t.id === q.taskId) ?? null;
    const item = q.items[Math.min(index, q.items.length - 1)];
    const isLast = index >= q.items.length - 1;
    const counter = q.items.length > 1 ? `${index + 1}/${q.items.length}` : null;
    body.append(who(task?.name ?? null, task?.color ?? null, "is asking", counter, () => actions.replyInTerminal()));
    if (item.header) body.append(h("div", { class: "q-header", text: item.header }));
    body.append(h("div", { class: "q-text", text: item.question, title: item.question }));

    const sel = selections[index];
    if (otherOpen) {
      const input = h("input", { class: "q-other", placeholder: "Your answer…", spellcheck: "false" }) as HTMLInputElement;
      const go = h("button", { class: "btn secondary q-small", text: isLast ? "Send" : "Next" }) as HTMLButtonElement;
      go.disabled = true;
      const commit = () => {
        const text = input.value.trim();
        if (!text) return;
        selections[index] = [text];
        advance();
      };
      input.addEventListener("input", () => (go.disabled = input.value.trim() === ""));
      input.addEventListener("keydown", (e) => {
        const key = (e as KeyboardEvent).key;
        if (key === "Enter") commit();
        if (key === "Escape") {
          otherOpen = false;
          render();
        }
        e.stopPropagation();
      });
      // The island takes the keyboard only while this field is used.
      input.addEventListener("focus", () => void Bridge.focusWindow(true));
      input.addEventListener("blur", () => void Bridge.focusWindow(false));
      go.addEventListener("click", commit);
      const close = h("button", { class: "q-close", text: "✕", onclick: () => { otherOpen = false; render(); } });
      body.append(h("div", { class: "q-row" }, input, go, close));
      window.setTimeout(() => input.focus(), 60);
      return;
    }

    const chips = h("div", { class: "q-options" });
    for (const opt of item.options) {
      const on = sel.includes(opt.label);
      const b = h("button", {
        class: item.multiSelect ? `q-chip${on ? " on" : ""}` : "btn secondary q-small",
        text: opt.label,
        title: opt.description || opt.label,
      });
      b.addEventListener("click", () => {
        if (item.multiSelect) {
          selections[index] = on ? sel.filter((l) => l !== opt.label) : [...sel, opt.label];
          actions.blip();
          render();
        } else {
          selections[index] = [opt.label];
          advance();
        }
      });
      chips.append(b);
    }
    chips.append(h("button", {
      class: "btn secondary q-small",
      text: "Other…",
      onclick: () => { otherOpen = true; render(); },
    }));
    if (item.multiSelect) {
      const send = h("button", { class: "btn primary q-small", text: isLast ? "Send" : "Next" }) as HTMLButtonElement;
      send.disabled = sel.length === 0;
      send.addEventListener("click", advance);
      chips.append(send);
    }
    body.append(chips);
  }

  return {
    el,
    sync() {
      const q = State.pendingQuestion;
      const key = q?.requestId ?? null;
      if (key !== forRequest) {
        forRequest = key;
        reset(q?.items.length ?? 0);
        render();
      } else if (!q) {
        render();
      }
    },
  };
}

function who(name: string | null, color: string | null, label: string, counter: string | null, reply?: () => void): HTMLElement {
  const row = h("div", { class: "who-row q-who" });
  if (name && color) row.append(dot(color, 8), h("span", { class: "n", text: name }));
  row.append(h("span", { text: label }));
  const right = h("span", { class: "q-meta" });
  if (counter) right.append(h("span", { text: counter }));
  if (reply) right.append(h("button", { class: "q-link", text: "Reply in terminal", onclick: reply }));
  row.append(right);
  return row;
}
