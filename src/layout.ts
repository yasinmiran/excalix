import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkEdgeSection, ElkExtendedEdge, ElkLabel, ElkNode, ElkPort, LayoutOptions } from "elkjs/lib/elk.bundled.js";
import { ARROWHEAD_LENGTH, GROUP_STYLE, LABEL_MASK, cornerRadius } from "./style.js";
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
/**
 * Clearance reserved either side of an edge label across its edge, and all round a self loop's, so the text never
 * touches a neighbouring node or label.
 */
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
/**
 * Distance kept between two arrows running side by side. At ELK's default of 10 a picture scaled down to fit
 * a screen draws the pair as one thick line, and a label on either looks like it belongs to both.
 */
export const LANE_SPACING = 16;
// Distance between a corner and the nearest end on a side holding more than one. A lone end sits mid-side
// and needs twice this, so 28 is as far as it goes before NODE.minHeight stops covering it and every quiet
// node grows. A rounded corner's radius stops at 32, and 28 along it the curve is under a seventh of a
// pixel off the side, so no end lands on a rounded corner.
const CORNER_ROOM = 28;
// How near a corner a slide may take an end on a side holding others. ELK puts the nearest end a pixel inside
// CORNER_ROOM, and folding a step can take it two pixels further. 25 along the largest rounded corner the curve is
// still under half a pixel off the side, so the end stays on the straight part of the outline.
const SLIDE_CORNER_ROOM = 25;
/**
 * Line left showing on each side of a self loop's label, past the label's own clearance. Read off renders
 * at 12, 16 and 20: at 12 an async loop's outer segment is a tick mark, and 20 reads no better than 16.
 */
export const LOOP_LABEL_RUN = 16;
/**
 * Line left showing between an edge label and an arrowhead on the same arrow, past the line Excalidraw blanks round
 * the text. Read off renders at 6, 10, 12 and 18: at 6 the head reads as part of the label, an arrow drawn after the
 * word; at 12 the line between them reads as line. In the copy of dense-lr an agent reads, scaled to under 0.3, 12
 * keeps about 7 pixels of line and 6 under 4.
 */
export const LABEL_HEAD_RUN = 12;
// A label's layer sits ARROWHEAD_ROOM from its neighbours along the flow, so this much margin either side leaves
// LABEL_HEAD_RUN of line before a full head on an arrow that ends in the next layer.
const LABEL_MARGIN_ALONG = LABEL_HEAD_RUN + ARROWHEAD_LENGTH + LABEL_MASK - ARROWHEAD_ROOM;
// How far off its node's side an end may sit and still count as on it: the box and the route reach absolute
// coordinates through different sums of group offsets.
const ON_SIDE = 0.5;
// The same sums leave a segment that is meant to be straight off by a few ulps when it crosses nested groups.
const STRAIGHT = 1e-6;

// ELK reads each of these from the graph that holds what it applies to, so a group has to repeat every value or its
// children fall back to the defaults. 36 between the nodes of one layer takes 4.0% off the image area of examples/ and
// stress/ against 48 for 4 more bends; 32 takes 1.5% more for 8 more again.
const PER_GRAPH: LayoutOptions = {
  "elk.spacing.nodeNode": "36",
  "elk.spacing.edgeNode": "24",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(ARROWHEAD_ROOM),
  "elk.layered.spacing.edgeNodeBetweenLayers": String(ARROWHEAD_ROOM),
  "elk.spacing.portPort": String(END_SPACING),
  "elk.spacing.edgeEdge": String(LANE_SPACING),
  "elk.layered.spacing.edgeEdgeBetweenLayers": String(LANE_SPACING),
  "elk.spacing.portsSurrounding": `[top=${CORNER_ROOM},left=${CORNER_ROOM},bottom=${CORNER_ROOM},right=${CORNER_ROOM}]`,
  // Crossing minimisation tries this many orderings against ELK's default of 7, and draws them from a fixed seed, so
  // the output stays deterministic.
  "elk.layered.thoroughness": "60",
};

