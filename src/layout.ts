import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkEdgeSection, ElkExtendedEdge, ElkLabel, ElkNode, LayoutOptions } from "elkjs/lib/elk.bundled.js";
import { GROUP_STYLE } from "./style.js";
import type {
  Box,
  Direction,
  LayoutEdge,
  LayoutGroup,
  LayoutInput,
  LayoutNode,
  LayoutResult,
  Point,
  RoutedEdge,
  RoutedLabel,
  TextSize,
} from "./types.js";

const ROOT = ":root";
const PADDING = GROUP_STYLE.padding;
/** Clearance reserved around an edge label so the text never touches a neighbouring node or label. */
export const LABEL_MARGIN = 12;
// Both options are read from the label, not from the graph, so setting them anywhere else does nothing.
const LABEL_OPTIONS: LayoutOptions = { "elk.edgeLabels.placement": "CENTER", "elk.edgeLabels.inline": "true" };
// Gap kept beside a group label so an arrowhead next to it stays off the text.
const LABEL_CLEARANCE = 12;

const elk = new ELK();

/** Lays out nodes, groups and edges with ELK. Absolute coordinates, bounds at (0, 0). */
export async function layout(input: LayoutInput): Promise<LayoutResult> {
  const first = await layoutWith(input, {});
  const gutters = labelGutters(input, first);
  return normalise(Object.keys(gutters).length === 0 ? first : await layoutWith(input, gutters));
}

// One ELK pass. Each gutter entry widens that group's left padding by its value.
async function layoutWith(input: LayoutInput, gutters: Record<string, number>): Promise<LayoutResult> {
  const laid = await elk.layout(toElkGraph(input, gutters));
  const boxes = new Map<string, Box>();
  collectBoxes(laid, { x: 0, y: 0 }, boxes);

  const groupIds = new Set(input.groups.map((g) => g.id));
  const nodes: Record<string, Box> = {};
  const groups: Record<string, Box> = {};
  for (const [id, box] of boxes) (groupIds.has(id) ? groups : nodes)[id] = box;

  const edges: Record<string, RoutedEdge> = {};
  for (const edge of laid.edges ?? []) edges[edge.id] = routeEdge(edge, boxes);

  const routed = Object.values(edges);
  const groupLabels = Object.fromEntries(input.groups.map((g) => [g.id, placeGroupLabel(groups[g.id]!, g.label, routed)]));

  return { nodes, groups, edges, groupLabels, bounds: bounds(nodes, groups, edges, input.edges) };
}

function toElkGraph(input: LayoutInput, gutters: Record<string, number>): ElkNode {
  const loops = selfLoopSpacing(input);
  const childrenOf = (parent: string | undefined): ElkNode[] => [
    ...input.nodes.filter((n) => n.group === parent).map(leaf),
    ...input.groups
      .filter((g) => g.parent === parent)
      .map((g) => groupNode(g, input.direction, childrenOf(g.id), loops, gutters[g.id] ?? 0)),
  ];
  return {
    id: ROOT,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": input.direction === "tb" ? "DOWN" : "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "48",
      "elk.spacing.edgeNode": "24",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      ...loops,
    },
    children: childrenOf(undefined),
    edges: input.edges.map(elkEdge),
  };
}

// ELK places a self loop's label beside the loop even when the label asks to be inline, so the loop itself has
// to stand far enough off the node for the padded box to fit centred on it. The option is read from the
// containing parent, never from the node, and the layered algorithm measures it in a frame transposed for DOWN.
function selfLoopSpacing(input: LayoutInput): LayoutOptions {
  const room = input.edges
    .filter((edge) => edge.from === edge.to && edge.label)
    .map((edge) => (input.direction === "tb" ? edge.label!.width : edge.label!.height) / 2 + LABEL_MARGIN);
  return room.length === 0 ? {} : { "elk.spacing.nodeSelfLoop": String(Math.max(...room)) };
}

function leaf(node: LayoutNode): ElkNode {
  return { id: node.id, width: node.width, height: node.height };
}

function groupNode(group: LayoutGroup, direction: Direction, children: ElkNode[], loops: LayoutOptions, gutter: number): ElkNode {
  const top = group.label.height + PADDING;
  const left = PADDING + gutter;
  const width = group.label.width + PADDING + left;
  const height = top + PADDING;
  if (children.length === 0) return { id: group.id, width, height };
  // ELK 0.12 applies a compound node's minimum size in the layered algorithm's internal frame, which is transposed for DOWN.
  const minimum = direction === "tb" ? `(${height},${width})` : `(${width},${height})`;
  return {
    id: group.id,
    children,
    layoutOptions: {
      "elk.padding": `[top=${top},left=${left},bottom=${PADDING},right=${PADDING}]`,
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": minimum,
      ...loops,
    },
  };
}

// ELK skips labels whose text is empty, so the id stands in for the text; only the size matters here.
function elkEdge(edge: LayoutEdge): ElkExtendedEdge {
  return {
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
    ...(edge.label
      ? {
          labels: [
            {
              text: edge.id,
              width: edge.label.width + LABEL_MARGIN * 2,
              height: edge.label.height + LABEL_MARGIN * 2,
              layoutOptions: LABEL_OPTIONS,
            },
          ],
        }
      : {}),
  };
}

function collectBoxes(node: ElkNode, offset: Point, out: Map<string, Box>): void {
  for (const child of node.children ?? []) {
    const box = { x: offset.x + (child.x ?? 0), y: offset.y + (child.y ?? 0), width: child.width ?? 0, height: child.height ?? 0 };
    out.set(child.id, box);
    collectBoxes(child, box, out);
  }
}

