// GitHub card — port of GitHubPulseCardView, GitHubDetailView and the activity
// grid from IslandViewContent.swift. Each summary row opens its list.

import { h, svg, dot } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";

type Ci = "pending" | "success" | "failure" | "unknown";

interface Pr {
  id: string;
  title: string;
  url: string;
  repo: string;
  number: number;
  isDraft: boolean;
  ci: Ci;
}

interface RepoCi {
  repo: string;
  url: string;
  branch: string;
  ci: Ci;
}

interface Pulse {
  login: string;
  myPrs: Pr[];
  toReview: Pr[];
  mainCi: RepoCi[];
}

interface Day {
  date: string;
  count: number;
  level: number;
  weekday: number;
}

interface Activity {
  total: number;
  weeks: Day[][];
  login: string;
}

export type GitHubSection = "myPrs" | "toReview" | "mainCi" | "activity";

const CI_COLOR: Record<Ci, string> = {
  failure: "#F4505E", pending: "#F5A524", success: "#22C55E", unknown: "#6B7079",
};
const LEVEL_COLOR = ["rgba(255,255,255,0.06)", "#0E4429", "#006D32", "#26A641", "#39D353"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Square 7, gap 1.5, in a 202-wide column: 23 weeks, as on macOS. */
const GRID_WEEKS = Math.floor((202 + 1.5) / (7 + 1.5));

function data(): { stats: { totalRepos?: number; totalStars?: number }; pulse: Pulse | null; activity: Activity | null } {
  const d = (State.integrations.integration_github?.data ?? {}) as Record<string, unknown>;
  return {
    stats: d as { totalRepos?: number; totalStars?: number },
    pulse: (d.pulse as Pulse | null) ?? null,
    activity: (d.activity as Activity | null) ?? null,
  };
}

const worst = (states: Ci[]): Ci =>
  states.includes("failure") ? "failure" : states.includes("pending") ? "pending"
    : states.includes("success") ? "success" : "unknown";

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Only github.com links leave the island. */
function openGitHub(url: string) {
  try {
    if (new URL(url).host === "github.com") void Bridge.openUrl(url);
  } catch {
    // Not a URL: nothing to open.
  }
}

function lastDays(a: Activity, n: number): Day[] {
  return a.weeks.flat().slice(-n);
}

function square(level: number, size = 7): HTMLElement {
  return h("i", {
    class: "gh-day",
    style: `width:${size}px;height:${size}px;background:${LEVEL_COLOR[level] ?? LEVEL_COLOR[0]}`,
  });
}

function statRow(icon: string, color: string, label: string, value: string, onClick: () => void): HTMLElement {
  return h(
    "button",
    { class: "int-stat gh-stat", onclick: onClick },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

export function githubSummary(open: (section: GitHubSection) => void): HTMLElement {
  const { stats, pulse, activity } = data();
  const head = h("div", { class: "int-head" }, dot("#F4505E", 7), h("b", { text: "GitHub" }));
  if (stats.totalStars != null || activity) {
    const mini = h("button", { class: "gh-mini", onclick: () => open("activity") });
    if (stats.totalStars != null) mini.append(h("span", { text: `★ ${fmt(Number(stats.totalStars))}` }));
    if (activity) mini.append(h("span", { class: "gh-row7" }, ...lastDays(activity, 7).map((d) => square(d.level))));
    head.append(mini);
  } else {
    head.append(h("span", { text: "Overview" }));
  }

  const rows = h("div", { class: "int-stats" });
  if (pulse) {
    const prs = pulse.myPrs;
    const failing = prs.filter((p) => p.ci === "failure").length;
    const running = prs.some((p) => p.ci === "pending");
    const prValue = prs.length === 0 ? "0"
      : failing > 0 ? `${prs.length} · ${failing} failing`
      : running ? `${prs.length} · running` : String(prs.length);
    rows.append(statRow(ICONS.pull, CI_COLOR[worst(prs.map((p) => p.ci))], "My PRs", prValue, () => open("myPrs")));
    const reviews = pulse.toReview.length;
    rows.append(statRow(ICONS.eye, reviews > 0 ? "#8AB4F8" : "#6B7079", "To review", String(reviews), () => open("toReview")));
    const main = worst(pulse.mainCi.map((r) => r.ci));
    const mainValue = main === "failure" ? `${pulse.mainCi.filter((r) => r.ci === "failure").length} failing`
      : main === "pending" ? "running" : main === "success" ? "all green"
      : pulse.mainCi.length === 0 ? "no repos" : "unknown";
    rows.append(statRow(ICONS.seal, CI_COLOR[main], "Default branch CI", mainValue, () => open("mainCi")));
  } else {
    rows.append(
      h("div", { class: "int-stat" },
        h("i", { class: "int-stat-icon", style: "color:#F5A524" }, svg(ICONS.star, 10)),
        h("span", { class: "int-stat-label", text: "Total stars" }),
        h("span", { class: "int-stat-value", text: fmt(Number(stats.totalStars ?? 0)) })),
      h("div", { class: "int-stat" },
        h("i", { class: "int-stat-icon", style: "color:#6B7079" }, svg(ICONS.stack, 10)),
        h("span", { class: "int-stat-label", text: "Repositories" }),
        h("span", { class: "int-stat-value", text: String(stats.totalRepos ?? 0) })),
    );
  }
  return h("div", { class: "int-card" }, head, rows);
}

function backHeader(title: string, onBack: () => void, right?: Node): HTMLElement {
  const row = h("div", { class: "int-head gh-head" },
    h("button", { class: "diff-back", onclick: onBack }, svg(ICONS.chevronLeft, 8, { stroke: 2.4 }), h("span", { text: title })),
    h("span", { class: "grow" }),
  );
  if (right) row.append(right);
  return row;
}

function prRow(pr: Pr, showCi: boolean): HTMLElement {
  const short = pr.repo.split("/").pop() ?? pr.repo;
  return h(
    "button",
    { class: "gh-item", title: `${pr.repo}#${pr.number} ${pr.title}`, onclick: () => openGitHub(pr.url) },
    h("i", { class: "gh-ci", style: `background:${showCi && pr.ci !== "unknown" ? CI_COLOR[pr.ci] : "transparent"}` }),
    h("span", { class: "gh-ref", text: `${short}#${pr.number}` }),
    h("span", { class: "gh-title", text: pr.title }),
    pr.isDraft ? h("span", { class: "gh-draft", text: "Draft" }) : null,
  );
}

function repoRow(repo: RepoCi): HTMLElement {
  const word = { failure: "failing", pending: "running", success: "passing", unknown: "" }[repo.ci];
  const actions = repo.url.replace(/\/?$/, "/actions");
  return h(
    "button",
    { class: "gh-item", title: repo.repo, onclick: () => openGitHub(actions) },
    h("i", { class: "gh-ci", style: `background:${repo.ci !== "unknown" ? CI_COLOR[repo.ci] : "transparent"}` }),
    h("span", { class: "gh-ref", text: repo.repo.split("/").pop() ?? repo.repo }),
    h("span", { class: "gh-title", text: repo.branch }),
    word ? h("span", { class: "gh-word", style: `color:${CI_COLOR[repo.ci]}`, text: word }) : null,
  );
}

function activityDetail(activity: Activity | null, repos: number | undefined, onBack: () => void): HTMLElement {
  const summary = activity
    ? `${activity.total.toLocaleString("en-US")} past year${repos != null ? ` · ${repos} repos` : ""}`
    : "";
  const right = h("button", {
    class: "gh-mini",
    text: summary,
    onclick: () => activity?.login && openGitHub(`https://github.com/${activity.login}`),
  });
  const head = backHeader("Activity", onBack, activity ? right : undefined);
  if (!activity) return h("div", { class: "int-card" }, head, h("div", { class: "diff-note gh-note", text: "Loading…" }));

  const grid = h("div", { class: "gh-grid" });
  for (const week of activity.weeks.slice(-GRID_WEEKS)) {
    const col = h("div", { class: "gh-week" });
    for (let dow = 0; dow < 7; dow++) {
      const day = week.find((d) => d.weekday === dow);
      if (!day) {
        col.append(h("i", { class: "gh-day", style: "width:7px;height:7px" }));
        continue;
      }
      const cell = square(day.level);
      const [, m, d] = day.date.split("-").map(Number);
      const words = day.count === 0 ? "No contributions" : day.count === 1 ? "1 contribution" : `${day.count} contributions`;
      cell.addEventListener("mouseenter", () => (right.textContent = `${MONTHS[m - 1] ?? ""} ${d} · ${words}`));
      cell.addEventListener("mouseleave", () => (right.textContent = summary));
      col.append(cell);
    }
    grid.append(col);
  }
  return h("div", { class: "int-card" }, head, grid);
}

export function githubDetail(section: GitHubSection, onBack: () => void): HTMLElement {
  const { stats, pulse, activity } = data();
  if (section === "activity") return activityDetail(activity, stats.totalRepos, onBack);
  const title = { myPrs: "My PRs", toReview: "To review", mainCi: "Default branch CI" }[section];
  const list = h("div", { class: "gh-list" });
  const items = !pulse ? [] : section === "myPrs" ? pulse.myPrs.map((p) => prRow(p, true))
    : section === "toReview" ? pulse.toReview.map((p) => prRow(p, false))
    : pulse.mainCi.map(repoRow);
  if (items.length === 0) list.append(h("div", { class: "diff-note gh-note", text: "Nothing here" }));
  else list.append(...items);
  list.classList.toggle("fade", items.length > 3);
  return h("div", { class: "int-card" }, backHeader(title, onBack), list);
}

