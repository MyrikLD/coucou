// Mochi's wardrobe — port of MochiWardrobe.swift and MochiOutfitDrawing.swift
// (itself a port of design/outfits/mochi-outfits.js) to Canvas 2D.
//
// Coordinates mirror BotEngine.draw(): origin at the body centre, y down,
// R = W·0.3, rx = 1.14R, ry = 0.88R. The head is a superellipsoid whose ring
// radius at height y (y up, −1…1) is r(y) = (1−|y|^2.7)^(1/2.7), so its
// silhouette matches the body path at yaw = pitch = 0.

import { Ease } from "../core/anim";

// ── Wardrobe ──────────────────────────────────────────────────────────────────

export type OutfitId =
  | "none" | "partyHat" | "beanie" | "crown" | "sunglasses" | "roundGlasses"
  | "bow" | "scarf" | "witchHat" | "pumpkin" | "santaHat" | "bunnyEars";

export type OutfitSelection = "auto" | OutfitId;

/** Outfit.allCases, in the same order. */
export const OUTFIT_SELECTIONS: readonly OutfitSelection[] = [
  "auto", "none", "partyHat", "beanie", "crown", "sunglasses", "roundGlasses",
  "bow", "scarf", "witchHat", "pumpkin", "santaHat", "bunnyEars",
];

export const OUTFIT_NAMES: Record<OutfitSelection, string> = {
  auto: "Auto (seasons)",
  none: "None",
  partyHat: "Party hat",
  beanie: "Beanie",
  crown: "Crown",
  sunglasses: "Sunglasses",
  roundGlasses: "Round glasses",
  bow: "Bow",
  scarf: "Scarf",
  witchHat: "Witch hat",
  pumpkin: "Pumpkin",
  santaHat: "Santa hat",
  bunnyEars: "Bunny ears",
};

/** A stored value, or "auto" when it is missing or unknown. */
export function parseOutfit(raw: string | null | undefined): OutfitSelection {
  return (OUTFIT_SELECTIONS as readonly string[]).includes(raw ?? "")
    ? (raw as OutfitSelection)
    : "auto";
}

/** Meeus/Jones/Butcher — month (1-based) and day of Easter Sunday. */
function easterDate(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/**
 * The outfit the seasons pick for `date`, in the user's local calendar.
 * Priority: party hat > Santa hat > witch hat > bunny ears > sunglasses > none.
 */
export function seasonalOutfit(date: Date): OutfitId {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return "partyHat";
  if (month === 12 && day <= 26) return "santaHat";
  if (month === 10 || (month === 11 && day === 1)) return "witchHat";

  const [eMonth, eDay] = easterDate(year);
  const easter = new Date(year, eMonth - 1, eDay);
  const today = new Date(year, month - 1, day);
  const delta = Math.round((today.getTime() - easter.getTime()) / 86_400_000);
  if (delta >= -2 && delta <= 1) return "bunnyEars";

  if ((month === 6 && day >= 21) || month === 7 || month === 8) return "sunglasses";
  return "none";
}

export function resolveOutfit(selection: OutfitSelection, date = new Date()): OutfitId {
  return selection === "auto" ? seasonalOutfit(date) : selection;
}

/** Body gradient the pumpkin swaps in for Mochi's own. */
export const PUMPKIN_COLORS = ["#FFA94D", "#E8590C"] as const;

// ── Head model ────────────────────────────────────────────────────────────────

const EXP = 2.7;
/** Accessories are seen slightly from above, so rings show as ellipses. */
const VIEW_TILT = -0.3;
/** Hats follow the head pitch only partly, so they never flip to a top-down view. */
const ACC_PITCH = 0.4;
const EYE_W = 0.25;
const EYE_H = 0.27;
const EYE_SP = 0.37;
const EYE_P = -0.12;

export interface Head {
  R: number;
  rx: number;
  ry: number;
  yaw: number;
  pitch: number;
  /** Spring lag of floppy parts (pompoms, hat tips), −1…1. */
  physDx: number;
  physDy: number;
  roll: number;
}

export function makeHead(R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0, roll = 0): Head {
  return { R, rx: R * 1.14, ry: R * 0.88, yaw, pitch, physDx, physDy, roll };
}

type V3 = readonly [number, number, number];

interface P3 {
  x: number;
  y: number;
  z: number;
}

interface Pt {
  x: number;
  y: number;
}

export interface EyeFrame {
  sd: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  visible: boolean;
  w: number;
  h: number;
}

/** Same spherical formula as the engine's eyes — not the accessory rotation. */
export function eyeFrames(H: Head): EyeFrame[] {
  return [-1, 1].map((sd) => {
    const eyeYaw = sd * EYE_SP + H.yaw;
    const eyePitch = EYE_P + H.pitch;
    const cp = Math.cos(eyePitch);
    return {
      sd,
      x: Math.sin(eyeYaw) * cp * H.rx,
      y: -Math.sin(eyePitch) * H.ry,
      fx: Math.max(0.18, Math.cos(eyeYaw)),
      fy: Math.max(0.18, cp),
      visible: Math.cos(eyeYaw) * cp > 0.04,
      w: H.R * EYE_W,
      h: H.R * EYE_H,
    };
  });
}

function ringR(y: number): number {
  const a = Math.min(1, Math.abs(y));
  return Math.pow(1 - Math.pow(a, EXP), 1 / EXP);
}

/** Rotates a head-local point (x right, y up, z toward the viewer) by yaw, then pitch. */
function rot3(p: V3, yaw: number, pitch: number): V3 {
  const [x, y, z] = p;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [x1, y * cp + z1 * sp, -y * sp + z1 * cp];
}

function proj(H: Head, p: V3): P3 {
  const r = rot3(p, H.yaw, VIEW_TILT + H.pitch * ACC_PITCH);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** Projection for accessories that turn with Mochi's roll (glasses, bow, scarf, pumpkin). */
function projRoll(H: Head, p: V3): P3 {
  const r = rot3(p, H.yaw, VIEW_TILT + H.pitch * ACC_PITCH + H.roll);
  return { x: r[0] * H.rx, y: -r[1] * H.ry, z: r[2] };
}

/** Point on the head surface at height y and longitude lon (0 faces the viewer). */
function surf(y: number, lon: number, s = 1): V3 {
  const r = ringR(y) * s;
  return [r * Math.sin(lon), y, r * Math.cos(lon)];
}

/**
 * Front half of a projected closed ring, left to right: the stretch between the
 * two silhouette extremes whose points sit closer to the viewer on average.
 */
function frontSilhouetteArc(pts: P3[]): P3[] {
  const n = pts.length;
  if (n < 2) return pts;
  let minIdx = 0;
  let maxIdx = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[minIdx].x) minIdx = i;
    if (pts[i].x > pts[maxIdx].x) maxIdx = i;
  }
  if (minIdx === maxIdx) return [pts[minIdx]];
  const walk = (step: number) => {
    const out: P3[] = [];
    let i = minIdx;
    for (;;) {
      out.push(pts[i]);
      if (i === maxIdx || out.length > n) break;
      i = (i + step + n) % n;
    }
    return out;
  };
  const a = walk(1);
  const b = walk(-1);
  const meanZ = (arr: P3[]) => arr.reduce((s, q) => s + q.z, 0) / Math.max(1, arr.length);
  return meanZ(a) >= meanZ(b) ? a : b;
}

