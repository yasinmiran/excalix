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

/** What buildElements makes of a spec: the elements, and the files their images draw. */
export interface Drawing {
  elements: ExcalidrawElement[];
  files: SceneFiles;
}

export interface Renderer {
  measurer: TextMeasurer;
  /** Self-contained SVG markup with fonts inlined, in Excalidraw's dark mode when asked. */
  svg(elements: unknown[], options: { dark: boolean; files: SceneFiles }): Promise<string>;
  /** PNG bytes with each scene pixel drawn as scale pixels a side, in Excalidraw's dark mode when asked. */
  png(elements: unknown[], options: { dark: boolean; scale: number; files: SceneFiles }): Promise<Uint8Array>;
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
}

export interface SketchResult extends Images {
  /** Full .excalidraw document as a JSON string. */
  excalidraw: string;
  /** The dark renders, beside the light ones in svg and png, when the theme is both. */
  dark?: Images;
  /** Present when the sketch was asked for one. */
  preview?: Preview;
}
