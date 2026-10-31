import type { Arrows, EdgeStyle, IconName, Kind, Outline, TextSize } from "./types.js";

export type Shape = "rectangle" | "ellipse";
export type FillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type StrokeStyle = "solid" | "dashed" | "dotted";

export interface NodeStyle {
  shape: Shape;
  rounded: boolean;
  fill: string;
  fillStyle: FillStyle;
  stroke: string;
  strokeStyle: StrokeStyle;
}

export const STROKE = "#1e1e1e";

export const NODE_STYLES: Record<Kind, NodeStyle> = {
  client: { shape: "ellipse", rounded: false, fill: "#e9ecef", fillStyle: "solid", stroke: STROKE, strokeStyle: "solid" },
  service: { shape: "rectangle", rounded: true, fill: "#a5d8ff", fillStyle: "solid", stroke: STROKE, strokeStyle: "solid" },
  datastore: { shape: "rectangle", rounded: false, fill: "#b2f2bb", fillStyle: "solid", stroke: STROKE, strokeStyle: "solid" },
  queue: { shape: "rectangle", rounded: false, fill: "#fab005", fillStyle: "hachure", stroke: STROKE, strokeStyle: "solid" },
  cache: { shape: "rectangle", rounded: false, fill: "#ffd8a8", fillStyle: "solid", stroke: STROKE, strokeStyle: "solid" },
  external: { shape: "rectangle", rounded: true, fill: "transparent", fillStyle: "solid", stroke: STROKE, strokeStyle: "dashed" },
};

export const EDGE_STYLES: Record<EdgeStyle, { strokeStyle: StrokeStyle }> = {
  sync: { strokeStyle: "solid" },
  async: { strokeStyle: "dashed" },
};

export function arrowheads(arrows: Arrows): { start: "arrow" | null; end: "arrow" | null } {
  switch (arrows) {
    case "forward":
      return { start: null, end: "arrow" };
    case "both":
      return { start: "arrow", end: "arrow" };
    case "none":
      return { start: null, end: null };
  }
}

export const GROUP_STYLE = {
  fill: "#f8f9fa",
  stroke: "#868e96",
  strokeStyle: "solid" as StrokeStyle,
  strokeWidth: 1,
  labelColor: "#495057",
  padding: 16,
};

export const FONT = {
  family: 5,
  lineHeight: 1.25,
  node: 20,
  edge: 16,
  group: 16,
  title: 32,
};

export const NODE = {
  strokeWidth: 2,
  roughness: 1,
  paddingX: 24,
  paddingY: 16,
  minWidth: 120,
  minHeight: 56,
};

/**
 * A node's icon: a Lucide glyph from icons/, drawn size pixels a side in color, gap pixels left of its label. The
 * label stays centred, because the editor puts a bound text back in the middle of its container on any edit, so the
 * node reserves the icon's width on both sides of it.
 */
export const ICON = {
  size: 28,
  gap: 8,
  color: STROKE,
};

/** The file in icons/ each icon name draws, without its .svg. */
export const ICON_GLYPHS: Record<IconName, string> = {
  user: "user",
  users: "users",
  browser: "app-window",
  phone: "smartphone",
  desktop: "monitor",
  terminal: "terminal",
  bot: "bot",
  globe: "globe",
  cloud: "cloud",
  gateway: "network",
  server: "server",
  container: "container",
  function: "square-function",
  database: "database",
  cache: "database-zap",
  queue: "gallery-horizontal-end",
  storage: "hard-drive",
  search: "search",
  file: "file-text",
  mail: "mail",
  chat: "message-square",
  bell: "bell",
  webhook: "webhook",
  payment: "credit-card",
  lock: "lock",
  key: "key-round",
  shield: "shield",
  chart: "chart-column",
  logs: "logs",
  clock: "clock",
  settings: "settings",
  git: "git-branch",
};

export const EDGE = {
  strokeWidth: 2,
  roughness: 1,
};

/**
 * Timing of the animated SVG, in ms. Beats share `build` between them, within `minBeat` and `maxBeat` each, so a long
 * spec speeds up rather than dragging on. An element fades in over `fade`; a solid arrow's line draws on over `draw`,
 * cut to its beat, and its heads then fade in over `heads`. The finished diagram holds for `hold`, then the loop starts
 * again, and a dashed arrow's dashes march one period every `march` throughout. A line draws on through a mask
 * whose stroke runs along its route, `mask` px wide or wider for a long segment.
 */
export const ANIMATION = {
  build: 8000,
  minBeat: 250,
  maxBeat: 700,
  fade: 400,
  draw: 600,
  heads: 200,
  hold: 3000,
  march: 900,
  mask: 16,
};

/** How far past the text Excalidraw blanks the line behind a label bound to an arrow: BOUND_TEXT_PADDING. */
export const LABEL_MASK = 5;
/** How long Excalidraw draws an arrowhead, or half its end segment when that is shorter: getArrowheadSize. */
export const ARROWHEAD_LENGTH = 25;
/**
 * Widest line an edge label is wrapped to. Excalidraw re-wraps an arrow's label whenever the arrow changes, at the
 * larger of 0.7 of the arrow's width and 11 times the font size, so a line under that floor stays whole however the
 * arrow is dragged. One font size under it leaves room for a browser that measures the same line a little wider.
 */
export const EDGE_LABEL_WIDTH = FONT.edge * 10;

export const TITLE_GAP = 32;

/** PNG pixels per scene pixel in the file written to disk, so a 16px edge label is 32px tall in it. */
export const PNG_SCALE = 2;

/**
 * Corner radius Excalidraw draws on a rounded node: a quarter of the shorter side, capped at 32. That is
 * getCornerRadius for the adaptive roundness elements.ts sets, whose cap is DEFAULT_ADAPTIVE_RADIUS.
 */
export function cornerRadius(width: number, height: number): number {
  return Math.min(Math.min(width, height) * 0.25, 32);
}

/** The outline a node of the given kind is drawn with. */
export function outlineOf(kind: Kind): Outline {
  const { shape, rounded } = NODE_STYLES[kind];
  if (shape === "ellipse") return "ellipse";
  return rounded ? "rounded" : "sharp";
}

/** Box size for a node of the given kind around its measured label, and its icon when it has one. */
export function nodeSize(kind: Kind, label: TextSize, icon = false): { width: number; height: number } {
  const factor = NODE_STYLES[kind].shape === "ellipse" ? Math.SQRT2 : 1;
  const content = icon ? { width: label.width + 2 * (ICON.size + ICON.gap), height: Math.max(label.height, ICON.size) } : label;
  return {
    width: Math.max(NODE.minWidth, Math.ceil(content.width * factor + NODE.paddingX * 2)),
    height: Math.max(NODE.minHeight, Math.ceil(content.height + NODE.paddingY * 2)),
  };
}