function ringArc(H: Head, y: number, s: number, project: (H: Head, p: V3) => P3): P3[] {
  const n = 120;
  const pts: P3[] = [];
  for (let i = 0; i < n; i++) {
    const lon = -Math.PI + (i / n) * 2 * Math.PI;
    pts.push(project(H, surf(y, lon, s)));
  }
  return frontSilhouetteArc(pts);
}

const frontArc = (H: Head, y: number, s: number) => ringArc(H, y, s, proj);
const frontArcRoll = (H: Head, y: number, s: number) => ringArc(H, y, s, projRoll);

/** The region above the front arc of ring y — what a cap covers. */
function capClip(H: Head, y: number, s: number, extraTop = 3): Path2D {
  const arc = frontArc(H, y, s);
  const p = new Path2D();
  if (arc.length === 0) return p;
  const last = arc[arc.length - 1];
  p.moveTo(arc[0].x - H.rx, arc[0].y);
  for (const q of arc) p.lineTo(q.x, q.y);
  p.lineTo(last.x + H.rx, last.y);
  p.lineTo(H.rx * 2, -H.ry * extraTop);
  p.lineTo(-H.rx * 2, -H.ry * extraTop);
  p.closePath();
  return p;
}

/** A large rectangle plus `p`: clipped with "evenodd" it is everything outside `p`. */
function invert(p: Path2D, H: Head): Path2D {
  const q = new Path2D();
  q.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  q.addPath(p);
  return q;
}

function bigRect(H: Head): Path2D {
  const p = new Path2D();
  p.rect(-H.rx * 4, -H.ry * 4, H.rx * 8, H.ry * 8);
  return p;
}

