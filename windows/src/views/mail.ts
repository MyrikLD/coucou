// "Send by email" — DOM port of MailView / MailField from IslandViewContent.swift.
// Rust decides how it goes out (Resend, or a draft in the mail client).

import { h } from "./dom";
import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { ViewActions, ViewHost } from "./views";

function field(label: string, input: HTMLInputElement): HTMLElement {
  return h("div", { class: "mail-field" }, h("span", { text: label }), input);
}

export function buildMail(actions: ViewActions): ViewHost {
  const fileName = h("span", { class: "mail-file" });
  const withLabel = h("span", { class: "mail-with", text: "with" });
  const to = h("input", { type: "text", placeholder: "address@example.com", spellcheck: "false" }) as HTMLInputElement;
  const subject = h("input", { type: "text", placeholder: "Subject", spellcheck: "false" }) as HTMLInputElement;
  const body = h("textarea", { class: "mail-body", spellcheck: "false" }) as HTMLTextAreaElement;
  const status = h("div", { class: "mail-status" });
  const sendBtn = h("button", { class: "btn primary", text: "Send" }) as HTMLButtonElement;
  const cancelBtn = h("button", { class: "btn secondary", text: "Cancel" });

  const stack = h(
    "div",
    { class: "mail-stack" },
    h("div", { class: "mail-head" }, h("b", { text: "New email" }), withLabel, fileName),
    field("To", to),
    field("Subject", subject),
    body,
    status,
    h("div", { class: "actions" }, sendBtn, cancelBtn),
  );
  const el = h("div", { class: "view" }, h("div", { class: "card" }, stack));

  let sending = false;
  let preparedFor: string | null = null;

  for (const input of [to, subject, body]) {
    // Escape closes the island, not the form; Enter in a field sends.
    input.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" && input !== body) {
        e.preventDefault();
        void submit();
      }
      e.stopPropagation();
    });
  }

  async function submit() {
    if (sending) return;
    const recipient = to.value.trim();
    if (!recipient) {
      status.textContent = "Missing recipient.";
      return;
    }
    const file = State.droppedFile;
    const subj = subject.value.trim() || file?.name || "File";
    sending = true;
    sendBtn.textContent = "Sending…";
    status.textContent = "";
    try {
      const outcome = await Bridge.sendMail(recipient, subj, body.value, file?.path ?? null);
      Sound.play("send");
      actions.emote("wink");
      State.noteMessage = outcome === "sent"
        ? `Email sent to ${recipient}.`
        : "Your mail client has the draft — send it from there.";
      preparedFor = null;
      actions.setView("note");
      window.setTimeout(() => {
        if (State.view === "note") actions.collapse();
      }, 2000);
    } catch (err) {
      status.textContent = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      sending = false;
      sendBtn.textContent = "Send";
    }
  }

  sendBtn.addEventListener("click", () => void submit());
  cancelBtn.addEventListener("click", () => actions.setView("choose"));

  return {
    el,
    sync() {
      const name = State.droppedFile?.name ?? "";
      fileName.textContent = name;
      withLabel.style.display = name ? "" : "none";
      subject.placeholder = name || "Subject";
      // A fresh form for every file, but typing survives re-renders.
      if (preparedFor !== name) {
        preparedFor = name;
        to.value = "";
        subject.value = name;
        body.value = "";
        status.textContent = "";
      }
    },
    focus() {
      to.focus();
    },
  };
}
