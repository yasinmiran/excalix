// Shared contracts between excalix modules. Geometry is absolute, top-left origin, pixels.

import type { ExcalidrawElement } from "excalidraw-types/element/src/types";

export type Kind = "client" | "service" | "datastore" | "queue" | "cache" | "external";
/** What a node is, beside its kind, drawn as a small line icon in it. style.ts maps each to its glyph. */
export type IconName =
  | "user"
  | "users"
  | "browser"
  | "phone"
  | "desktop"
  | "terminal"
  | "bot"
  | "globe"
  | "cloud"
  | "gateway"
  | "server"
  | "container"
  | "function"
  | "database"
  | "cache"
  | "queue"
  | "storage"
  | "search"
  | "file"
  | "mail"
  | "chat"
  | "bell"
  | "webhook"
  | "payment"
  | "lock"
  | "key"
  | "shield"
  | "chart"
  | "logs"
  | "clock"
  | "settings"
  | "git";
export type EdgeStyle = "sync" | "async";
export type Arrows = "forward" | "both" | "none";
export type Direction = "lr" | "tb";
/** Which renders to write: light, dark, or both side by side. An output option, never part of the spec. */
export type Theme = "light" | "dark" | "both";
/** The order an animated SVG builds the diagram in: the spec's edges one by one, or the layout's layers. An output option. */
export type AnimationOrder = "story" | "layers";

export interface GroupSpec {
  id: string;
  label: string;
  parent?: string;
}

export interface NodeSpec {
  id: string;
  label: string;
  kind: Kind;
  icon?: IconName;
  group?: string;
}

export interface EdgeSpec {
  from: string;
  to: string;
  label?: string;
  style: EdgeStyle;
  arrows: Arrows;
}

/** A validated, defaulted spec. Produced only by parseSpec. */
export interface Spec {
  title?: string;
  direction: Direction;
  groups: GroupSpec[];
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

export interface TextSize {
  width: number;
  height: number;
}

/** Measures text in Excalifont at a given size. The browser implementation is exact; the estimate is for tests. */
export interface TextMeasurer {
  measure(texts: string[], fontSize: number): Promise<TextSize[]>;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

/** The line Excalidraw draws for a node. Only a sharp rectangle's runs along its box. */
export type Outline = "sharp" | "rounded" | "ellipse";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  outline: Outline;
  group?: string;
}

export interface LayoutGroup {
  id: string;
  parent?: string;
  /** Size reserved for the group label in the top-left corner. */
  label: TextSize;
}

export interface LayoutEdge {
  /** Stable edge id, `edge:<index>` in spec order. */
  id: string;
  from: string;
  to: string;
  label?: TextSize;
}

export interface LayoutInput {
  direction: Direction;
  groups: LayoutGroup[];
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/** Top-left of the label text, absolute. Its centre lies on the polyline. */
export interface RoutedLabel extends Point {
  /** Arc-length parameter of the centre along the polyline, 0..1. */
  position: number;
}

export interface RoutedEdge {
  /** Absolute polyline from the source outline to the target outline, at least two points. */
  points: Point[];
  /** Placement of the label text. Present iff the input edge had a label. */
  label?: RoutedLabel;
}

export interface LayoutResult {
  nodes: Record<string, Box>;
  groups: Record<string, Box>;
  edges: Record<string, RoutedEdge>;
  /** Top-left of each group label, inside the group's top padding and clear of the arrows where that is possible. */
  groupLabels: Record<string, Point>;
  /** Bounding box of everything laid out. */
  bounds: Box;
}

/** An edge label as it is written to the file: wrapped to lines, and the size of that text. */
export interface WrappedLabel extends TextSize {
  text: string;
}

export interface Measured {
  nodeLabels: Record<string, TextSize>;
  groupLabels: Record<string, TextSize>;
  /** Keyed by LayoutEdge id. Only edges with a label. */
  edgeLabels: Record<string, WrappedLabel>;
  title?: TextSize;
}

/** An image file as the .excalidraw files map holds it. */
export interface SceneFile {
  mimeType: "image/svg+xml";
  /** The sha1 hex of the file's bytes, which is also its key in the files map and the fileId of its images. */
  id: string;
  dataURL: string;
  created: number;
}

export type SceneFiles = Record<string, SceneFile>;

/**
 * What buildElements makes of a spec: the elements, the files their images draw, and beside each element the key its
 * id derives from, such as `node:api` or `edge:3:label`.
 */
export interface Drawing {
  elements: ExcalidrawElement[];
  files: SceneFiles;
  keys: string[];
}

/** How the animated SVG brings in one element, applied to the top-level <g> the export draws it in. */
export interface ElementMotion {
  /** Class on the element's <g>. Absent on the opening beat, which shows from the start. */
  className?: string;
  /** A solid arrow: the mask its line is seen through, which draws on along the route, and the class of its arrowheads, which follow. */
  draw?: { mask: RouteMask; heads: string };
  /** A dashed arrow: the class of its line, whose dashes march. */
  march?: string;
}

/**
 * A mask over an arrow's line, in the line's own coordinates, whose one stroke runs along the route from source to
 * target. The rough line is two strokes a segment, and a dash pattern starts again on each, so the dash that draws it
 * on goes on this stroke instead.
 */
export interface RouteMask {
  id: string;
  /** The route as one subpath through the arrow's points. */
  d: string;
  /** Wide enough to take in the rough line wherever it bows off the route. */
  strokeWidth: number;
  /** The region the mask covers: the route's box, the stroke's width round it. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Class of the stroke, which draws on along pathLength 1. */
  className: string;
}

/** What turns an SVG export into the animated one: a motion per element, in element order, and the CSS they name. */
export interface AnimationPlan {
  elements: ElementMotion[];
  css: string;
  /** Length of one loop, build and hold, in ms. */
  cycle: number;
}

/** What every export of a drawing takes: the theme, and the files its images draw. */
export interface ExportOptions {
  dark: boolean;
  files: SceneFiles;
}

export interface Renderer {
  measurer: TextMeasurer;
  /** Self-contained SVG markup with fonts inlined, in Excalidraw's dark mode when asked. */
  svg(elements: unknown[], options: ExportOptions): Promise<string>;
  /** The same SVG with the plan's classes on its elements and its CSS in a style element, so it builds itself in a loop. */
  animatedSvg(elements: unknown[], options: ExportOptions & { plan: AnimationPlan }): Promise<string>;
  /** PNG bytes with each scene pixel drawn as scale pixels a side, in Excalidraw's dark mode when asked. */
  png(elements: unknown[], options: ExportOptions & { scale: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The PNG an agent is handed in place of the one on disk, and how many of its pixels one scene pixel became. */
export interface Preview {
  png: Uint8Array;
  scale: number;
}

export interface Images {
  svg: string;
  png: Uint8Array;
  /** Present when the sketch was asked to animate. */
  animatedSvg?: string;
}

export interface SketchResult extends Images {
  /** Full .excalidraw document as a JSON string. */
  excalidraw: string;
  /** The dark renders, beside the light ones in svg and png, when the theme is both. */
  dark?: Images;
  /** Present when the sketch was asked for one. */
  preview?: Preview;
}
