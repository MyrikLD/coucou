// Live diffs of what Claude Code edits — port of DiffEngine.swift. Built from
// the Edit / MultiEdit / Write tool input, before the file is touched.

export type DiffKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface FileDiff {
  id: number;
  path: string;
  added: number;
  removed: number;
  /** Changed lines with three lines of context, hunks joined in order. */
  lines: DiffLine[];
  tooLarge: boolean;
  isNewFile: boolean;
}

const MAX_BYTES = 200 * 1024;
const MAX_LINES = 4000;
/** The LCS table is m×n: past this it costs more than the diff is worth. */
const MAX_CELLS = 1_000_000;
const CONTEXT = 3;

let nextId = 0;

function splitLines(text: string): string[] {
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function countFallback(oldText: string, newText: string, path: string): FileDiff {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  return {
    id: nextId++, path, lines: [], tooLarge: true, isNewFile: false,
    added: newLines.filter((l) => l && !oldSet.has(l)).length,
    removed: oldLines.filter((l) => l && !newSet.has(l)).length,
  };
}

function diffLines(a: string[], b: string[]): DiffLine[] {
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ kind: "context", text: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.push({ kind: "added", text: b[j - 1] });
      j--;
    } else {
      out.push({ kind: "removed", text: a[i - 1] });
      i--;
    }
  }
  return out.reverse();
}

/** Keeps the changed lines and CONTEXT lines around each. */
function withContext(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind === "context") return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(lines.length - 1, idx + CONTEXT); k++) keep[k] = true;
  });
  return lines.filter((_, idx) => keep[idx]);
}

export function diffFromEdit(oldText: string, newText: string, path: string): FileDiff {
  if (oldText.length + newText.length > MAX_BYTES) return countFallback(oldText, newText, path);
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length + b.length > MAX_LINES || a.length * b.length > MAX_CELLS) {
    return countFallback(oldText, newText, path);
  }
  const all = diffLines(a, b);
  return {
    id: nextId++, path, tooLarge: false, isNewFile: false,
    added: all.filter((l) => l.kind === "added").length,
    removed: all.filter((l) => l.kind === "removed").length,
    lines: withContext(all),
  };
}

export function diffFromNew(content: string, path: string): FileDiff {
  const lines = splitLines(content);
  const tooLarge = content.length > MAX_BYTES || lines.length > MAX_LINES;
  return {
    id: nextId++, path, removed: 0, isNewFile: true, tooLarge,
    added: lines.length,
    lines: tooLarge ? [] : lines.map((text) => ({ kind: "added" as const, text })),
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The diff a tool call is about to make, or null for anything else. */
export function diffForTool(tool: string, input: Record<string, unknown>): FileDiff | null {
  const path = str(input.file_path);
  if (!path) return null;
  let d: FileDiff | null = null;
  if (tool === "Edit") {
    const o = str(input.old_string) ?? "";
    const n = str(input.new_string) ?? "";
    if (o || n) d = diffFromEdit(o, n, path);
  } else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    const parts = (input.edits as Record<string, unknown>[])
      .map((e) => diffFromEdit(str(e?.old_string) ?? "", str(e?.new_string) ?? "", path));
    if (parts.length) {
      d = {
        id: nextId++, path, isNewFile: false,
        added: parts.reduce((s, p) => s + p.added, 0),
        removed: parts.reduce((s, p) => s + p.removed, 0),
        tooLarge: parts.some((p) => p.tooLarge),
        lines: parts.flatMap((p) => p.lines),
      };
    }
  } else if (tool === "Write") {
    const content = str(input.content);
    if (content) d = diffFromNew(content, path);
  }
  return d && (d.added > 0 || d.removed > 0) ? d : null;
}

// ── Diff steps in the ticker ──────────────────────────────────────────────────
// A step string carrying a diff: marker, file name, then counts and id — the
// same encoding as String.makeDiffStep on macOS.

const MARKER = "";

export function makeDiffStep(d: FileDiff): string {
  return `${MARKER}${fileName(d.path)}\t${d.added}:${d.removed}:${d.id}`;
}

export function parseDiffStep(step: string): { name: string; added: number; removed: number; id: number } | null {
  if (!step.startsWith(MARKER)) return null;
  const tab = step.indexOf("\t");
  if (tab < 0) return null;
  const [added, removed, id] = step.slice(tab + 1).split(":").map(Number);
  if (![added, removed, id].every(Number.isFinite)) return null;
  return { name: step.slice(1, tab), added, removed, id };
}

export { fileName as diffFileName };