/** Clean superellipse, same exponent as the engine's body path. */
export function mochiOutfitPath(rx: number, ry: number): Path2D {
  const n = 96;
  const e = 2 / EXP;
  const p = new Path2D();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = rx * (ca >= 0 ? Math.pow(ca, e) : -Math.pow(-ca, e));
    const y = ry * (sa >= 0 ? Math.pow(sa, e) : -Math.pow(-sa, e));
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

// ── Paint helpers ─────────────────────────────────────────────────────────────

type Stops = readonly (readonly [number, string])[];

function lin(x: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: Stops) {
  const g = x.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function rad(x: CanvasRenderingContext2D, cx: number, cy: number, r0: number, r1: number, stops: Stops) {
  const g = x.createRadialGradient(cx, cy, r0, cx, cy, r1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function polyline(pts: readonly Pt[]): Path2D {
  const p = new Path2D();
  pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
  return p;
}

function roundRect(p: Path2D | CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  p.moveTo(X + r, Y);
  p.arcTo(X + W, Y, X + W, Y + H, r);
  p.arcTo(X + W, Y + H, X, Y + H, r);
  p.arcTo(X, Y + H, X, Y, r);
  p.arcTo(X, Y, X + W, Y, r);
  p.closePath();
}

function stroke(
  x: CanvasRenderingContext2D, path: Path2D, color: string, width: number,
  cap: CanvasLineCap = "round",
) {
  x.strokeStyle = color;
  x.lineWidth = width;
  x.lineCap = cap;
  x.stroke(path);
}

/** Soft round pompom made of overlapping puffs. */
function pompom(
  x: CanvasRenderingContext2D, px: number, py: number, r: number,
  base = "#FFFFFF", shade = "rgb(213,217,226)",
) {
  x.save();
  x.translate(px, py);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const br = r * (0.34 + 0.06 * Math.sin(i * 2.3));
    const bx = Math.cos(a) * r * 0.78;
    const by = Math.sin(a) * r * 0.78;
    x.fillStyle = rad(x, bx - br * 0.4, by - br * 0.5, 0, br * 1.3, [[0, base], [1, shade]]);
    x.beginPath();
    x.arc(bx, by, br, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = rad(x, -r * 0.3, -r * 0.35, 0, r * 1.05, [[0, base], [0.7, base], [1, shade]]);
  x.beginPath();
  x.arc(0, 0, r * 0.86, 0, Math.PI * 2);
  x.fill();
  x.restore();
}

/** Fuzzy band along a polyline (the Santa hat trim). */
function fuzzyBand(
  x: CanvasRenderingContext2D, arc: P3[], thick: number,
  base = "#FFFFFF", shade = "rgb(218,221,228)",
) {
  if (arc.length < 2) return;
  const path = polyline(arc);
  x.save();
  x.lineJoin = "round";
  stroke(x, path, shade, thick);
  stroke(x, path, base, thick * 0.78);
  const step = Math.max(2, Math.floor(arc.length / 16));
  for (let i = 0; i < arc.length; i += step) {
    const q = arc[i];
    const r = thick * (0.32 + 0.1 * Math.sin(i * 1.7));
    x.fillStyle = rad(x, q.x - r * 0.3, q.y - thick * 0.35 - r * 0.3, 0, r * 1.2, [[0, base], [1, shade]]);
    x.beginPath();
    x.arc(q.x, q.y - thick * 0.32, r, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}

/** Fills everything inside the current clip. */
function wash(x: CanvasRenderingContext2D, H: Head, color: string) {
  x.fillStyle = color;
  x.fill(bigRect(H));
}

// ── Layers ────────────────────────────────────────────────────────────────────

let layerCanvas: HTMLCanvasElement | null = null;

/**
 * Draws `paint` at `alpha` as one flattened layer, so the overlapping parts of
 * an accessory fade together instead of showing through each other.
 */
function withLayer(x: CanvasRenderingContext2D, alpha: number, paint: (l: CanvasRenderingContext2D) => void) {
  if (alpha >= 0.999) {
    x.save();
    paint(x);
    x.restore();
    return;
  }
  const target = x.canvas;
  layerCanvas ??= document.createElement("canvas");
  if (layerCanvas.width !== target.width || layerCanvas.height !== target.height) {
    layerCanvas.width = target.width;
    layerCanvas.height = target.height;
  }
  const l = layerCanvas.getContext("2d");
  if (!l) return;
  l.setTransform(1, 0, 0, 1, 0, 0);
  l.clearRect(0, 0, layerCanvas.width, layerCanvas.height);
  l.setTransform(x.getTransform());
  l.save();
  paint(l);
  l.restore();
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha *= alpha;
  x.drawImage(layerCanvas, 0, 0);
  x.restore();
}

// ── Bunny ears ────────────────────────────────────────────────────────────────

/** `rollProgress`: 0 upright, 1 fully flattened. The ears ignore 3D roll. */
function drawBunnyEarsBack(x: CanvasRenderingContext2D, H: Head, rollProgress: number) {
  const R = H.R;
  const earH = R * 0.85;
  for (const sd of [-1, 1]) {
    const root = proj(H, [sd * 0.45, 0.92, 0]);
    const rootL = proj(H, [sd * 0.45 - 0.22, 0.92, 0]);
    const rootR = proj(H, [sd * 0.45 + 0.22, 0.92, 0]);
    const halfW = Math.max(R * 0.04, Math.abs(rootR.x - rootL.x) / 2);

    const flatten = Math.sin(rollProgress * Math.PI);
    const effH = earH * (1 - 0.8 * flatten);
    const tiltAngle = sd * 0.6 * flatten;

    x.save();
    x.translate(root.x, root.y - effH * 0.65 + effH * 0.5);
    x.rotate(tiltAngle);
    x.beginPath();
    x.ellipse(0, 0, halfW, effH / 2, 0, 0, Math.PI * 2);
    x.fillStyle = "#F9F0F0";
    x.fill();
    x.strokeStyle = "rgba(0,0,0,0.06)";
    x.lineWidth = 0.8;
    x.stroke();
    x.beginPath();
    x.ellipse(0, -effH / 2 + R * 0.1 + effH * 0.325, halfW * 0.5, effH * 0.325, 0, 0, Math.PI * 2);
    x.fillStyle = "rgba(252,165,165,0.7)";
    x.fill();
    x.restore();
  }
}

// ── Beanie ────────────────────────────────────────────────────────────────────

function drawBeanie(x: CanvasRenderingContext2D, H: Head, body: Path2D, simplified: boolean) {
  const s = 1.035;
  const yEdge = 0.42;
  const yCuff = 0.58;
  const head = mochiOutfitPath(H.rx * s, H.ry * s);

  x.save();
  x.clip(body);
  x.clip(capClip(H, yEdge - 0.12, 1));
  wash(x, H, "rgba(30,40,70,0.10)");
  x.restore();

  x.save();
  x.clip(capClip(H, yCuff, s));
  x.fillStyle = lin(x, H.rx * 0.5, -H.ry * 1.1, -H.rx * 0.6, H.ry * 0.2, [[0, "#7DB6FF"], [1, "#2F6FE0"]]);
  x.fill(head);
  if (!simplified) {
    x.clip(head);
    for (let k = -6; k <= 6; k++) {
      const lon = k * 0.24;
      const pts: P3[] = [];
      for (let i = 0; i <= 16; i++) {
        const q = proj(H, surf(yCuff + ((1.05 - yCuff) * i) / 16, lon, s));
        if (q.z > 0) pts.push(q);
      }
      if (pts.length < 2) continue;
      stroke(x, polyline(pts), "rgba(20,50,140,0.16)", H.R * 0.045);
    }
  }
  x.restore();

  const cuffHead = mochiOutfitPath(H.rx * s * 1.04, H.ry * s * 1.04);
  x.save();
  x.clip(capClip(H, yEdge, s * 1.04));
  x.clip(invert(capClip(H, yCuff, s * 1.04), H), "evenodd");
  x.fillStyle = lin(x, 0, -H.ry * 0.6, 0, -H.ry * 0.2, [[0, "#3C7BEA"], [1, "#2257C4"]]);
  x.fill(cuffHead);
  x.clip(cuffHead);
  for (let k = -14; k <= 14; k++) {
    const lon = k * 0.115;
    const a = proj(H, surf(yEdge, lon, s * 1.04));
    const b = proj(H, surf(yCuff, lon, s * 1.04));
    if (a.z < 0) continue;
    stroke(x, polyline([a, b]), "rgba(10,30,100,0.22)", H.R * 0.035, "butt");
  }
  x.restore();

  x.save();
  x.clip(capClip(H, yCuff, s));
  x.clip(head);
  x.fillStyle = rad(x, H.rx * 0.3, -H.ry * 0.85, 0, H.R * 0.45, [
    [0, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"],
  ]);
  x.fill(head);
  x.restore();

  const top = proj(H, [0, 1.08 * s, 0]);
  pompom(
    x,
    top.x + H.physDx * H.rx * 0.25,
    top.y - H.R * 0.12 + H.physDy * H.ry * 0.15,
    H.R * 0.24,
  );
}

// ── Santa hat ─────────────────────────────────────────────────────────────────

function drawSantaHat(x: CanvasRenderingContext2D, H: Head, body: Path2D) {
  const s = 1.05;
  const yEdge = 0.52;
  const arc = frontArc(H, yEdge, s);
  if (arc.length === 0) return;
  const L = arc[0];
  const Rt = arc[arc.length - 1];
  const crown = proj(H, [0, 1.05, 0]);
  const tip = {
    x: crown.x + H.rx * (0.95 + H.physDx * 0.35),
    y: crown.y + H.ry * (0.05 + H.physDy * 0.2),
  };
  const peak = { x: crown.x + H.rx * 0.25, y: crown.y - H.ry * 0.62 };

  const bag = new Path2D();
  bag.moveTo(L.x, L.y);
  bag.bezierCurveTo(L.x - H.rx * 0.05, L.y - H.ry * 0.7, peak.x - H.rx * 0.55, peak.y - H.ry * 0.05, peak.x, peak.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.05, peak.y - H.ry * 0.02, tip.x, tip.y);
  bag.quadraticCurveTo(tip.x - H.rx * 0.12, tip.y - H.ry * 0.22, peak.x + H.rx * 0.18, peak.y + H.ry * 0.32);
  bag.bezierCurveTo(Rt.x + H.rx * 0.05, peak.y + H.ry * 0.45, Rt.x + H.rx * 0.08, Rt.y - H.ry * 0.35, Rt.x, Rt.y);
  for (let i = arc.length - 1; i >= 0; i--) bag.lineTo(arc[i].x, arc[i].y);
  bag.closePath();

  x.save();
  x.clip(body);
  x.clip(capClip(H, yEdge - 0.14, 1));
  wash(x, H, "rgba(120,10,10,0.10)");
  x.restore();

  x.fillStyle = lin(x, -H.rx * 0.6, -H.ry * 1.6, H.rx * 0.7, -H.ry * 0.3, [
    [0, "#FF6B6B"], [0.55, "#E53935"], [1, "#B71C1C"],
  ]);
  x.fill(bag);

  x.save();
  x.clip(bag);
  for (const [a, b, w] of [[0.15, 0.55, 0.1], [0.45, 0.85, 0.08]] as const) {
    const fold = new Path2D();
    fold.moveTo(peak.x - H.rx * 0.1 + (Rt.x - L.x) * a * 0.3, peak.y + H.ry * 0.15);
    fold.quadraticCurveTo(
      peak.x + H.rx * 0.35, peak.y + H.ry * (0.05 + a * 0.3),
      tip.x - H.rx * (0.45 - b * 0.3), tip.y - H.ry * 0.12,
    );
    stroke(x, fold, "rgba(90,0,0,0.20)", H.R * w);
  }
  x.fillStyle = rad(x, peak.x - H.rx * 0.25, peak.y + H.ry * 0.05, 0, H.R * 0.5, [
    [0, "rgba(255,255,255,0.32)"], [1, "rgba(255,255,255,0)"],
  ]);
  x.fill(bag);
  x.restore();

  fuzzyBand(x, arc, H.R * 0.3);
  pompom(x, tip.x, tip.y + H.R * 0.04, H.R * 0.22);
}

// ── Party hat ─────────────────────────────────────────────────────────────────

function drawPartyHat(x: CanvasRenderingContext2D, H: Head, simplified: boolean) {
  const baseY = 0.82;
  const baseR = 0.42;
  const lean = -0.24 + H.physDx * 0.12;
  const c = proj(H, [0.16, baseY + 0.06, 0]);
  const ring: P3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    ring.push(proj(H, [0.16 + baseR * Math.sin(a), baseY + 0.06, baseR * Math.cos(a)]));
  }
  const left = ring.reduce((m, q) => (q.x < m.x ? q : m));
  const right = ring.reduce((m, q) => (q.x > m.x ? q : m));
  const h = H.ry * 1.6;
  const apex = { x: c.x + Math.sin(lean) * h, y: c.y - Math.cos(lean) * h };
  const front = frontSilhouetteArc(ring);

  const cone = new Path2D();
  cone.moveTo(left.x, left.y);
  cone.quadraticCurveTo((left.x + apex.x) / 2 - H.rx * 0.06, (left.y + apex.y) / 2, apex.x - H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo(apex.x, apex.y - H.R * 0.03, apex.x + H.R * 0.05, apex.y + H.R * 0.06);
  cone.quadraticCurveTo((right.x + apex.x) / 2 + H.rx * 0.06, (right.y + apex.y) / 2, right.x, right.y);
  for (let i = front.length - 1; i >= 0; i--) cone.lineTo(front[i].x, front[i].y);
  cone.closePath();

  x.fillStyle = lin(x, left.x, apex.y, right.x, left.y, [[0, "#FF9BD0"], [0.5, "#F15BAE"], [1, "#C2187A"]]);
  x.fill(cone);

  x.save();
  x.clip(cone);
  if (!simplified) {
    const dots = [[0.25, -0.35], [0.3, 0.3], [0.55, -0.05], [0.72, 0.28], [0.8, -0.3], [0.45, 0.6], [0.48, -0.65]] as const;
    x.fillStyle = "rgba(255,255,255,0.92)";
    for (const [t, u] of dots) {
      const bx = left.x + (right.x - left.x) * (0.5 + u * 0.5);
      const by = left.y + (right.y - left.y) * (0.5 + u * 0.5);
      const r = H.R * 0.075 * (0.6 + t * 0.5);
      x.beginPath();
      x.ellipse(bx + (apex.x - bx) * (1 - t), by + (apex.y - by) * (1 - t), r, r * 0.9, 0, 0, Math.PI * 2);
      x.fill();
    }
  }
  x.fillStyle = lin(x, left.x, 0, right.x, 0, [
    [0, "rgba(255,255,255,0.28)"], [0.35, "rgba(255,255,255,0)"], [1, "rgba(80,0,40,0.18)"],
  ]);
  x.fill(cone);
  x.restore();

  if (front.length > 1) stroke(x, polyline(front), "#FFD84D", H.R * 0.07);
  pompom(x, apex.x, apex.y - H.R * 0.04, H.R * 0.16, "#FFE27A", "#F2B705");
}

// ── Crown ─────────────────────────────────────────────────────────────────────

const CROWN_YB = 0.46;

/** side −1 draws the half behind the head, +1 the half in front. */
function drawCrownPart(x: CanvasRenderingContext2D, H: Head, side: number, simplified: boolean) {
  const s = 1.06;
  const yb = CROWN_YB;
  const yt = 0.66;
  const n = 8;
  const spikeH = 0.42;
  const N = 120;
  const seg: { b: P3; tt: P3; z: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const lon = -Math.PI + (i / N) * 2 * Math.PI;
    const b = proj(H, surf(yb, lon, s));
    const phase = ((lon + Math.PI) / (2 * Math.PI)) * n;
    const f = phase - Math.floor(phase);
    const spike = Math.pow(Math.max(0, 1 - Math.abs(f - 0.5) * 2), 1.6);
    const sp = surf(yt, lon, s);
    const tt = proj(H, [sp[0] * (1 - 0.08 * spike), yt + spikeH * spike, sp[2] * (1 - 0.08 * spike)]);
    seg.push({ b, tt, z: b.z });
  }
  const keep = seg.filter((q) => (side > 0 ? q.z >= 0 : q.z < 0.02));
  if (keep.length < 2) return;
  keep.sort((a, b) => a.b.x - b.b.x);

  const shape = new Path2D();
  keep.forEach((q, i) => (i ? shape.lineTo(q.tt.x, q.tt.y) : shape.moveTo(q.tt.x, q.tt.y)));
  for (let i = keep.length - 1; i >= 0; i--) shape.lineTo(keep[i].b.x, keep[i].b.y);
  shape.closePath();

  const dark = side < 0;
  x.fillStyle = lin(
    x, 0, -H.ry * 1.05, 0, -H.ry * 0.45,
    dark ? [[0, "#C98A12"], [1, "#8A5A06"]] : [[0, "#FFE58A"], [0.5, "#FBBF24"], [1, "#D08A0B"]],
  );
  x.fill(shape);
  if (dark) return;

  x.save();
  x.clip(shape);
  x.fillStyle = lin(x, -H.rx, 0, H.rx, 0, [
    [0, "rgba(120,70,0,0.25)"], [0.45, "rgba(255,255,255,0)"],
    [0.62, "rgba(255,255,255,0.35)"], [1, "rgba(120,70,0,0.25)"],
  ]);
  x.fill(shape);
  x.restore();

  if (simplified) return;
  const gems = ["#EF4444", "#3B82F6", "#22C55E", "#A855F7"];
  for (let k = 0; k < n; k++) {
    const lon = -Math.PI + ((k + 0.5) / n) * 2 * Math.PI;
    const sp = surf(yt, lon, s);
    const tipP = proj(H, [sp[0] * 0.92, yt + spikeH, sp[2] * 0.92]);
    const mid = proj(H, surf((yb + yt) / 2, lon, s * 1.01));
    if (mid.z <= 0.12) continue;
    const r = H.R * 0.055;
    x.beginPath();
    x.arc(tipP.x, tipP.y - r * 0.5, r, 0, Math.PI * 2);
    x.fillStyle = rad(x, tipP.x - r * 0.3, tipP.y - r, 0, r * 1.2, [[0, "#FFF6CC"], [1, "#E0A21A"]]);
    x.fill();
    const gr = H.R * 0.075;
    x.beginPath();
    x.ellipse(mid.x, mid.y, gr * Math.max(0.35, mid.z), gr, 0, 0, Math.PI * 2);
    x.fillStyle = gems[k % gems.length];
    x.fill();
    x.beginPath();
    x.arc(mid.x - gr * 0.25 * mid.z, mid.y - gr * 0.35, gr * 0.28, 0, Math.PI * 2);
    x.fillStyle = "rgba(255,255,255,0.75)";
    x.fill();
  }
}

function drawCrownFront(x: CanvasRenderingContext2D, H: Head, body: Path2D, simplified: boolean) {
  x.save();
  x.clip(body);
  x.clip(capClip(H, CROWN_YB - 0.1, 1));
  x.clip(invert(capClip(H, CROWN_YB, 1), H), "evenodd");
  wash(x, H, "rgba(80,50,0,0.12)");
  x.restore();
  drawCrownPart(x, H, 1, simplified);
}

// ── Witch hat ─────────────────────────────────────────────────────────────────

function witchBrimPts(H: Head): P3[] {
  const y = 0.7;
  const rr = 1.42;
  const pts: P3[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = -Math.PI + (i / 120) * 2 * Math.PI;
    const wob = 1 + 0.035 * Math.sin(a * 3 + 0.6);
    const droop = -0.1 * Math.pow(Math.abs(Math.sin(a)), 2);
    pts.push(proj(H, [rr * wob * Math.sin(a), y + droop, rr * wob * Math.cos(a)]));
  }
  return pts;
}

function drawWitchHatBack(x: CanvasRenderingContext2D, H: Head) {
  const pts = witchBrimPts(H);
  if (!pts.some((q) => q.z < 0.05)) return;
  const brim = polyline(pts);
  brim.closePath();
  x.fillStyle = lin(x, 0, -H.ry, 0, -H.ry * 0.4, [[0, "#2A0A4F"], [1, "#3B0F6B"]]);
  x.fill(brim);
}

function drawWitchHatFront(x: CanvasRenderingContext2D, H: Head, body: Path2D) {
  const all = witchBrimPts(H);
  const brim = polyline(all);
  brim.closePath();
  const fr = all.filter((q) => q.z >= 0).sort((a, b) => a.x - b.x);

  x.save();
  x.clip(body);
  x.clip(capClip(H, 0.5, 1));
  wash(x, H, "rgba(40,0,70,0.10)");
  x.restore();

  x.fillStyle = lin(x, 0, -H.ry * 0.9, 0, -H.ry * 0.3, [[0, "#5B21B6"], [1, "#3B0764"]]);
  x.fill(brim);
  if (fr.length > 1) stroke(x, polyline(fr), "rgba(190,150,255,0.35)", H.R * 0.035);

  const baseR = 0.62;
  const by = 0.74;
  const bl = proj(H, [-baseR, by, 0]);
  const br = proj(H, [baseR, by, 0]);
  const c = proj(H, [0, by, 0]);
  const lean = 0.1 + H.physDx * 0.15;
  const top = { x: c.x + H.rx * 0.18 + Math.sin(lean) * H.ry * 0.3, y: c.y - H.ry * 1.25 };
  const tip = {
    x: top.x + H.rx * (0.45 + H.physDx * 0.25),
    y: top.y + H.ry * (0.22 + H.physDy * 0.1),
  };
  const capFront = frontArc(H, by, baseR / ringR(by)).filter((q) => q.x >= bl.x - 1 && q.x <= br.x + 1);

  const cone = new Path2D();
  cone.moveTo(bl.x, bl.y);
  cone.bezierCurveTo(bl.x + H.rx * 0.12, bl.y - H.ry * 0.5, top.x - H.rx * 0.28, top.y + H.ry * 0.25, top.x - H.rx * 0.02, top.y - H.ry * 0.02);
  cone.quadraticCurveTo(top.x + H.rx * 0.25, top.y - H.ry * 0.08, tip.x, tip.y);
  cone.quadraticCurveTo(top.x + H.rx * 0.22, top.y + H.ry * 0.08, top.x + H.rx * 0.14, top.y + H.ry * 0.22);
  cone.bezierCurveTo(br.x - H.rx * 0.18, c.y - H.ry * 0.45, br.x - H.rx * 0.02, br.y - H.ry * 0.2, br.x, br.y);
  for (let i = capFront.length - 1; i >= 0; i--) cone.lineTo(capFront[i].x, capFront[i].y);
  cone.closePath();

  x.fillStyle = lin(x, bl.x, top.y, br.x, bl.y, [[0, "#7C3AED"], [0.55, "#4C1D95"], [1, "#2E1065"]]);
  x.fill(cone);

  x.save();
  x.clip(cone);
  x.fillStyle = lin(x, bl.x, 0, br.x, 0, [
    [0, "rgba(255,255,255,0.22)"], [0.4, "rgba(255,255,255,0)"], [1, "rgba(0,0,0,0.15)"],
  ]);
  x.fill(cone);
  const crease = new Path2D();
  crease.moveTo(top.x - H.rx * 0.05, top.y + H.ry * 0.05);
  crease.quadraticCurveTo(top.x + H.rx * 0.1, top.y + H.ry * 0.12, top.x + H.rx * 0.2, top.y + H.ry * 0.06);
  stroke(x, crease, "rgba(20,0,40,0.35)", H.R * 0.05);
  const fc = proj(H, [0, by, baseR]);
  const lift = H.ry * 0.11;
  const band = new Path2D();
  band.moveTo(bl.x - 2, bl.y - lift);
  band.quadraticCurveTo(fc.x, 2 * (fc.y - lift) - (bl.y + br.y) / 2, br.x + 2, br.y - lift);
  stroke(x, band, "#F97316", H.ry * 0.17, "butt");
  x.restore();

  const bw = H.R * 0.2;
  const bh = H.R * 0.16;
  x.save();
  x.translate(fc.x, fc.y - H.ry * 0.11);
  const buckle = new Path2D();
  roundRect(buckle, -bw / 2, -bh / 2, bw, bh, bh * 0.25);
  x.fillStyle = "#FCD34D";
  x.fill(buckle);
  const hole = new Path2D();
  roundRect(hole, -bw / 2 + bw * 0.24, -bh / 2 + bh * 0.28, bw * 0.52, bh * 0.44, bh * 0.1);
  x.fillStyle = "#C2410C";
  x.fill(hole);
  x.restore();
}

// ── Glasses ───────────────────────────────────────────────────────────────────

function rolledEyes(H: Head): EyeFrame[] {
  return eyeFrames(makeHead(H.R, H.yaw, H.pitch + H.roll, H.physDx, H.physDy));
}

function drawSunglasses(x: CanvasRenderingContext2D, H: Head, body: Path2D) {
  const eyes = rolledEyes(H);
  const w = H.R * 0.62;
  const h = H.R * 0.46;
  x.save();
  x.clip(body);
  const [le, re] = eyes;
  if (le.visible && re.visible) {
    const bridge = new Path2D();
    bridge.moveTo(le.x + (w / 2) * le.fx * 0.9, le.y - h * 0.18);
    bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - h * 0.42, re.x - (w / 2) * re.fx * 0.9, re.y - h * 0.18);
    stroke(x, bridge, "#111317", H.R * 0.07);
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    const ox = e.x + (e.sd * w * e.fx) / 2;
    stroke(x, polyline([{ x: ox, y: e.y - h * 0.2 }, { x: e.sd * H.rx * 1.05, y: e.y - h * 0.35 }]), "#111317", H.R * 0.06);
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    x.save();
    x.translate(e.x, e.y);
    x.scale(e.fx, e.fy);
    const lens = new Path2D();
    roundRect(lens, -w / 2, -h / 2, w, h, h * 0.42);
    x.fillStyle = "rgba(17,19,23,0.82)";
    x.fill(lens);
    stroke(x, lens, "#0B0C0F", H.R * 0.05, "butt");
    stroke(x, polyline([{ x: -w * 0.28, y: -h * 0.05 }, { x: -w * 0.05, y: -h * 0.3 }]), "rgba(255,255,255,0.45)", H.R * 0.05);
    x.restore();
  }
  x.restore();
}

function drawRoundGlasses(x: CanvasRenderingContext2D, H: Head, body: Path2D) {
  const eyes = rolledEyes(H);
  const d = H.R * 0.56;
  x.save();
  x.clip(body);
  const [le, re] = eyes;
  if (le.visible && re.visible) {
    const bridge = new Path2D();
    bridge.moveTo(le.x + (d / 2) * le.fx, le.y - d * 0.08);
    bridge.quadraticCurveTo((le.x + re.x) / 2, (le.y + re.y) / 2 - d * 0.3, re.x - (d / 2) * re.fx, re.y - d * 0.08);
    stroke(x, bridge, "#8A4B12", H.R * 0.055);
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    stroke(
      x,
      polyline([{ x: e.x + (e.sd * d * e.fx) / 2, y: e.y - d * 0.1 }, { x: e.sd * H.rx * 1.05, y: e.y - d * 0.25 }]),
      "#8A4B12", H.R * 0.05,
    );
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    x.save();
    x.translate(e.x, e.y);
    x.scale(e.fx, e.fy);
    const circle = new Path2D();
    circle.arc(0, 0, d / 2, 0, Math.PI * 2);
    x.fillStyle = "rgba(190,225,255,0.18)";
    x.fill(circle);
    stroke(x, circle, "#9A5A1A", H.R * 0.065);
    const glint = new Path2D();
    glint.arc(0, 0, d / 2 - H.R * 0.03, Math.PI * 1.1, Math.PI * 1.45);
    stroke(x, glint, "rgba(255,255,255,0.55)", H.R * 0.03);
    x.restore();
  }
  x.restore();
}

// ── Scarf ─────────────────────────────────────────────────────────────────────

function drawScarf(x: CanvasRenderingContext2D, H: Head) {
  const s = 1.05;
  const y0 = -0.34;
  const y1 = -0.66;
  const top = frontArcRoll(H, y0, s);
  const bot = frontArcRoll(H, y1, s);
  if (top.length === 0 || bot.length === 0) return;

  const band = polyline(top);
  for (let i = bot.length - 1; i >= 0; i--) band.lineTo(bot[i].x, bot[i].y);
  band.closePath();

  x.save();
  x.clip(mochiOutfitPath(H.rx * s, H.ry * s));
  x.fillStyle = lin(x, 0, -H.ry * 0.2, 0, H.ry * 0.7, [[0, "#F87171"], [1, "#B91C1C"]]);
  x.fill(band);
  x.save();
  x.clip(band);
  for (const lon of [-1.0, -0.45, 0.1, 0.65, 1.2]) {
    const a = proj(H, surf(y0, lon, s));
    const b = proj(H, surf(y1, lon, s));
    if (a.z < 0) continue;
    stroke(
      x, polyline([{ x: a.x, y: a.y - 4 }, { x: b.x, y: b.y + 4 }]),
      "rgba(255,255,255,0.85)", H.R * 0.09 * Math.max(0.3, a.z),
    );
  }
  x.restore();
  x.fillStyle = lin(x, 0, -H.ry * 0.5, 0, H.ry * 0.3, [[0, "rgba(255,255,255,0.18)"], [1, "rgba(0,0,0,0.10)"]]);
  x.fill(band);
  x.restore();

  const k = proj(H, surf((y0 + y1) / 2, -0.55, s * 1.03));
  if (k.z <= 0) return;
  const sw = H.physDx * H.rx * 0.12;
  const end = new Path2D();
  end.moveTo(k.x - H.R * 0.16, k.y);
  end.quadraticCurveTo(k.x - H.R * 0.24 + sw, k.y + H.ry * 0.35, k.x - H.R * 0.2 + sw * 1.4, k.y + H.ry * 0.62);
  end.lineTo(k.x + H.R * 0.06 + sw * 1.4, k.y + H.ry * 0.6);
  end.quadraticCurveTo(k.x + H.R * 0.02 + sw, k.y + H.ry * 0.3, k.x + H.R * 0.12, k.y);
  end.closePath();
  x.fillStyle = lin(x, 0, k.y, 0, k.y + H.ry * 0.6, [[0, "#EF4444"], [1, "#B91C1C"]]);
  x.fill(end);

  x.save();
  x.clip(end);
  x.fillStyle = "rgba(255,255,255,0.85)";
  for (const t of [0.35, 0.7]) x.fillRect(k.x - H.R * 0.4 + sw, k.y + H.ry * 0.62 * t, H.R * 0.8, H.R * 0.07);
  x.restore();

  for (let i = 0; i < 4; i++) {
    const fx = k.x - H.R * 0.17 + sw * 1.4 + i * H.R * 0.075;
    stroke(x, polyline([{ x: fx, y: k.y + H.ry * 0.6 }, { x: fx, y: k.y + H.ry * 0.72 }]), "#DC2626", H.R * 0.035);
  }

  x.save();
  x.translate(k.x, k.y);
  x.rotate(0.2);
  x.beginPath();
  x.ellipse(0, 0, H.R * 0.17, H.R * 0.14, 0, 0, Math.PI * 2);
  x.fillStyle = rad(x, -H.R * 0.05, -H.R * 0.05, 0, H.R * 0.2, [[0, "#F87171"], [1, "#B91C1C"]]);
  x.fill();
  x.restore();
}

// ── Pumpkin ───────────────────────────────────────────────────────────────────

/** Ribs, stem and leaf; the orange body comes from PUMPKIN_COLORS in the engine. */
function drawPumpkin(x: CanvasRenderingContext2D, H: Head, body: Path2D, simplified: boolean) {
  if (!simplified) {
    x.save();
    x.clip(body);
    for (const lon of [-1.15, -0.55, 0, 0.55, 1.15]) {
      const pts: P3[] = [];
      for (let i = 0; i <= 30; i++) {
        const q = projRoll(H, surf(-0.98 + (1.96 * i) / 30, lon, 1));
        if (q.z > 0) pts.push(q);
      }
      if (pts.length < 2) continue;
      const zz = pts[Math.floor(pts.length / 2)].z;
      stroke(x, polyline(pts), `rgba(150,50,0,${0.22 * zz})`, H.R * 0.12);
      stroke(x, polyline(pts.map((q) => ({ x: q.x + H.R * 0.07, y: q.y }))), `rgba(255,220,170,${0.18 * zz})`, H.R * 0.04);
    }
    x.restore();
  }

  const t = projRoll(H, [0.02, 1.0, 0]);
  const stem = new Path2D();
  stem.moveTo(t.x - H.R * 0.09, t.y + H.R * 0.04);
  stem.quadraticCurveTo(t.x - H.R * 0.08, t.y - H.R * 0.22, t.x + H.R * 0.08, t.y - H.R * 0.3);
  stem.lineTo(t.x + H.R * 0.13, t.y - H.R * 0.22);
  stem.quadraticCurveTo(t.x + H.R * 0.04, t.y - H.R * 0.15, t.x + H.R * 0.08, t.y + H.R * 0.04);
  stem.closePath();
  x.fillStyle = lin(x, t.x - H.R * 0.1, 0, t.x + H.R * 0.1, 0, [[0, "#65A30D"], [1, "#3F6212"]]);
  x.fill(stem);

  x.save();
  x.translate(t.x - H.R * 0.06, t.y - H.R * 0.02);
  x.rotate(-0.5);
  const leaf = new Path2D();
  leaf.moveTo(0, 0);
  leaf.quadraticCurveTo(-H.R * 0.18, -H.R * 0.2, -H.R * 0.38, -H.R * 0.02);
  leaf.quadraticCurveTo(-H.R * 0.18, H.R * 0.1, 0, 0);
  x.fillStyle = lin(x, 0, -H.R * 0.15, -H.R * 0.3, 0, [[0, "#84CC16"], [1, "#4D7C0F"]]);
  x.fill(leaf);
  const vein = new Path2D();
  vein.moveTo(-H.R * 0.02, -H.R * 0.01);
  vein.quadraticCurveTo(-H.R * 0.18, -H.R * 0.08, -H.R * 0.32, -H.R * 0.03);
  stroke(x, vein, "rgba(30,60,0,0.4)", H.R * 0.02);
  x.restore();

  if (!simplified) {
    const tendril = new Path2D();
    tendril.moveTo(t.x + H.R * 0.1, t.y - H.R * 0.12);
    tendril.bezierCurveTo(t.x + H.R * 0.3, t.y - H.R * 0.25, t.x + H.R * 0.35, t.y - H.R * 0.02, t.x + H.R * 0.22, t.y - H.R * 0.06);
    stroke(x, tendril, "#4D7C0F", H.R * 0.03);
  }
}

// ── Bow ───────────────────────────────────────────────────────────────────────

function drawBow(x: CanvasRenderingContext2D, H: Head) {
  const a = projRoll(H, surf(0.86, 0.55, 1.02));
  if (a.z < -0.2) return;
  const s = H.R * 0.26;
  const sq = Math.max(0.45, Math.cos(0.55 + H.yaw));
  x.save();
  x.translate(a.x, a.y);
  x.rotate(0.35 + H.yaw * 0.3);
  x.scale(sq, 1);
  for (const sd of [-1, 1]) {
    const wing = new Path2D();
    wing.moveTo(0, 0);
    wing.bezierCurveTo(sd * s * 0.6, -s * 0.85, sd * s * 1.35, -s * 0.55, sd * s * 1.15, 0);
    wing.bezierCurveTo(sd * s * 1.35, s * 0.55, sd * s * 0.6, s * 0.85, 0, 0);
    x.fillStyle = lin(x, 0, -s, 0, s, [[0, "#FF8CC6"], [1, "#DB2777"]]);
    x.fill(wing);
    const crease = new Path2D();
    crease.moveTo(sd * s * 0.25, -s * 0.05);
    crease.quadraticCurveTo(sd * s * 0.7, -s * 0.15, sd * s * 0.95, -s * 0.05);
    stroke(x, crease, "rgba(140,10,70,0.35)", s * 0.08);
  }
  x.beginPath();
  x.ellipse(0, 0, s * 0.24, s * 0.3, 0, 0, Math.PI * 2);
  x.fillStyle = rad(x, -s * 0.06, -s * 0.1, 0, s * 0.35, [[0, "#FFB3D9"], [1, "#C2185B"]]);
  x.fill();
  x.restore();
}

// ── Dispatchers ───────────────────────────────────────────────────────────────

/** Where the body sits and how it is transformed, as in BotEngine.draw(). */
export interface OutfitPlacement {
  cx: number;
  cy: number;
  tilt: number;
  sx: number;
  sy: number;
  /** 0 hidden … 1 fully on; Ease.back is applied to the movement. */
  presence: number;
  /** Mailbox morph: accessories fade out as Mochi turns into a box. */
  morph: number;
  rollTurns: number;
}

const ROLL_FOLLOWERS: ReadonlySet<OutfitId> = new Set(["sunglasses", "roundGlasses", "bow", "scarf", "pumpkin"]);
const HATS: ReadonlySet<OutfitId> = new Set(["beanie", "santaHat", "partyHat", "crown", "witchHat"]);

/** Whether this accessory turns with Mochi when it rolls, instead of staying upright. */
export function outfitFollowsRoll(outfit: OutfitId): boolean {
  return ROLL_FOLLOWERS.has(outfit);
}

function bodyTransform(x: CanvasRenderingContext2D, p: OutfitPlacement) {
  x.translate(p.cx, p.cy);
  if (p.tilt !== 0) x.rotate(p.tilt);
  x.scale(p.sx, p.sy);
}

function morphFade(morph: number): number {
  return 1 - Math.min(1, Math.max(0, (morph - 0.3) / 0.2));
}

/** Roll progress 0…1 over the whole tumble. */
function rollProgress(H: Head, turns: number): number {
  return Math.min(1, Math.abs(H.roll) / (2 * Math.PI * Math.max(1, turns)));
}

/** A hat lifts off and swings while Mochi tumbles, then lands again. */
function hatFlight(x: CanvasRenderingContext2D, H: Head, turns: number) {
  const u = rollProgress(H, turns);
  x.translate(H.physDx * H.rx * 0.2 * Math.sin(u * Math.PI), -H.ry * 0.45 * Math.sin(u * Math.PI));
  x.rotate(Math.sin(2 * Math.PI * u) * 0.35);
}

function paintRollFollower(x: CanvasRenderingContext2D, outfit: OutfitId, H: Head, body: Path2D, simplified: boolean) {
  switch (outfit) {
    case "sunglasses": drawSunglasses(x, H, body); break;
    case "roundGlasses": drawRoundGlasses(x, H, body); break;
    case "scarf": drawScarf(x, H); break;
    case "pumpkin": drawPumpkin(x, H, body, simplified); break;
    case "bow": drawBow(x, H); break;
    default: break;
  }
}

function paintHat(x: CanvasRenderingContext2D, outfit: OutfitId, H: Head, body: Path2D, simplified: boolean) {
  switch (outfit) {
    case "beanie": drawBeanie(x, H, body, simplified); break;
    case "santaHat": drawSantaHat(x, H, body); break;
    case "partyHat": drawPartyHat(x, H, simplified); break;
    case "crown": drawCrownFront(x, H, body, simplified); break;
    case "witchHat": drawWitchHatFront(x, H, body); break;
    default: break;
  }
}

/** Everything that sits behind the body. Call before drawing it. */
export function drawOutfitBehind(x: CanvasRenderingContext2D, outfit: OutfitId, H: Head, p: OutfitPlacement) {
  if (outfit === "none") return;
  const alpha = morphFade(p.morph) * Math.min(1, p.presence * 2.5);
  if (alpha <= 0.005) return;
  const simplified = H.R < 16;
  const body = mochiOutfitPath(H.rx, H.ry);
  const posP = Ease.back(p.presence);
  const hatScale = 0.85 + 0.15 * posP;

  x.save();
  bodyTransform(x, p);

  if (ROLL_FOLLOWERS.has(outfit)) {
    // Facing away mid-roll: the accessory is behind the body.
    if (projRoll(H, [0, 0, 1]).z < 0) {
      withLayer(x, alpha, (l) => paintRollFollower(l, outfit, H, body, simplified));
    }
    x.restore();
    return;
  }

  const rolling = Math.abs(H.roll) > 0.01;
  switch (outfit) {
    case "bunnyEars":
      x.translate(0, -(1 - posP) * H.ry);
      x.scale(hatScale, hatScale);
      withLayer(x, alpha, (l) => drawBunnyEarsBack(l, H, rolling ? rollProgress(H, p.rollTurns) : 0));
      break;
    case "crown":
    case "witchHat":
      if (rolling) {
        hatFlight(x, H, p.rollTurns);
      } else {
        x.translate(0, -(1 - posP) * H.ry);
        x.scale(hatScale, hatScale);
      }
      withLayer(x, alpha, (l) => {
        if (outfit === "crown") drawCrownPart(l, H, -1, simplified);
        else drawWitchHatBack(l, H);
      });
      break;
    default:
      break;
  }
  x.restore();
}

/** Everything that sits in front of the body and eyes. Call after drawing them. */
export function drawOutfitFront(x: CanvasRenderingContext2D, outfit: OutfitId, H: Head, p: OutfitPlacement) {
  if (outfit === "none" || outfit === "bunnyEars") return;
  const fade = morphFade(p.morph);
  if (fade <= 0.01) return;
  if (ROLL_FOLLOWERS.has(outfit) && projRoll(H, [0, 0, 1]).z < 0) return;

  // Opaque early, so the movement carries the transition.
  const presence = p.presence;
  const posP = Ease.back(presence);
  const alpha = fade * Math.min(1, presence * 2.5);
  if (alpha <= 0.005) return;

  const simplified = H.R < 16;
  const body = mochiOutfitPath(H.rx, H.ry);

  x.save();
  bodyTransform(x, p);

  if (HATS.has(outfit)) {
    if (Math.abs(H.roll) > 0.01) {
      hatFlight(x, H, p.rollTurns);
    } else {
      const hatScale = 0.85 + 0.15 * posP;
      x.translate(0, -(1 - posP) * H.ry);
      x.scale(hatScale, hatScale);
    }
    withLayer(x, alpha, (l) => paintHat(l, outfit, H, body, simplified));
    x.restore();
    return;
  }

  switch (outfit) {
    case "sunglasses":
    case "roundGlasses":
      x.translate(0, (1 - presence) * 0.25 * H.ry);
      break;
    case "scarf":
      x.translate(0, (1 - presence) * 0.3 * H.ry);
      break;
    case "bow": {
      const k = Math.max(0.001, posP);
      x.scale(k, k);
      break;
    }
    default:
      break;
  }
  withLayer(x, alpha, (l) => paintRollFollower(l, outfit, H, body, simplified));
  x.restore();
}

// ── Wardrobe icons ────────────────────────────────────────────────────────────

const ICON_R = 10;

function drawIconBody(x: CanvasRenderingContext2D, H: Head, pumpkin: boolean) {
  const body = mochiOutfitPath(H.rx, H.ry);
  const [top, bot] = pumpkin ? PUMPKIN_COLORS : ["rgb(237,237,239)", "rgb(196,197,202)"];
  x.fillStyle = lin(x, H.rx * 0.7, -H.ry * 0.85, -H.rx * 0.8, H.ry * 0.9, [[0, top], [1, bot]]);
  x.fill(body);
  x.fillStyle = rad(x, 0, 0, H.R * 0.15, H.R * 1.25, [[0, "rgba(0,0,0,0)"], [0.6, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.2)"]]);
  x.fill(body);
  x.fillStyle = rad(x, H.rx * 0.34, -H.ry * 0.46, 0, H.R * 0.42, [[0, "rgba(255,255,255,0.55)"], [1, "rgba(255,255,255,0)"]]);
  x.fill(body);
  x.save();
  x.clip(body);
  x.fillStyle = "rgb(26,21,18)";
  for (const f of eyeFrames(H)) {
    if (!f.visible) continue;
    const hh = Math.max(f.h, f.w * 0.3);
    x.save();
    x.translate(f.x, f.y);
    x.scale(f.fx, f.fy);
    x.beginPath();
    roundRect(x, -f.w / 2, -hh / 2, f.w, hh, Math.min(f.w / 2, hh / 2));
    x.fill();
    x.restore();
  }
  x.restore();
}

/**
 * One wardrobe tile: a small Mochi wearing the outfit, ⊘ for none, and for
 * auto the outfit the seasons pick today plus an AUTO badge.
 */
export function drawOutfitIcon(x: CanvasRenderingContext2D, size: number, selection: OutfitSelection, today = new Date()) {
  const c = size / 2;
  if (selection === "none") {
    const r = 6.5;
    x.save();
    x.translate(c, c);
    x.strokeStyle = "#454850";
    x.lineWidth = 1.4;
    x.lineCap = "round";
    x.beginPath();
    x.arc(0, 0, r * 0.82, 0, Math.PI * 2);
    x.moveTo(-r * 0.56, r * 0.56);
    x.lineTo(r * 0.56, -r * 0.56);
    x.stroke();
    x.restore();
    return;
  }

  const outfit = selection === "auto" ? seasonalOutfit(today) : selection;
  const H = makeHead(ICON_R);
  const placement: OutfitPlacement = {
    cx: c, cy: c + ICON_R * 0.62, tilt: 0, sx: 1, sy: 1, presence: 1, morph: 0, rollTurns: 1,
  };
  drawOutfitBehind(x, outfit, H, placement);
  x.save();
  x.translate(placement.cx, placement.cy);
  drawIconBody(x, H, outfit === "pumpkin");
  x.restore();
  drawOutfitFront(x, outfit, H, placement);

  if (selection === "auto") {
    const bw = 14;
    const bh = 6.5;
    x.save();
    x.translate(c, placement.cy + H.ry * 0.72);
    x.beginPath();
    roundRect(x, -bw / 2, -bh / 2, bw, bh, bh / 2);
    x.fillStyle = "rgba(0,0,0,0.6)";
    x.fill();
    x.fillStyle = "#FFFFFF";
    x.font = `600 4.2px system-ui, sans-serif`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText("AUTO", 0, 0.3);
    x.restore();
  }
}