function routeEdge(edge: ElkExtendedEdge, boxes: Map<string, Box>): RoutedEdge {
  const container = edge.container && edge.container !== ROOT ? boxes.get(edge.container) : undefined;
  const offset = container ?? { x: 0, y: 0 };
  const shift = (p: Point): Point => ({ x: offset.x + p.x, y: offset.y + p.y });
  const routed = dedupe((edge.sections ?? []).flatMap(sectionPoints).map(shift));
  const points = routed.length >= 2 ? routed : [center(boxes.get(edge.sources[0]!)!), center(boxes.get(edge.targets[0]!)!)];
  const label = edge.labels?.[0];
  return { points, ...(label ? { label: labelOnPath(points, shift({ x: label.x ?? 0, y: label.y ?? 0 }), label) } : {}) };
}

// Excalidraw re-anchors a bound label to labelPosition on the path every time the file is opened, so the text has
// to sit where the path crosses the box ELK reserved rather than where ELK drew the box.
function labelOnPath(points: Point[], reserved: Point, label: ElkLabel): RoutedLabel {
  const half = { x: (label.width ?? 0) / 2, y: (label.height ?? 0) / 2 };
  const { t, point } = nearestOnPolyline(points, { x: reserved.x + half.x, y: reserved.y + half.y });
  return { x: point.x - half.x + LABEL_MARGIN, y: point.y - half.y + LABEL_MARGIN, position: t };
}

/** Closest point on the polyline to target, with its arc-length parameter in 0..1. */
function nearestOnPolyline(points: Point[], target: Point): { t: number; point: Point } {
  let total = 0;
  let best = { distance: Infinity, length: 0, point: points[0] ?? target };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const s = length === 0 ? 0 : Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (length * length)));
    const point = { x: a.x + dx * s, y: a.y + dy * s };
    const distance = Math.hypot(target.x - point.x, target.y - point.y);
    if (distance < best.distance) best = { distance, length: total + length * s, point };
    total += length;
  }
  return { t: total === 0 ? 0 : best.length / total, point: best.point };
}

function sectionPoints(section: ElkEdgeSection): Point[] {
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
}

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
}

function center(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Leftmost spot in the group's top padding where no edge crosses the label, or the top-left corner when the strip is full. */
export function placeGroupLabel(group: Box, label: TextSize, edges: RoutedEdge[]): Point {
  const corner = { x: group.x + PADDING, y: group.y + PADDING };
  const limit = group.x + group.width - PADDING - label.width;
  let x = corner.x;
  for (const [from, to] of forbiddenSpans(label, edges, corner.y, LABEL_CLEARANCE)) {
    if (from >= x) break;
    x = Math.max(x, to);
  }
  return x > limit ? corner : { x, y: corner.y };
}

/** Extra left padding for the groups whose label the previous pass had to leave under an arrow. */
function labelGutters(input: LayoutInput, result: LayoutResult): Record<string, number> {
  const edges = Object.values(result.edges);
  const shifts = input.groups.flatMap((group) => {
    const at = result.groupLabels[group.id]!;
    const crossed = forbiddenSpans(group.label, edges, at.y, 0).filter(([from, to]) => from < at.x && at.x < to);
    if (crossed.length === 0) return [];
    return [[group.id, Math.ceil(Math.max(...crossed.map(([from]) => at.x - from)) + LABEL_CLEARANCE)] as const];
  });
  return Object.fromEntries(shifts);
}

// Label starts that an edge would come within clearance of, as x ranges in ascending order.
function forbiddenSpans(label: TextSize, edges: RoutedEdge[], top: number, clearance: number): [number, number][] {
  const band = { top, bottom: top + label.height };
  const spans: [number, number][] = [];
  for (const edge of edges) {
    for (let i = 1; i < edge.points.length; i++) {
      const span = spanInBand(edge.points[i - 1]!, edge.points[i]!, band);
      if (span) spans.push([span[0] - label.width - clearance, span[1] + clearance]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

// Horizontal extent of the part of the segment that runs inside the band.
function spanInBand(a: Point, b: Point, band: { top: number; bottom: number }): [number, number] | undefined {
  const [low, high] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  if (high <= band.top || low >= band.bottom) return undefined;
  if (low === high) return [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const xAt = (y: number): number => a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
  const ends = [xAt(Math.max(low, band.top)), xAt(Math.min(high, band.bottom))];
  return [Math.min(...ends), Math.max(...ends)];
}

function bounds(nodes: Record<string, Box>, groups: Record<string, Box>, edges: Record<string, RoutedEdge>, inputEdges: LayoutEdge[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number, width = 0, height = 0): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  };
  for (const box of [...Object.values(nodes), ...Object.values(groups)]) include(box.x, box.y, box.width, box.height);
  for (const edge of inputEdges) {
    const routed = edges[edge.id]!;
    for (const p of routed.points) include(p.x, p.y);
    if (routed.label && edge.label) include(routed.label.x, routed.label.y, edge.label.width, edge.label.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function normalise(result: LayoutResult): LayoutResult {
  const dx = -result.bounds.x;
  const dy = -result.bounds.y;
  const moveBox = (box: Box): Box => ({ ...box, x: box.x + dx, y: box.y + dy });
  const movePoint = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  const mapValues = <T>(record: Record<string, T>, f: (value: T) => T): Record<string, T> =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, f(v)]));
  return {
    nodes: mapValues(result.nodes, moveBox),
    groups: mapValues(result.groups, moveBox),
    groupLabels: mapValues(result.groupLabels, movePoint),
    edges: mapValues(result.edges, (edge) => ({
      points: edge.points.map(movePoint),
      ...(edge.label ? { label: { ...edge.label, ...movePoint(edge.label) } } : {}),
    })),
    bounds: { ...result.bounds, x: 0, y: 0 },
  };
}
