// Wardrobe — DOM port of WardrobeView / OutfitPillView from IslandViewContent.swift.
// Hovering a tile dresses Mochi in it as a preview; a click keeps it.

import { h } from "./dom";
import { State } from "../core/state";
import {
  OUTFIT_NAMES, OUTFIT_SELECTIONS, drawOutfitIcon, parseOutfit, resolveOutfit, seasonalOutfit,
  type OutfitSelection,
} from "../mochi/outfits";
import type { ViewActions, ViewHost } from "./views";

const TILE = 30;

function seasonalName(): string {
  const seasonal = seasonalOutfit(new Date());
  return seasonal === "none" ? "None" : OUTFIT_NAMES[seasonal];
}

function headerText(hovered: OutfitSelection | null): string {
  if (hovered) {
    return hovered === "auto"
      ? `Auto · follows the seasons (now: ${seasonalName()})`
      : OUTFIT_NAMES[hovered];
  }
  const selected = parseOutfit(State.settings.outfit);
  return selected === "auto" ? `Auto · ${seasonalName()}` : OUTFIT_NAMES[selected];
}

function paintTile(canvas: HTMLCanvasElement, selection: OutfitSelection) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(TILE * dpr);
  canvas.height = Math.round(TILE * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, TILE, TILE);
  drawOutfitIcon(ctx, TILE, selection);
}

export function buildWardrobe(actions: ViewActions): ViewHost {
  const detail = h("span", { class: "wardrobe-detail" });
  const grid = h("div", { class: "wardrobe-grid" });
  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "wardrobe" },
      h("div", { class: "wardrobe-head" }, h("b", { text: "Wardrobe" }), detail),
      grid,
    ),
  );

  let hovered: OutfitSelection | null = null;
  let paintedDay = "";
  const tiles = new Map<OutfitSelection, { tile: HTMLElement; canvas: HTMLCanvasElement }>();

  for (const selection of OUTFIT_SELECTIONS) {
    const canvas = h("canvas", { width: TILE, height: TILE });
    const tile = h("button", { class: "outfit-tile", title: OUTFIT_NAMES[selection] }, canvas);
    tile.addEventListener("mouseenter", () => {
      hovered = selection;
      State.wardrobePreview = resolveOutfit(selection);
      State.notify();
    });
    tile.addEventListener("mouseleave", () => {
      if (hovered !== selection) return;
      hovered = null;
      State.wardrobePreview = null;
      State.notify();
    });
    tile.addEventListener("click", () => actions.chooseOutfit(selection));
    tiles.set(selection, { tile, canvas });
    grid.append(tile);
  }

  return {
    el,
    sync() {
      // The auto tile shows today's seasonal outfit, so repaint when the day turns.
      const day = new Date().toDateString();
      if (day !== paintedDay) {
        paintedDay = day;
        for (const [selection, { canvas }] of tiles) paintTile(canvas, selection);
      }
      if (State.wardrobePreview == null) hovered = null;
      const selected = parseOutfit(State.settings.outfit);
      for (const [selection, { tile }] of tiles) {
        tile.classList.toggle("on", selection === selected);
      }
      detail.textContent = headerText(hovered);
    },
  };
}

/** Clears the hover state when the wardrobe closes, as WardrobeView.onDisappear does. */
export function leaveWardrobe() {
  if (State.wardrobePreview == null) return;
  State.wardrobePreview = null;
  State.notify();
}