const elk = new ELK();

/**
 * ELK passes a layout may take once its layers are even: the first, then one more each time a group label is still
 * left under an arrow. Widening one group's gutter moves the arrows near another group's label, so the count is
 * capped rather than run to a fixed point; it depends only on the geometry, which keeps the output byte-identical.
 */
const MAX_PASSES = 3;

/** Lays out nodes, groups and edges with ELK. Absolute coordinates, bounds at (0, 0). */
export async function layout(input: LayoutInput): Promise<LayoutResult> {
  const probe = await layoutWith(input, {});
  const even = evenLayers(input, probe);
  const gutters: Record<string, number> = {};
  let result = even === input ? probe : await layoutWith(even, gutters);
  for (let pass = 1; pass < MAX_PASSES; pass++) {
    const more = labelGutters(even, result);
    if (Object.keys(more).length === 0) break;
    for (const [id, extra] of Object.entries(more)) gutters[id] = (gutters[id] ?? 0) + extra;
    result = await layoutWith(even, gutters);
  }
  return normalise(result);
}

/**
 * The input with each node as long along the flow as the longest node in its layer, so a column in lr reads as one
 * width the way a person draws it, and a row in tb as one height. ELK does not report layers, but it keeps the layers
 * of one graph apart along the flow, so siblings whose probe boxes overlap along it share one. Layering, ordering and
 * placement across the flow ignore that length, so the next pass keeps the same layers, and a layer already spans its
 * longest node, so nothing moves apart. A tb stack keeps its ragged widths: widening a row would push its nodes
 * apart, for 4.1% more area over examples/ and stress/.
 *
 * Only nodes joined by some path of edges are evened together. ELK puts every source in the first layer, so an
 * unconnected note or the head of a separate chain would otherwise take the length of whatever it happens to sit
 * beside, and a node with no edges but its own loop keeps its own length.
 */
function evenLayers(input: LayoutInput, probe: LayoutResult): LayoutInput {
  const [start, extent] = input.direction === "tb" ? (["y", "height"] as const) : (["x", "width"] as const);
  const component = components(input);
  const part = (node: LayoutNode): string => `${component.get(node.id)} ${node.group ?? ""}`;
  const longest = new Map<string, number>();
  for (const key of new Set(input.nodes.map(part))) {
    const boxes = input.nodes
      .filter((node) => part(node) === key)
      .map((node) => ({ id: node.id, box: probe.nodes[node.id]! }))
      .sort((a, b) => a.box[start] - b.box[start]);
    let layer: typeof boxes = [];
    let end = -Infinity;
    const close = (): void => {
      const length = Math.max(...layer.map(({ box }) => box[extent]));
      for (const { id } of layer) longest.set(id, length);
    };
    for (const item of boxes) {
      if (layer.length > 0 && item.box[start] >= end) {
        close();
        layer = [];
      }
      layer.push(item);
      end = Math.max(end, item.box[start] + item.box[extent]);
    }
    if (layer.length > 0) close();
  }
  if (input.nodes.every((node) => longest.get(node.id)! <= node[extent])) return input;
  return { ...input, nodes: input.nodes.map((node) => ({ ...node, [extent]: Math.max(node[extent], longest.get(node.id)!) })) };
}

// Each node's connected component over every edge, whatever groups lie between, as the index of one of its nodes.
function components(input: LayoutInput): Map<string, number> {
  const index = new Map(input.nodes.map((node, i) => [node.id, i]));
  const root = input.nodes.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]!)));
  for (const edge of input.edges) {
    const [a, b] = [find(index.get(edge.from)!), find(index.get(edge.to)!)];
    root[Math.max(a, b)] = Math.min(a, b);
  }
  return new Map(input.nodes.map((node, i) => [node.id, find(i)]));
}

