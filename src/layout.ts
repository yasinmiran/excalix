import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkEdgeSection, ElkExtendedEdge, ElkLabel, ElkNode, ElkPort, LayoutOptions } from "elkjs/lib/elk.bundled.js";
import { GROUP_STYLE, cornerRadius } from "./style.js";
import type {
  Box,
  Direction,
  LayoutEdge,
  LayoutGroup,
  LayoutInput,
  LayoutNode,
  LayoutResult,
  Outline,
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

/**
 * Straight run an arrow needs at each end that carries a head. Excalidraw draws the head
 * `min(25, segment / 2)` long. 36 draws an 18px head; the 50 a full head needs stretched dense
 * diagrams further than the extra 7px was worth.
 */
export const ARROWHEAD_ROOM = 36;
/** Distance kept between two arrow ends on the same side of a node: an arrowhead is 17px wide. */
export const END_SPACING = 32;
// Distance between a corner and the nearest end on a side holding more than one. A lone end sits mid-side
// and needs twice this, so 28 is as far as it goes before NODE.minHeight stops covering it and every quiet
// node grows. A rounded corner's radius stops at 32, and 28 along it the curve is under a seventh of a
// pixel off the side, so no end lands on a rounded corner.
const CORNER_ROOM = 28;
/**
 * Line left showing on each side of a self loop's label, past the label's own clearance. Read off renders
 * at 12, 16 and 20: at 12 an async loop's outer segment is a tick mark, and 20 reads no better than 16.
 */
export const LOOP_LABEL_RUN = 16;
// How far off its node's side an end may sit and still count as on it: the box and the route reach absolute
// coordinates through different sums of group offsets.
const ON_SIDE = 0.5;
// The same sums leave a segment that is meant to be straight off by a few ulps when it crosses nested groups.
const STRAIGHT = 1e-6;

// ELK reads a spacing from the node that contains what is being spaced, so a group has to repeat
// every value or its children fall back to the defaults.
const SPACING: LayoutOptions = {
  "elk.spacing.nodeNode": "48",
  "elk.spacing.edgeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(ARROWHEAD_ROOM),
  "elk.layered.spacing.edgeNodeBetweenLayers": String(ARROWHEAD_ROOM),
  "elk.spacing.portPort": String(END_SPACING),
  "elk.spacing.portsSurrounding": `[top=${CORNER_ROOM},left=${CORNER_ROOM},bottom=${CORNER_ROOM},right=${CORNER_ROOM}]`,
};

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

  const laidEdges = new Map((laid.edges ?? []).map((edge) => [edge.id, edge]));
  const shaped = new Map(input.nodes.map((node) => [node.id, { box: boxes.get(node.id)!, outline: node.outline }]));
  const edges: Record<string, RoutedEdge> = {};
  for (const edge of input.edges) edges[edge.id] = routeEdge(laidEdges.get(edge.id)!, edge, boxes, shaped);

  const routed = Object.values(edges);
  const groupLabels = Object.fromEntries(input.groups.map((g) => [g.id, placeGroupLabel(groups[g.id]!, g.label, routed)]));

  return { nodes, groups, edges, groupLabels, bounds: bounds(nodes, groups, edges, input.edges) };
}

function toElkGraph(input: LayoutInput, gutters: Record<string, number>): ElkNode {
  const loops = selfLoopSpacing(input);
  const childrenOf = (parent: string | undefined): ElkNode[] => [
    ...input.nodes.filter((n) => n.group === parent).map((n) => leaf(n, input)),
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
      ...SPACING,
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      ...loops,
    },
    children: childrenOf(undefined),
    edges: input.edges.map(elkEdge),
  };
}

// The stand-off is the loop's closing segment, so it carries the arrowhead. ELK also places a self loop's
// label beside the loop even when the label asks to be inline, so the loop has to clear the node by at least
// half the padded box as well. The option is read from the containing parent, never from the node, and the
// layered algorithm measures it in a frame transposed for DOWN.
function selfLoopSpacing(input: LayoutInput): LayoutOptions {
  const loops = input.edges.filter((edge) => edge.from === edge.to);
  if (loops.length === 0) return {};
  const room = loops.map((edge) =>
    edge.label === undefined ? 0 : (input.direction === "tb" ? edge.label.width : edge.label.height) / 2 + LABEL_MARGIN,
  );
  return { "elk.spacing.nodeSelfLoop": String(Math.max(ARROWHEAD_ROOM, ...room)) };
}

// ELK picks each end's side, then grows the node until its ends sit END_SPACING apart, spread out from
// CORNER_ROOM inside either corner, with a lone end mid-side. ELK's default alignment holds even a lone end
// a full spacing off both corners and so grows every node in the graph, and packing the ends mid-side
// routes more bends over examples/ and stress/ than spreading them.
function leaf(node: LayoutNode, input: LayoutInput): ElkNode {
  const ports = input.edges.filter((edge) => edge.from === node.id).flatMap((edge) => loopPorts(edge, input.direction));
  return {
    id: node.id,
    width: node.width,
    height: node.height,
    ...(ports.length > 0 ? { ports } : {}),
    layoutOptions: {
      "elk.nodeSize.constraints": "PORTS MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${node.width},${node.height})`,
      "elk.portAlignment.default": "JUSTIFIED",
    },
  };
}

