// AskUserQuestion — port of AskQuestion.swift: the questions Claude Code asks
// through its AskUserQuestion tool, and the answers handed back to it.

export interface AskOption {
  label: string;
  description: string;
}

export interface AskItem {
  question: string;
  /** ≤ 12 characters, shown above the question. */
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

/** Null when malformed: Claude Code then asks in the terminal. */
export function parseQuestions(toolInput: unknown): AskItem[] | null {
  const raw = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const items: AskItem[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    const question = q?.question;
    const options = q?.options;
    if (typeof question !== "string" || !question) return null;
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) return null;
    const opts: AskOption[] = [];
    for (const o of options as Record<string, unknown>[]) {
      if (typeof o?.label !== "string" || !o.label) return null;
      opts.push({ label: o.label, description: typeof o.description === "string" ? o.description : "" });
    }
    items.push({
      question,
      header: typeof q.header === "string" ? q.header.slice(0, 12) : "",
      options: opts,
      multiSelect: q.multiSelect === true,
    });
  }
  return items;
}

/** Single-select answers are a string, multi-select ones an array of labels. */
export function buildAnswers(items: AskItem[], selections: string[][]): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  items.forEach((item, i) => {
    const sel = selections[i] ?? [];
    if (sel.length === 0) return;
    answers[item.question] = item.multiSelect ? sel : sel[0];
  });
  return answers;
}