// One ELK pass. Each gutter entry widens that group's left padding by its value.
async function layoutWith(input: LayoutInput, gutters: Record<string, number>): Promise<LayoutResult> {
  const reversed = backEdges(input);
  const laid = await elk.layout(toElkGraph(input, gutters, reversed));
  const exact = new Map<string, Box>();
  collectBoxes(laid, { x: 0, y: 0 }, exact);
  const boxes = new Map([...exact].map(([id, box]) => [id, wholeBox(box)]));

  const groupIds = new Set(input.groups.map((g) => g.id));
  const nodes: Record<string, Box> = {};
  const groups: Record<string, Box> = {};
  for (const [id, box] of boxes) (groupIds.has(id) ? groups : nodes)[id] = box;

  const laidEdges = new Map((laid.edges ?? []).map((edge) => [edge.id, edge]));
  const shaped = new Map(input.nodes.map((node) => [node.id, { box: boxes.get(node.id)!, outline: node.outline }]));
  const routes = input.edges.map((edge) => routeOf(laidEdges.get(edge.id)!, edge, reversed.has(edge.id), exact));
  tidyRoutes(routes, shaped);
  const edges = Object.fromEntries(routes.map((route) => [route.edge.id, finish(route, shaped)]));

  const routed = Object.values(edges);
  const groupLabels = Object.fromEntries(input.groups.map((g) => [g.id, placeGroupLabel(groups[g.id]!, g.label, routed)]));

  return { nodes, groups, edges, groupLabels, bounds: bounds(nodes, groups, edges, input.edges) };
}

function toElkGraph(input: LayoutInput, gutters: Record<string, number>, reversed: Set<string>): ElkNode {
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
      ...PER_GRAPH,
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      // Brandes-Koepf aligns a node with one neighbour, so once its ends are spread over a grown side a hub
      // fanning out sits level with its first target and every other edge steps down past it. Network simplex
      // places a node to shorten its edges as a whole, which puts the hub mid-fan again.
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      ...loops,
    },
    children: childrenOf(undefined),
    edges: input.edges.map((edge) => elkEdge(edge, reversed.has(edge.id), input.direction)),
  };
}

/**
 * The edges ELK is given reversed: each one that closes a cycle against reading order. ELK's own greedy cycle
 * breaker ignores the order nodes are listed in, and its model-order breakers fail on a nested graph in elkjs
 * 0.12, which sets the `modelOrder.maximum` they read only on the top graph. ELK lays out each group as one node
 * of its parent's graph, so an edge counts between the two siblings under the innermost group holding both ends,
 * and a group reads from where its first node is listed. Reversing the backward edges inside each strongly
 * connected component leaves every level acyclic, so ELK's breaker never chooses, and an acyclic spec is laid out
 * as before.
 */
function backEdges(input: LayoutInput): Set<string> {
  const parentOf = new Map<string, string | undefined>([
    ...input.nodes.map((node) => [node.id, node.group] as const),
    ...input.groups.map((group) => [group.id, group.parent] as const),
  ]);
  const chain = (id: string): string[] => {
    const ids: string[] = [];
    for (let at: string | undefined = id; at !== undefined; at = parentOf.get(at)) ids.unshift(at);
    return ids;
  };
  const listed = new Map<string, number>();
  input.nodes.forEach((node, index) => {
    for (const id of chain(node.id)) if (!listed.has(id)) listed.set(id, index);
  });

  const siblings = input.edges
    .filter((edge) => edge.from !== edge.to)
    .map((edge) => {
      const from = chain(edge.from);
      const to = chain(edge.to);
      let depth = 0;
      while (from[depth] === to[depth]) depth++;
      return { id: edge.id, from: from[depth]!, to: to[depth]! };
    });
  const next = new Map<string, string[]>();
  for (const edge of siblings) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const queue = [from];
    for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
      if (at === to) return true;
      for (const id of next.get(at) ?? []) if (!seen.has(id)) seen.add(id), queue.push(id);
    }
    return false;
  };
  return new Set(siblings.filter((edge) => listed.get(edge.from)! > listed.get(edge.to)! && reaches(edge.to, edge.from)).map((edge) => edge.id));
}