// The segment joining a self loop's two feet carries its label, and Excalidraw blanks the line behind a
// bound label, so END_SPACING between the feet leaves two stubs with a word between them. ELK puts a loop's
// ports on its north side, top for lr and left for tb, out before in and at least END_SPACING apart; giving
// each port a length along that side and attaching the edge at its outer end holds the feet as far apart
// as the label needs, and the node grows only as much as that side has to.
function loopPorts(edge: LayoutEdge, direction: Direction): ElkPort[] {
  if (!isLabelledLoop(edge)) return [];
  const along = direction === "tb" ? edge.label.height : edge.label.width;
  const length = Math.ceil((along + (LABEL_MARGIN + LOOP_LABEL_RUN) * 2 - END_SPACING) / 2);
  const port = (end: "out" | "in", offset: number): ElkPort => ({
    id: `${edge.id}:${end}`,
    ...(direction === "tb" ? { width: 0, height: length } : { width: length, height: 0 }),
    layoutOptions: { "elk.port.anchor": direction === "tb" ? `(0,${offset})` : `(${offset},0)` },
  });
  return [port("out", 0), port("in", length)];
}

function isLabelledLoop(edge: LayoutEdge): edge is LayoutEdge & { label: TextSize } {
  return edge.from === edge.to && edge.label !== undefined;
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
      ...SPACING,
      ...loops,
    },
  };
}

// ELK skips labels whose text is empty, so the id stands in for the text; only the size matters here.
function elkEdge(edge: LayoutEdge): ElkExtendedEdge {
  const loop = isLabelledLoop(edge);
  return {
    id: edge.id,
    sources: [loop ? `${edge.id}:out` : edge.from],
    targets: [loop ? `${edge.id}:in` : edge.to],
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

interface Shaped {
  box: Box;
  outline: Outline;
}

function routeEdge(edge: ElkExtendedEdge, ends: LayoutEdge, boxes: Map<string, Box>, shaped: Map<string, Shaped>): RoutedEdge {
  const container = edge.container && edge.container !== ROOT ? boxes.get(edge.container) : undefined;
  const offset = container ?? { x: 0, y: 0 };
  const shift = (p: Point): Point => ({ x: offset.x + p.x, y: offset.y + p.y });
  const routed = dedupe((edge.sections ?? []).flatMap(sectionPoints).map(shift));
  const points =
    routed.length >= 2
      ? onOutlines(routed, shaped.get(ends.from)!, shaped.get(ends.to)!)
      : [center(boxes.get(ends.from)!), center(boxes.get(ends.to)!)];
  const label = edge.labels?.[0];
  return { points, ...(label ? { label: labelOnPath(points, shift({ x: label.x ?? 0, y: label.y ?? 0 }), label) } : {}) };
}

// ELK ends an arrow on its node's box, and Excalidraw draws the box only for a sharp rectangle: an ellipse leaves
// it everywhere but mid-side, and a rounded rectangle within cornerRadius of a corner. Running the end segment on
// along its own direction to the line keeps the route orthogonal and only lengthens the run under an arrowhead.
function onOutlines(points: Point[], from: Shaped, to: Shaped): Point[] {
  const last = points.length - 1;
  return points.map((point, i) => {
    if (i === 0) return onOutline(point, points[1]!, from);
    if (i === last) return onOutline(point, points[last - 1]!, to);
    return point;
  });
}

// In whole pixels, so an end the curve leaves by less than half a pixel stays where ELK put it, and a moved end
// lands at most half a pixel off the curve, inside the 2px line.
function onOutline(end: Point, next: Point, node: Shaped): Point {
  if (node.outline === "sharp") return end;
  const { box } = node;
  if (Math.abs(end.y - next.y) < STRAIGHT) {
    const inward = Math.sign(end.x - next.x);
    const side = inward > 0 ? box.x : box.x + box.width;
    if (Math.abs(end.x - side) > ON_SIDE) return end;
    return { x: end.x + inward * Math.round(inset(node, box.width, box.height, end.y - box.y)), y: end.y };
  }
  if (Math.abs(end.x - next.x) < STRAIGHT) {
    const inward = Math.sign(end.y - next.y);
    const side = inward > 0 ? box.y : box.y + box.height;
    if (Math.abs(end.y - side) > ON_SIDE) return end;
    return { x: end.x, y: end.y + inward * Math.round(inset(node, box.height, box.width, end.x - box.x)) };
  }
  return end;
}

/**
 * How far inside its box the outline runs at `at` along one side, where `across` is the box's extent at right
 * angles to that side and `along` its extent along it. Excalidraw draws a rounded corner as a quadratic curve from
 * cornerRadius along one side to cornerRadius along the next with its control point on the box corner, which
 * leaves the side by radius * (1 - sqrt(d / radius))^2 at d from the corner.
 */
function inset({ box, outline }: Shaped, across: number, along: number, at: number): number {
  if (outline === "ellipse") {
    const off = (at - along / 2) / (along / 2);
    return off * off >= 1 ? 0 : (across / 2) * (1 - Math.sqrt(1 - off * off));
  }
  const radius = cornerRadius(box.width, box.height);
  const fromCorner = Math.max(0, Math.min(at, along - at));
  if (fromCorner >= radius) return 0;
  const short = 1 - Math.sqrt(fromCorner / radius);
  return radius * short * short;
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
