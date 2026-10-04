// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { CHAT_PROVIDERS, type ChatProvider } from "../core/providers";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { OUTFIT_NAMES, OUTFIT_SELECTIONS, parseOutfit } from "../mochi/outfits";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
let keyStore = "the system keychain";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (status.outdated) {
      body.append(h("div", {
        class: "notice warn",
        text: "Reinstall the hooks to answer Claude's questions from the island.",
      }));
    }

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Plan usage section ────────────────────────────────────────────────────────

function planSection(relayInstalled: boolean): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  let installed = relayInstalled;
  /** "Show in the island" was switched on before the relay existed. */
  let showAfterInstall = false;

  function draw() {
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: "Shows your Claude plan usage (5-hour and weekly limits) in the island header. Coucou adds a status line relay to ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only.",
      }),
      h("div", { class: "row" },
        h("label", { text: "Show in the island" }),
        toggle(settings.showPlan, (on) => {
          if (on && !installed) {
            showAfterInstall = true;
            void showPreview(true);
            return;
          }
          settings.showPlan = on;
          void save();
        }),
      ),
    );
    const relay = h("div", { class: "row" },
      h("label", { text: "Relay" }),
      h("span", { class: "hint", text: installed ? "installed" : "not installed" }),
    );
    relay.append(installed
      ? h("button", { class: "danger", text: "Uninstall relay…", onclick: () => void showPreview(false) })
      : h("button", { class: "primary", text: "Install relay…", onclick: () => void showPreview(true) }));
    body.append(relay);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.statuslinePreview(install);
    } catch (err) {
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", { text: "Back", onclick: draw })),
      );
      return;
    }
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json."
          : "This removes Coucou's status line and puts yours back, if you had one.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" }, h("span", { class: "path", text: `Backup → ${preview.backup}` })),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    }) as HTMLButtonElement;
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        await Bridge.statuslineApply(install, preview.fingerprint);
        installed = install;
        if (install && showAfterInstall) settings.showPlan = true;
        if (!install) settings.showPlan = false;
        showAfterInstall = false;
        void save();
        draw();
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => {
        showAfterInstall = false;
        draw();
      },
    })));
  }

  draw();
  return h("section", {}, h("h2", {}, h("span", { text: "Plan usage" })), body);
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? `Key saved in ${keyStore}.` : "No key yet — the chat needs one." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? `Key saved in ${keyStore}.`
      : "No key yet — the chat needs one.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Other chat providers ──────────────────────────────────────────────────────

/** A stored-secret row: the value is never read back, only whether it exists. */
function secretRow(key: string, label: string, placeholder: string, present: Record<string, boolean>): HTMLElement {
  const input = h("input", {
    type: "password",
    placeholder: present[key] ? "••••••••  (stored)" : placeholder,
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const saveBtn = h("button", { text: "Save" });
  const dotEl = statusDot(present[key] ?? false);
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    try {
      await Bridge.secretSet(key, value);
      present[key] = value.length > 0;
      input.value = "";
      input.placeholder = value ? "••••••••  (stored)" : placeholder;
      dotEl.style.background = value ? "#22c55e" : "#f4505e";
    } catch {
      dotEl.style.background = "#f5a524";
    }
  });
  return h("div", { class: "row" }, h("label", { text: label }), input, saveBtn, dotEl);
}

function providerTitle(p: ChatProvider, extra?: Node): HTMLElement {
  return h("div", { style: "display:flex;align-items:center;gap:8px" },
    h("i", { class: "dot", style: `background:${p.accent}` }),
    h("span", { style: "font-size:12.5px;font-weight:600", text: p.id === "google" ? "Google AI" : p.name }),
    extra ?? null,
  );
}

function chatProvidersSection(present: Record<string, boolean>): HTMLElement {
  const google = CHAT_PROVIDERS.find((p) => p.id === "google")!;
  const openai = CHAT_PROVIDERS.find((p) => p.id === "openai")!;
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Chat — other providers" })),
    h("div", { class: "hint", text: `To use Google Gemini or OpenAI from the chat. Keys are stored in ${keyStore}.` }),
    providerTitle(google),
    secretRow("google-api-key", "API key", "AI Studio key", present),
    providerTitle(openai),
    secretRow("openai-api-key", "API key", "sk-…", present),
  );
}

