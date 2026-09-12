// Shared contracts between excalix modules. Geometry is absolute, top-left origin, pixels.

export type Kind = "client" | "service" | "datastore" | "queue" | "cache" | "external";
export type EdgeStyle = "sync" | "async";
export type Arrows = "forward" | "both" | "none";
export type Direction = "lr" | "tb";

export interface GroupSpec {
  id: string;
  label: string;
  parent?: string;
}

export interface NodeSpec {
  id: string;
  label: string;
  kind: Kind;
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

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
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

export interface RoutedEdge {
  /** Absolute polyline from the source border to the target border, at least two points. */
  points: Point[];
  /** Top-left of the label box, absolute. Present iff the input edge had a label. */
  label?: Point;
}

export interface LayoutResult {
  nodes: Record<string, Box>;
  groups: Record<string, Box>;
  edges: Record<string, RoutedEdge>;
  /** Bounding box of everything laid out. */
  bounds: Box;
}

export interface Measured {
  nodeLabels: Record<string, TextSize>;
  groupLabels: Record<string, TextSize>;
  /** Keyed by LayoutEdge id. Only edges with a label. */
  edgeLabels: Record<string, TextSize>;
  title?: TextSize;
}

export interface Renderer {
  measurer: TextMeasurer;
  /** Self-contained SVG markup with fonts inlined. */
  svg(elements: unknown[]): Promise<string>;
  /** PNG bytes at 2x device scale. */
  png(elements: unknown[]): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface SketchResult {
  /** Full .excalidraw document as a JSON string. */
  excalidraw: string;
  svg: string;
  png: Uint8Array;
}
