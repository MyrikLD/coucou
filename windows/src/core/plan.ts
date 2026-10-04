// Claude plan usage — port of ClaudePlanGauge.swift. Claude Code's status line
// payload carries `rate_limits`; coucou-hook --statusline relays them here.

export interface PlanWindow {
  /** 0–100, clamped. */
  usedPct: number;
  /** Epoch milliseconds. */
  resetsAt: number;
}

export interface PlanUsage {
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  /** Epoch milliseconds. */
  updatedAt: number;
}

function parseWindow(raw: unknown): PlanWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const pct = d.used_percentage;
  const epoch = d.resets_at;
  if (typeof pct !== "number" || pct < 0 || pct > 200) return null;
  if (typeof epoch !== "number" || epoch <= 0) return null;
  // More than 400 days out is milliseconds, not seconds: not the documented shape.
  if (epoch > Date.now() / 1000 + 400 * 86400) return null;
  return { usedPct: Math.min(100, pct), resetsAt: epoch * 1000 };
}

/** `rate_limits` from the status line payload; null when absent or malformed. */
export function parsePlan(limits: unknown): PlanUsage | null {
  if (!limits || typeof limits !== "object") return null;
  const l = limits as Record<string, unknown>;
  const fiveHour = parseWindow(l.five_hour);
  const sevenDay = parseWindow(l.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, updatedAt: Date.now() };
}

/** 0 once the window has reset. */
export function effectivePct(w: PlanWindow, now = Date.now()): number {
  return w.resetsAt <= now ? 0 : w.usedPct;
}

/** The higher of the two windows; null when neither is known. */
export function dominantPct(u: PlanUsage | null): number | null {
  if (!u) return null;
  const values = [u.fiveHour, u.sevenDay].filter((w): w is PlanWindow => w != null).map((w) => effectivePct(w));
  return values.length ? Math.max(...values) : null;
}

export function planColor(pct: number | null): string {
  if (pct == null) return "#6B7079";
  if (pct < 50) return "#22C55E";
  if (pct < 80) return "#F59E0B";
  return "#F4505E";
}

export function pillLabel(u: PlanUsage | null): string {
  const pct = dominantPct(u);
  return pct == null ? "Claude —" : `Claude ${Math.round(pct)}%`;
}

export function updatedLabel(u: PlanUsage | null, now = Date.now()): string {
  if (!u) return "Waiting for a Claude Code reply";
  const mins = Math.floor((now - u.updatedAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ago`;
}

export function resetLabel(w: PlanWindow, weekly: boolean, now = Date.now()): string {
  const secs = (w.resetsAt - now) / 1000;
  if (secs <= 0) return "Resetting…";
  if (weekly) {
    const d = new Date(w.resetsAt);
    const day = d.toLocaleDateString("en-US", { weekday: "short" });
    return `${day} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `in ${h} h ${m}` : `in ${m} min`;
}

const STORE_KEY = "coucou.planUsage";

/** The last reading survives a restart, like UserDefaults on macOS. */
export function loadPlan(): PlanUsage | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as PlanUsage) : null;
  } catch {
    return null;
  }
}

export function storePlan(u: PlanUsage) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(u));
  } catch {
    // Storage can be unavailable; the next status line refills it.
  }
}
