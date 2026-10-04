// Chat view — DOM port of PromptView / ModelPickerView / ChatBubble /
// TypingDotsView from IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent, type ChatContext, type ChatModel } from "../core/bridge";
import {
  CHAT_PROVIDERS, activeProvider, modelFor, providerVisible, type ChatProvider,
} from "../core/providers";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface ModelList {
  loading: boolean;
  models: ChatModel[] | null;
  error: string | null;
}

/** Fetched once per provider; local servers are asked again on every open. */
const modelLists = new Map<string, ModelList>();

function saveSettings() {
  void Bridge.saveSettings(State.settings);
  State.notify();
}

function buildPicker(onClose: () => void): { el: HTMLElement; open(): void; sync(): void } {
  const chips = h("div", { class: "picker-chips" });
  const list = h("div", { class: "picker-list" });
  const el = h("div", { class: "model-picker" }, chips, h("div", { class: "picker-divider" }), list);
  el.addEventListener("mousedown", (e) => e.stopPropagation());

  let renderedKey = "";

  function load(provider: ChatProvider, force: boolean) {
    const current = modelLists.get(provider.id);
    if (current && !force && (current.loading || current.models)) return;
    modelLists.set(provider.id, { loading: true, models: null, error: null });
    sync();
    Bridge.chatModels(provider.id)
      .then((models) => modelLists.set(provider.id, { loading: false, models, error: null }))
      .catch((err) =>
        modelLists.set(provider.id, {
          loading: false, models: null, error: String(err).replace(/^Error:\s*/, ""),
        }),
      )
      .finally(sync);
  }

  function choose(provider: ChatProvider) {
    if (provider.id === State.settings.chatProvider) return;
    State.settings.chatProvider = provider.id;
    Sound.play("pop");
    saveSettings();
    load(provider, provider.urlField != null);
  }

  function pickModel(provider: ChatProvider, id: string) {
    State.settings[provider.modelField] = id;
    Sound.play("blip");
    saveSettings();
    onClose();
  }

  function sync() {
    const s = State.settings;
    const provider = activeProvider(s);
    const entry = modelLists.get(provider.id);
    const selected = modelFor(s, provider);
    const key = [
      s.chatProvider, selected, s.ollamaUrl, s.lmstudioUrl,
      entry?.loading, entry?.error, entry?.models?.map((m) => m.id).join("|"),
    ].join("~");
    if (key === renderedKey) return;
    renderedKey = key;

    clear(chips);
    for (const p of CHAT_PROVIDERS.filter((x) => providerVisible(s, x))) {
      const on = p.id === s.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", onclick: () => choose(p) },
        h("i", { class: "dot", style: `width:5px;height:5px;background:${p.accent}` }),
        h("span", { text: p.name }),
      );
      if (on) {
        chip.style.background = `${p.accent}2e`;
        chip.style.borderColor = `${p.accent}80`;
      }
      chips.append(chip);
    }

    clear(list);
    if (!entry || entry.loading) {
      list.append(h("div", { class: "picker-note", text: "Loading models…" }));
    } else if (entry.error) {
      list.append(h("div", { class: "picker-note", text: entry.error }));
    } else if (entry.models) {
      if (entry.models.length === 0) {
        list.append(h("div", { class: "picker-note", text: "No models available." }));
      }
      for (const m of entry.models) {
        const on = m.id === selected;
        const row = h(
          "button",
          { class: "picker-row", onclick: () => pickModel(provider, m.id) },
          h("span", { text: m.label }),
          on ? svg(ICONS.check, 10, { stroke: 3 }) : null,
        );
        if (on) {
          row.style.color = provider.accent;
          row.style.background = `${provider.accent}1a`;
        }
        list.append(row);
      }
    }
  }

  return {
    el,
    open() {
      renderedKey = "";
      const provider = activeProvider(State.settings);
      load(provider, provider.urlField != null);
      sync();
    },
    sync,
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const modelDot = h("i", { class: "dot", style: "width:6px;height:6px" });
  const modelName = h("span", {});
  const modelBtn = h(
    "button",
    { class: "model-btn", title: "Model" },
    modelDot, modelName, svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  const modelRow = h("div", { class: "model-row" }, modelBtn);

  let pickerOpen = false;
  const picker = buildPicker(() => setPicker(false));
  picker.el.style.display = "none";

  function setPicker(open: boolean) {
    pickerOpen = open;
    State.chatPickerOpen = open;
    picker.el.style.display = open ? "" : "none";
    if (open) picker.open();
    onHeightChange();
  }
  modelBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  modelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    Sound.play("blip");
    setPicker(!pickerOpen);
  });

  const body = h("div", { class: "chat-body" }, chipRow, log, modelRow, bar);
  const card = h("div", { class: "card wash chat-card" }, body, picker.el);
  const el = h("div", { class: "view" }, card);
  card.style.setProperty("--wash", "rgba(99,102,241,0.5)");
  card.addEventListener("mousedown", () => {
    if (pickerOpen) setPicker(false);
  });

  let sending = false;
  let renderedCount = -1;
  /** Visible text of a reply that is still streaming in. */
  let streaming = "";
  let renderedStream = "";

  void onEvent<{ text: string }>("chat-delta", ({ text }) => {
    if (!sending) return;
    streaming = text;
    State.notify();
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (!modelFor(State.settings, activeProvider(State.settings))) {
      Sound.play("error");
      setPicker(true);
      return;
    }
    input.value = "";
    sending = true;
    streaming = "";
    setPicker(false);
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      streaming = "";
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (key === "Escape" && pickerOpen) {
      setPicker(false);
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount || streaming !== renderedStream) {
        renderedCount = count;
        renderedStream = streaming;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking && streaming) {
          log.append(bubble({ id: 0, role: "assistant", content: streaming }));
        } else if (thinking) {
          log.append(typingDots());
        }
        log.scrollTop = log.scrollHeight;
      }

      const provider = activeProvider(State.settings);
      modelDot.style.background = provider.accent;
      modelName.textContent = modelFor(State.settings, provider) || "Choose a model";
      if (pickerOpen) picker.sync();

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
