import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkEdgeSection, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Box, Direction, LayoutEdge, LayoutGroup, LayoutInput, LayoutNode, LayoutResult, Point, RoutedEdge } from "./types.js";

const ROOT = ":root";
const PADDING = 16;

const elk = new ELK();

/** Lays out nodes, groups and edges with ELK. Absolute coordinates, bounds at (0, 0). */
export async function layout(input: LayoutInput): Promise<LayoutResult> {
  const laid = await elk.layout(toElkGraph(input));
  const boxes = new Map<string, Box>();
  collectBoxes(laid, { x: 0, y: 0 }, boxes);

  const groupIds = new Set(input.groups.map((g) => g.id));
  const nodes: Record<string, Box> = {};
  const groups: Record<string, Box> = {};
  for (const [id, box] of boxes) (groupIds.has(id) ? groups : nodes)[id] = box;

  const edges: Record<string, RoutedEdge> = {};
  for (const edge of laid.edges ?? []) edges[edge.id] = routeEdge(edge, boxes);

  return normalise({ nodes, groups, edges, bounds: bounds(nodes, groups, edges, input.edges) });
}

function toElkGraph(input: LayoutInput): ElkNode {
  const childrenOf = (parent: string | undefined): ElkNode[] => [
    ...input.nodes.filter((n) => n.group === parent).map(leaf),
    ...input.groups.filter((g) => g.parent === parent).map((g) => groupNode(g, input.direction, childrenOf(g.id))),
  ];
  return {
    id: ROOT,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": input.direction === "tb" ? "DOWN" : "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.edgeLabels.placement": "CENTER",
    },
    children: childrenOf(undefined),
    edges: input.edges.map(elkEdge),
  };
}

function leaf(node: LayoutNode): ElkNode {
  return { id: node.id, width: node.width, height: node.height };
}

function groupNode(group: LayoutGroup, direction: Direction, children: ElkNode[]): ElkNode {
  const top = group.label.height + PADDING;
  const width = group.label.width + PADDING * 2;
  const height = top + PADDING;
  if (children.length === 0) return { id: group.id, width, height };
  // ELK 0.12 applies a compound node's minimum size in the layered algorithm's internal frame, which is transposed for DOWN.
  const minimum = direction === "tb" ? `(${height},${width})` : `(${width},${height})`;
  return {
    id: group.id,
    children,
    layoutOptions: {
      "elk.padding": `[top=${top},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": minimum,
    },
  };
}

// ELK skips labels whose text is empty, so the id stands in for the text; only the size matters here.
function elkEdge(edge: LayoutEdge): ElkExtendedEdge {
  return {
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
    ...(edge.label ? { labels: [{ text: edge.id, ...edge.label }] } : {}),
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
  const points = dedupe((edge.sections ?? []).flatMap(sectionPoints).map(shift));
  const label = edge.labels?.[0];
  return {
    points: points.length >= 2 ? points : [center(boxes.get(edge.sources[0]!)!), center(boxes.get(edge.targets[0]!)!)],
    ...(label ? { label: shift({ x: label.x ?? 0, y: label.y ?? 0 }) } : {}),
  };
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
    edges: mapValues(result.edges, (edge) => ({
      points: edge.points.map(movePoint),
      ...(edge.label ? { label: movePoint(edge.label) } : {}),
    })),
    bounds: { ...result.bounds, x: 0, y: 0 },
  };
}