// The stand-off is the loop's closing segment, so it carries the arrowhead. ELK also places a self loop's
// label beside the loop even when the label asks to be inline, so the loop has to clear the node by at least
// half the padded box as well. The option is read from the containing parent, never from the node, and the
// layered algorithm measures it in a frame transposed for DOWN.
function selfLoopSpacing(input: LayoutInput): LayoutOptions {
  const loops = input.edges.filter((edge) => edge.from === edge.to);
  if (loops.length === 0) return {};
  const room = loops.map((edge) =>
    edge.label === undefined ? 0 : Math.ceil((input.direction === "tb" ? edge.label.width : edge.label.height) / 2) + LABEL_MARGIN,
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
  // Whole pixels, so rounding the laid-out boxes cannot take back any of the room the label needs.
  const top = Math.ceil(group.label.height) + PADDING;
  const left = PADDING + Math.ceil(gutter);
  const width = Math.ceil(group.label.width) + PADDING + left;
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
      ...PER_GRAPH,
      ...loops,
    },
  };
}

// ELK skips labels whose text is empty, so the id stands in for the text; only the size matters here. Across the
// flow a label keeps LABEL_MARGIN either side. Along it, the layer ELK gives the label already sits ARROWHEAD_ROOM
// from either neighbour, so it keeps only LABEL_MARGIN_ALONG.
function elkEdge(edge: LayoutEdge, reversed: boolean, direction: Direction): ElkExtendedEdge {
  const loop = isLabelledLoop(edge);
  const [marginX, marginY] = direction === "tb" ? [LABEL_MARGIN, LABEL_MARGIN_ALONG] : [LABEL_MARGIN_ALONG, LABEL_MARGIN];
  const [from, to] = reversed ? [edge.to, edge.from] : [edge.from, edge.to];
  return {
    id: edge.id,
    sources: [loop ? `${edge.id}:out` : from],
    targets: [loop ? `${edge.id}:in` : to],
    ...(edge.label
      ? {
          labels: [
            {
              text: edge.id,
              width: edge.label.width + marginX * 2,
              height: edge.label.height + marginY * 2,
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

export interface Shaped {
  box: Box;
  outline: Outline;
}

/** A route in whole pixels with its ends still on the boxes ELK ended them on, and the box ELK reserved for its label. */
export interface Route {
  edge: LayoutEdge;
  points: Point[];
  label?: { reserved: Point; laid: ElkLabel };
}

// `exact` holds ELK's own boxes: a route is offset by its container's exact position and only then rounded, the
// same way the boxes were, so an end ELK put on a side stays on it.
function routeOf(edge: ElkExtendedEdge, ends: LayoutEdge, reversed: boolean, exact: Map<string, Box>): Route {
  const container = edge.container && edge.container !== ROOT ? exact.get(edge.container) : undefined;
  const offset = container ?? { x: 0, y: 0 };
  const shift = (p: Point): Point => wholePoint({ x: offset.x + p.x, y: offset.y + p.y });
  const laid = straight(dedupe((edge.sections ?? []).flatMap(sectionPoints).map(shift)));
  const label = edge.labels?.[0];
  return {
    edge: ends,
    points: reversed ? laid.reverse() : laid,
    ...(label ? { label: { reserved: shift({ x: label.x ?? 0, y: label.y ?? 0 }), laid: label } } : {}),
  };
}

// Puts the ends on the outlines Excalidraw draws and the label on the path.
function finish(route: Route, shaped: Map<string, Shaped>): RoutedEdge {
  const from = shaped.get(route.edge.from)!;
  const to = shaped.get(route.edge.to)!;
  const points = route.points.length >= 2 ? onOutlines(route.points, from, to) : [center(from.box), center(to.box)];
  const { label } = route;
  const text = route.edge.label;
  return { points, ...(label && text ? { label: labelOnPath(points, label.reserved, label.laid, text) } : {}) };
}

/**
 * Spaces the crowded lanes of routes ELK laid out, then folds their jogs. `shaped` holds every node, keyed by id; its
 * boxes are the obstacles no move may take a route through.
 */
export function tidyRoutes(routes: Route[], shaped: Map<string, Shaped>): void {
  const obstacles = [...shaped.values()].map(({ box }) => box);
  spaceLanes(routes, obstacles, shaped);
  removeJogs(routes, obstacles, shaped);
}

/**
 * Shortest segment a route keeps. Where ELK cannot line up two ends that face each other it steps the route
 * between them by a pixel or two, which renders as a straight line while the file holds a stair the editor shows
 * once the arrow is selected.
 */
export const MIN_SEGMENT = 3;

// ELK spaces the runs of a channel and the runs of a layer, but not a run that crosses a channel against one that
// enters it from the next layer: two arrows that swap sides there can interleave whichever way the channel orders
// them, at whatever gap their ports leave. Each crowded pair is spaced by moving one of its two arrows: a run between
// two bends pushed sideways, bends and all, if either will go; else the run between two bends at one end of a crowded
// run pulled back along it; else a run that ends its route pushed, sliding that end along its side as a fold does.
function spaceLanes(routes: Route[], boxes: Box[], shaped: Map<string, Shaped>): void {
  const moves = [
    (at: number, index: number, other: Point[], from: number) => pushAway(routes, at, index, other, from, boxes, shaped, false),
    (at: number, index: number, other: Point[], from: number) => pullBack(routes, at, index, other, from, boxes),
    (at: number, index: number, other: Point[], from: number) => pushAway(routes, at, index, other, from, boxes, shaped, true),
  ];
  // A self loop keeps the shape its feet and its label were given room for.
  const movable = (at: number): boolean => routes[at]!.edge.from !== routes[at]!.edge.to;
  for (let a = 0; a < routes.length; a++) {
    for (let b = a + 1; b < routes.length; b++) {
      const push = ([i, j]: [number, number]): boolean =>
        moves.some((move) => (movable(a) && move(a, i, routes[b]!.points, j)) || (movable(b) && move(b, j, routes[a]!.points, i)));
      // Each push leaves fewer crowded pairs, so this ends.
      let pushed = true;
      while (pushed) pushed = crowdedPairs(routes[a]!, routes[b]!).some(push);
    }
  }
}

// Pairs of runs, one from each route, that share a stretch closer than a pixel under LANE_SPACING.
function crowdedPairs(a: Route, b: Route): [number, number][] {
  const runsB = runsOf(b.points);
  return runsOf(a.points).flatMap((run, i) =>
    runsB.flatMap((other, j): [number, number][] => (crowds(run, other) ? [[i, j]] : [])),
  );
}

// Moves run `index` of routes[at] to LANE_SPACING from run `from` of `other`, if it can go without a fault: a run between
// two bends, or with `slide` a run that ends the route and has a bend at its other end.
function pushAway(
  routes: Route[],
  at: number,
  index: number,
  other: Point[],
  from: number,
  boxes: Box[],
  shaped: Map<string, Shaped>,
  slide: boolean,
): boolean {
  const route = routes[at]!;
  const { points } = route;
  if (slide ? isInner(points, index) || points.length < 3 : !isInner(points, index)) return false;
  const run = runsOf(points)[index]!;
  const away = runsOf(other)[from]!;
  const to = away.at + (run.at >= away.at ? LANE_SPACING : -LANE_SPACING);
  if (Math.abs(to - run.at) > labelRoom(route, index)) return false;
  if (slide && !endCanSlide(routes, at, index, to, shaped)) return false;
  return tryRoute(routes, at, moveRun(points, index, to), boxes, "crowded");
}

// Moves the run between two bends at one end of run `index` of routes[at] along that run, so the run stops
// LANE_SPACING short of where run `from` of `other` ends and no longer shares a stretch with it. Two arrows that swap
// sides in a channel are spaced this way by swapping their places in it, without moving an end.
function pullBack(routes: Route[], at: number, index: number, other: Point[], from: number, boxes: Box[]): boolean {
  const route = routes[at]!;
  const { points } = route;
  if (labelRoom(route, index) < Infinity) return false;
  const run = runsOf(points)[index]!;
  const away = runsOf(other)[from]!;
  const along = (p: Point): number => (run.vertical ? p.y : p.x);
  // The runs that meet this one at its low and at its high end.
  const [atLow, atHigh] = along(points[index]!) < along(points[index + 1]!) ? [index - 1, index + 1] : [index + 1, index - 1];
  const options: [number, number][] = [];
  if (run.high > away.high + LANE_SPACING) options.push([atLow, away.high + LANE_SPACING]);
  if (run.low < away.low - LANE_SPACING) options.push([atHigh, away.low - LANE_SPACING]);
  return options.some(
    ([neighbour, to]) =>
      isInner(points, neighbour) &&
      Math.abs(to - runsOf(points)[neighbour]!.at) <= labelRoom(route, neighbour) &&
      tryRoute(routes, at, moveRun(points, neighbour, to), boxes, "crowded"),
  );
}

// Folds each step under MIN_SEGMENT into the runs either side of it by moving one of them onto the other: a run
// between two bends first, then a run that ends the route, which slides that end along its side, only as far as
// its neighbours on that side and the side's corners allow.
function removeJogs(routes: Route[], boxes: Box[], shaped: Map<string, Shaped>): void {
  for (const [at, route] of routes.entries()) {
    // A fold renumbers the points, so the scan starts over after one.
    for (let jog = 1; jog < route.points.length - 2; jog++) {
      const { points } = route;
      if (!isJog(points, jog)) continue;
      const before = runsOf(points)[jog - 1]!;
      const after = runsOf(points)[jog + 1]!;
      const options: [number, number][] = [
        [jog + 1, before.at],
        [jog - 1, after.at],
      ];
      const inner = options.filter(([index]) => isInner(points, index));
      const ends = options.filter(([index, to]) => !isInner(points, index) && endCanSlide(routes, at, index, to, shaped));
      if ([...inner, ...ends].some(([index, to]) => tryRoute(routes, at, moveRun(points, index, to), boxes, "short"))) jog = 0;
    }
  }
}

// A segment under MIN_SEGMENT between two runs that carry on the same way.
function isJog(points: Point[], index: number): boolean {
  const [a, b, c, d] = [points[index - 1]!, points[index]!, points[index + 1]!, points[index + 2]!];
  if (Math.hypot(c.x - b.x, c.y - b.y) >= MIN_SEGMENT) return false;
  const vertical = a.x === b.x && c.x === d.x;
  const horizontal = a.y === b.y && c.y === d.y;
  if (vertical) return Math.sign(b.y - a.y) === Math.sign(d.y - c.y);
  if (horizontal) return Math.sign(b.x - a.x) === Math.sign(d.x - c.x);
  return false;
}

// Sliding the run that ends a route moves that end along its side. The end keeps END_SPACING from every other end on
// that side, and room from both corners: SLIDE_CORNER_ROOM on a side holding other ends, while a lone end sits
// mid-side and only has to stay off a rounded corner's curve. An end that had less than either to begin with loses
// none of it.
function endCanSlide(routes: Route[], at: number, index: number, to: number, shaped: Map<string, Shaped>): boolean {
  const route = routes[at]!;
  const start = index === 0;
  const { box, outline } = shaped.get(start ? route.edge.from : route.edge.to)!;
  const end = start ? route.points[0]! : route.points.at(-1)!;
  const next = start ? route.points[1]! : route.points.at(-2)!;
  const neighbours = sideEnds(routes, at, start, end, next);
  const vertical = end.x === next.x;
  // An end on a top or bottom side slides along x, on a left or right side along y.
  const along = (p: Point): number => (vertical ? p.x : p.y);
  const [low, high] = vertical ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
  const corner = neighbours.length > 0 ? SLIDE_CORNER_ROOM : outline === "rounded" ? cornerRadius(box.width, box.height) : 0;
  const keeps = (now: number, after: number, room: number): boolean => after >= Math.min(room, now);
  if (!keeps(along(end) - low, to - low, corner) || !keeps(high - along(end), high - to, corner)) return false;
  return neighbours.every((other) => keeps(Math.abs(along(end) - other), Math.abs(to - other), END_SPACING));
}

// Where along the same side of the same node every other route ends.
function sideEnds(routes: Route[], at: number, start: boolean, end: Point, next: Point): number[] {
  const route = routes[at]!;
  const node = start ? route.edge.from : route.edge.to;
  const side = arrival(end, next);
  return routes.flatMap((other, i) => {
    if (i === at || other.points.length < 2) return [];
    const found: Point[] = [];
    if (other.edge.from === node && arrival(other.points[0]!, other.points[1]!) === side) found.push(other.points[0]!);
    if (other.edge.to === node && arrival(other.points.at(-1)!, other.points.at(-2)!) === side) found.push(other.points.at(-1)!);
    return found.map((p) => (side === "left" || side === "right" ? p.y : p.x));
  });
}

function arrival(end: Point, next: Point): "left" | "right" | "top" | "bottom" {
  if (end.y === next.y) return end.x > next.x ? "left" : "right";
  return end.y > next.y ? "top" : "bottom";
}

// Replaces routes[at] with the candidate when that lowers the fault it is for and raises none. A move may leave two
// lanes a pixel under LANE_SPACING, as rounding does, since the fault it removes is the worse of the two.
function tryRoute(routes: Route[], at: number, candidate: Point[], boxes: Box[], fixing: "crowded" | "short"): boolean {
  const others = routes.filter((_, i) => i !== at).map((route) => route.points);
  const now = faults(routes[at]!.points, others, boxes);
  const next = faults(candidate, others, boxes);
  const fixed = next[fixing] < now[fixing];
  const worse =
    next.crowded > now.crowded ||
    next.crossings > now.crossings ||
    next.entered > now.entered ||
    next.short > now.short ||
    next.endRun < now.endRun;
  if (!fixed || worse) return false;
  routes[at]!.points = candidate;
  return true;
}

interface Faults {
  /** Pairs of runs, own against another route's, sharing a stretch more than a pixel under LANE_SPACING apart. */
  crowded: number;
  crossings: number;
  /** Segments that pass through a node box. */
  entered: number;
  short: number;
  /** The shorter of the two end segments, up to ARROWHEAD_ROOM. */
  endRun: number;
}

function faults(points: Point[], others: Point[][], boxes: Box[]): Faults {
  const own = runsOf(points);
  const theirs = others.flatMap(runsOf);
  let crowded = 0;
  let crossings = 0;
  for (const run of own) {
    for (const other of theirs) {
      if (crowds(run, other)) crowded++;
      if (crosses(run, other)) crossings++;
    }
  }
  const segments = points.slice(1).map((to, i) => [points[i]!, to] as const);
  const lengths = segments.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
  return {
    crowded,
    crossings,
    entered: segments.filter(([a, b]) => boxes.some((box) => passesThrough(a, b, box))).length,
    short: lengths.filter((length) => length < MIN_SEGMENT).length,
    endRun: Math.min(ARROWHEAD_ROOM, lengths[0] ?? 0, lengths.at(-1) ?? 0),
  };
}

// One axis-parallel segment: `at` across it, `low` to `high` along it.
interface Run {
  vertical: boolean;
  at: number;
  low: number;
  high: number;
}

function runsOf(points: Point[]): Run[] {
  return points.slice(1).map((b, i) => {
    const a = points[i]!;
    const vertical = a.x === b.x;
    const [along, across] = vertical ? (["y", "x"] as const) : (["x", "y"] as const);
    return { vertical, at: a[across], low: Math.min(a[along], b[along]), high: Math.max(a[along], b[along]) };
  });
}

// Two runs share a stretch more than a pixel under LANE_SPACING apart. ELK spaced every pair exactly, and rounding each
// route to whole pixels on its own can bring a pair a pixel closer.
function crowds(a: Run, b: Run): boolean {
  return gapBeside(a, b) < LANE_SPACING - 1;
}

// How far apart two parallel runs sit where they share a stretch, or Infinity when they do not.
function gapBeside(a: Run, b: Run): number {
  if (a.vertical !== b.vertical || Math.min(a.high, b.high) <= Math.max(a.low, b.low)) return Infinity;
  return Math.abs(a.at - b.at);
}

// A crossing in the middle of both runs, not where one ends on the other.
function crosses(a: Run, b: Run): boolean {
  if (a.vertical === b.vertical) return false;
  return b.low < a.at && a.at < b.high && a.low < b.at && b.at < a.high;
}

// Strictly inside the box, so an end on its side does not count.
function passesThrough(a: Point, b: Point, box: Box): boolean {
  const [left, right] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [top, bottom] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return left < box.x + box.width && right > box.x && top < box.y + box.height && bottom > box.y;
}

// Run `index` lies between two bends, so moving it moves no end.
function isInner(points: Point[], index: number): boolean {
  return index >= 1 && index + 2 <= points.length - 1;
}

// How far run `index` can move and keep the text it carries inside the box ELK reserved for it: the label goes where
// the path passes nearest that box's centre, and only that box was kept clear. The box keeps less room along the flow
// than across it, so the room depends on which way the run moves.
function labelRoom(route: Route, index: number): number {
  const { label, edge } = route;
  if (!label || !edge.label) return Infinity;
  const { width = 0, height = 0 } = label.laid;
  const { point } = nearestOnPolyline(route.points, { x: label.reserved.x + width / 2, y: label.reserved.y + height / 2 });
  const run = runsOf(route.points)[index]!;
  const [across, along] = run.vertical ? [point.x, point.y] : [point.y, point.x];
  if (across !== run.at || along < run.low || along > run.high) return Infinity;
  return run.vertical ? (width - edge.label.width) / 2 : (height - edge.label.height) / 2;
}

// Sets run `index` to `to` across its length, which moves the two points it joins, and drops what that folds away.
function moveRun(points: Point[], index: number, to: number): Point[] {
  const vertical = points[index]!.x === points[index + 1]!.x;
  const moved = points.map((p, i) => (i === index || i === index + 1 ? (vertical ? { x: to, y: p.y } : { x: p.x, y: to }) : p));
  return straight(dedupe(moved));
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
function labelOnPath(points: Point[], reserved: Point, label: ElkLabel, text: TextSize): RoutedLabel {
  const { t, point } = nearestOnPolyline(points, { x: reserved.x + (label.width ?? 0) / 2, y: reserved.y + (label.height ?? 0) / 2 });
  return { x: point.x - text.width / 2, y: point.y - text.height / 2, position: t };
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

// Rounding folds ELK's sub-pixel jogs into a run, which leaves a bend with nothing to turn; without it the run
// under an arrowhead would measure only its last stretch.
function straight(points: Point[]): Point[] {
  return points.filter((p, i) => {
    if (i === 0 || i === points.length - 1) return true;
    const a = points[i - 1]!;
    const b = points[i + 1]!;
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

// Whole pixels, for the reason measured widths are: ELK's node placement leaves centres on half pixels, and a
// lone end it puts on a whole one turns a straight edge into a half-pixel diagonal. Rounding a box by its edges
// keeps every child inside its group.
function wholeBox(box: Box): Box {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  return { x, y, width: Math.round(box.x + box.width) - x, height: Math.round(box.y + box.height) - y };
}

function wholePoint(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
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

// By whole pixels, so boxes and routes stay whole when a label centred on a run sets the bounds from a half
// pixel; the bounds then start at the origin and run a fraction further.
function normalise(result: LayoutResult): LayoutResult {
  const dx = -Math.floor(result.bounds.x);
  const dy = -Math.floor(result.bounds.y);
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
    bounds: { x: 0, y: 0, width: result.bounds.x + dx + result.bounds.width, height: result.bounds.y + dy + result.bounds.height },
  };
}
