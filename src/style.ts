import type { Arrows, EdgeStyle, Kind, TextSize } from "./types.js";

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
  queue: { shape: "rectangle", rounded: false, fill: "#ffec99", fillStyle: "hachure", stroke: STROKE, strokeStyle: "solid" },
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
  strokeStyle: "dashed" as StrokeStyle,
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
  title: 28,
};

export const NODE = {
  strokeWidth: 2,
  roughness: 1,
  paddingX: 24,
  paddingY: 16,
  minWidth: 120,
  minHeight: 56,
};

export const EDGE = {
  strokeWidth: 2,
  roughness: 1,
};

export const TITLE_GAP = 32;

/** Box size for a node of the given kind around its measured label. */
export function nodeSize(kind: Kind, label: TextSize): { width: number; height: number } {
  const factor = NODE_STYLES[kind].shape === "ellipse" ? Math.SQRT2 : 1;
  return {
    width: Math.max(NODE.minWidth, Math.ceil(label.width * factor + NODE.paddingX * 2)),
    height: Math.max(NODE.minHeight, Math.ceil(label.height * factor + NODE.paddingY * 2)),
  };
}