function localModelsSection(present: Record<string, boolean>): HTMLElement {
  const feedback = h("div", {});
  const blocks = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function block(p: ChatProvider): HTMLElement {
    const field = p.urlField!;
    const fallback = p.id === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234";
    const box = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
    const keyRow = secretRow(p.key, "API key", "optional — only behind an auth proxy", present);

    function draw() {
      clear(box);
      const url = settings[field];
      const connected = url !== "";
      box.append(providerTitle(p, connected
        ? h("span", { style: "font-size:10.5px;color:#22c55e", text: "Connected" })
        : undefined));
      if (connected) {
        box.append(h("div", { class: "row" },
          h("span", { class: "path", text: url }),
          h("button", {
            text: "Disconnect",
            onclick: () => {
              settings[field] = "";
              if (settings.chatProvider === p.id) settings.chatProvider = "anthropic";
              void save();
              clear(feedback);
              feedback.append(h("div", { class: "notice ok", text: `${p.name} disconnected.` }));
              draw();
            },
          }),
        ), keyRow);
        return;
      }
      const input = h("input", {
        type: "text", placeholder: fallback, spellcheck: "false", autocomplete: "off",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const connect = h("button", { class: "primary", text: "Connect" }) as HTMLButtonElement;
      connect.addEventListener("click", async () => {
        connect.disabled = true;
        connect.textContent = "Connecting…";
        clear(feedback);
        try {
          const probe = await Bridge.chatProbeLocal(p.id, input.value);
          settings[field] = probe.url;
          void save();
          feedback.append(h("div", {
            class: "notice ok",
            text: `✓ Connected · ${probe.models} model${probe.models === 1 ? "" : "s"}`,
          }));
          draw();
        } catch (err) {
          connect.disabled = false;
          connect.textContent = "Connect";
          feedback.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
        }
      });
      box.append(h("div", { class: "row" }, input, connect), keyRow);
    }

    draw();
    return box;
  }

  for (const p of CHAT_PROVIDERS.filter((x) => x.urlField)) blocks.append(block(p));

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Local models" })),
    h("div", { class: "hint", text: `Connect to a local or self-hosted model server. An API key is only needed when the server asks for one; save it before connecting. Keys are stored in ${keyStore}.` }),
    blocks,
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** Shown in place of the fields for a pill that needs no key. */
  hint?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [
      { key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true },
      { key: "resend-from", label: "Sender address", placeholder: "Mochi <hi@example.com>", secret: false },
    ] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MUSIC: IntegrationDef = {
  id: "integration_music", name: "Music", color: "#FA2D48", fields: [],
  hint: "What's playing in Spotify, your browser or any MPRIS player, with play, pause and skip. Mochi dances along.",
};

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>, musicSupported: boolean): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in ${keyStore}, never on disk.`;
  }

  for (const def of musicSupported ? [...INTEGRATIONS, MUSIC] : INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    if (def.hint) rows.append(h("div", { class: "hint", style: "padding-top:4px", text: def.hint }));
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "1", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(1, Math.min(120, Math.round(Number(autoClose.value)) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  const outfit = h("select", { id: "outfit-select" }) as HTMLSelectElement;
  for (const id of OUTFIT_SELECTIONS) outfit.append(h("option", { value: id, text: OUTFIT_NAMES[id] }));
  outfit.value = parseOutfit(settings.outfit);
  outfit.addEventListener("change", () => {
    settings.outfit = outfit.value;
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Mochi's outfit" }),
      outfit,
      h("span", { class: "hint", text: "or right-click Mochi" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
    keyStore = boot.keyStore;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, outdated: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const relayInstalled = (await Bridge.statuslineStatus()) ?? false;

  const keys = [
    "google-api-key", "openai-api-key", "ollama-api-key", "lmstudio-api-key",
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "resend-from", "notion-api-key", "calcom-api-key",
  ];
  const musicSupported = (await Bridge.musicSupported()) ?? false;
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    planSection(relayInstalled),
    apiSection(hasKey),
    chatProvidersSection(present),
    localModelsSection(present),
    integrationsSection(present, musicSupported),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
    // The wardrobe in the island can change the outfit while this window is open.
    const outfit = document.getElementById("outfit-select") as HTMLSelectElement | null;
    if (outfit) outfit.value = parseOutfit(settings.outfit);
  });
}

void main();
