import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createIdSource, edgeKey, hashSpec } from "./ids.js";
import { ARROWHEAD_ROOM, END_SPACING, LABEL_HEAD_RUN, LANE_SPACING, LOOP_LABEL_RUN, MIN_SEGMENT } from "./layout.js";
import { sketch } from "./pipeline.js";
import { parseSpec } from "./spec.js";
import { ARROWHEAD_LENGTH, LABEL_MASK, NODE, arrowheads, cornerRadius } from "./style.js";
import type { Box, Point, Renderer, TextMeasurer } from "./types.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every committed spec, so a new file in either directory is covered without touching a test. */
export const specFiles = ["examples", "stress"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${dir}/${name}`),
);

/** The raw JSON of a committed spec, ready for parseSpec or sketch. */
export function readSpec(file: string): unknown {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

export type Invariant =
  | "nodesApart"
  | "nodesNested"
  | "labelsClearNodes"
  | "labelsClearLabels"
  | "arrowsClearGroupLabels"
  | "arrowsClearNodes"
  | "headRoom"
  | "endsApart"
  | "lanesApart"
  | "noJogs"
  | "endsOnOutline"
  | "loopLabelRun"
  | "labelHeadRun"
  | "insideBounds";

/** Layout defects a suite still has, keyed by spec file. An entry turns its cell into an it.fails. */
export type KnownDefects = Record<string, Partial<Record<Invariant, string>>>;

const TITLES: Record<Invariant, string> = {
  nodesApart: "no two node boxes overlap",
  nodesNested: "every node sits inside its group and every group inside its parent",
  labelsClearNodes: "no edge label overlaps a node box",
  labelsClearLabels: "no two edge labels overlap",
  arrowsClearGroupLabels: "no arrow segment crosses a group label",
  arrowsClearNodes: "no arrow passes through a node it does not join",
  headRoom: `every arrowhead sits on a segment of at least ${ARROWHEAD_ROOM}px`,
  endsApart: `arrow ends on one side of a node stay ${END_SPACING}px apart`,
  lanesApart: `two arrows running side by side stay ${LANE_SPACING}px apart`,
  noJogs: `no arrow segment is shorter than ${MIN_SEGMENT}px`,
  endsOnOutline: "every arrow end touches the outline Excalidraw draws for its node",
  loopLabelRun: `a self loop's outer segment runs ${LOOP_LABEL_RUN}px past its label at both ends`,
  labelHeadRun: `${LABEL_HEAD_RUN}px of line show between an edge label and either arrowhead on its arrow`,
  insideBounds: "every box but the title starts inside the layout bounds",
};

// ELK rounds its coordinates, so a distance counts as met when it misses by less than half a pixel.
const SLACK = 0.5;
// The layout rounds each route to whole pixels on its own, moving a run up to half a pixel, so two runs ELK
// spaced exactly can come out up to a pixel closer.
const LANE_SLACK = 1;
// The layout rounds the box ELK reserved for a label and the node past it to whole pixels each on its own, so the
// line between the label and that node's arrowhead can come out up to a pixel short of what ELK spaced.
const LABEL_RUN_SLACK = 1;
// A node's line is NODE.strokeWidth wide, so an end within half of that of the curve touches it. The layout moves
// an end in whole pixels, which leaves it up to half a pixel either side of the curve.
const OUTLINE_SLACK = NODE.strokeWidth / 2;
// Enough samples that the polyline strays from the curve by under a hundredth of a pixel.
const ELLIPSE_STEPS = 720;
const CORNER_STEPS = 64;

interface Named {
  name: string;
  box: Box;
}

interface NamedNode extends Named {
  id: string;
  /** The line Excalidraw strokes for the node, as a closed polyline. */
  outline: Point[];
}

interface Arrow {
  name: string;
  points: Point[];
  from: string;
  to: string;
  heads: { start: boolean; end: boolean };
  label?: Box;
}

interface Scene {
  nodes: NamedNode[];
  groupLabels: Named[];
  edgeLabels: Named[];
  arrows: Arrow[];
  nested: { inner: Named; outer: Named }[];
  /** Every box the layout bounds must cover, so the title is left out on purpose. */
  bounded: Named[];
}

interface SceneElement extends Box {
  id: string;
  type: string;
  roundness: { type: number } | null;
  points?: [number, number][];
}

/** Registers the fourteen layout invariants for every committed spec, measured however the caller measures. */
export function describeGeometry(title: string, measurer: () => TextMeasurer, known: KnownDefects = {}): void {
  for (const file of specFiles) {
    describe(`${title} ${file}`, () => {
      // Resolved on first use, so a suite whose measurer comes from a beforeAll hook works too.
      let pending: Promise<Scene> | undefined;
      const sceneOnce = (): Promise<Scene> => (pending ??= sceneOf(file, measurer()));
      const check = (invariant: Invariant, violations: (scene: Scene) => string[]): void => {
        const body = async () => {
          expect(violations(await sceneOnce())).toEqual([]);
        };
        const reason = known[file]?.[invariant];
        if (reason) it.fails(`${TITLES[invariant]}: ${reason}`, body);
        else it(TITLES[invariant], body);
      };

      check("nodesApart", (scene) => overlapsWithin(scene.nodes));
      check("nodesNested", (scene) =>
        scene.nested
          .filter(({ inner, outer }) => !contains(outer.box, inner.box))
          .map(({ inner, outer }) => `${boxAt(inner)} is not inside ${boxAt(outer)}`),
      );
      check("labelsClearNodes", (scene) => overlapsAcross(scene.edgeLabels, scene.nodes));
      check("labelsClearLabels", (scene) => overlapsWithin(scene.edgeLabels));
      check("arrowsClearGroupLabels", (scene) => scene.arrows.flatMap((arrow) => scene.groupLabels.flatMap((label) => crossings(arrow, label))));
      check("arrowsClearNodes", (scene) =>
        scene.arrows.flatMap((arrow) =>
          scene.nodes.filter((node) => node.id !== arrow.from && node.id !== arrow.to).flatMap((node) => crossings(arrow, node)),
        ),
      );
      check("headRoom", (scene) => scene.arrows.flatMap(shortHeadSegments));
      check("endsApart", crowdedSides);
      check("lanesApart", closeLanes);
      check("noJogs", (scene) => scene.arrows.flatMap(jogs));
      check("endsOnOutline", (scene) => scene.arrows.flatMap((arrow) => offOutline(scene, arrow)));
      check("loopLabelRun", (scene) => scene.arrows.flatMap(buriedLoopSegment));
      check("labelHeadRun", (scene) => scene.arrows.flatMap(buriedHeads));
      check("insideBounds", (scene) =>
        scene.bounded.filter(({ box }) => box.x < 0 || box.y < 0).map((item) => `${boxAt(item)} starts left of x=0 or above y=0`),
      );
    });
  }
}

/** The chunks of a PNG in file order. */
export function pngChunks(png: Uint8Array): { type: string; data: Buffer }[] {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    chunks.push({ type: bytes.toString("latin1", at + 4, at + 8), data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

/** A scene as Excalidraw embeds it in an exported image. */
export interface EmbeddedScene {
  type: string;
  source: string;
  elements: unknown[];
  appState: Record<string, unknown>;
}

const SCENE_MIME = "application/vnd.excalidraw+json";

/**
 * The scene an SVG or PNG export carries, decoded without the editor: an SVG holds it base64 in a comment inside
 * its metadata, a PNG in a tEXt chunk, and either way it is JSON wrapping the deflated scene as a byte string.
 */
export function embeddedScene(image: string | Uint8Array): EmbeddedScene | undefined {
  let wrapped: string | undefined;
  if (typeof image === "string") {
    const payload = /<!-- payload-type:application\/vnd\.excalidraw\+json -->.*?<!-- payload-start -->(.+?)<!-- payload-end -->/s.exec(image);
    wrapped = payload ? Buffer.from(payload[1]!.trim(), "base64").toString("latin1") : undefined;
  } else {
    const keyword = `${SCENE_MIME}\0`;
    const text = pngChunks(image).find(({ type, data }) => type === "tEXt" && data.toString("latin1").startsWith(keyword));
    wrapped = text?.data.toString("latin1").slice(keyword.length);
  }
  if (!wrapped) return undefined;
  const { encoded, compressed } = JSON.parse(wrapped) as { encoded: string; compressed: boolean };
  const bytes = Buffer.from(encoded, "latin1");
  return JSON.parse((compressed ? inflateSync(bytes) : bytes).toString("utf8")) as EmbeddedScene;
}

/** A renderer for tests that read elements only: it measures, and its svg and png are stubs. */
export function measuringOnly(measurer: TextMeasurer): Renderer {
  return { measurer, svg: async () => "", png: async () => new Uint8Array(), close: async () => {} };
}

async function sceneOf(file: string, measurer: TextMeasurer): Promise<Scene> {
  const input = readSpec(file);
  const spec = parseSpec(input);
  const ids = createIdSource(hashSpec(spec));
  const elements = JSON.parse((await sketch(input, measuringOnly(measurer))).excalidraw).elements as SceneElement[];
  const byId = new Map(elements.map((element) => [element.id, element]));
  const element = (key: string): SceneElement => {
    const found = byId.get(ids.id(key));
    if (!found) throw new Error(`${file} has no element for ${key}`);
    return found;
  };
  const named = (name: string, key: string): Named => ({ name, box: element(key) });
  const group = (id: string): Named => named(`group ${id}`, `group:${id}`);

  const nodes = spec.nodes.map((node) => {
    const shape = element(`node:${node.id}`);
    return { id: node.id, name: `node ${node.id}`, box: shape, outline: drawnOutline(shape) };
  });
  const nodeLabels = spec.nodes.map((node) => named(`node ${node.id} label`, `node:${node.id}:label`));
  const groups = spec.groups.map(({ id }) => group(id));
  const groupLabels = spec.groups.map(({ id }) => named(`group ${id} label`, `group:${id}:label`));
  const edgeLabels = spec.edges.flatMap((edge, index) =>
    edge.label === undefined ? [] : [named(`edge ${index} label "${edge.label}"`, `${edgeKey(index)}:label`)],
  );
  const arrows = spec.edges.map((edge, index) => {
    const { x, y, points = [] } = element(edgeKey(index));
    const { start, end } = arrowheads(edge.arrows);
    return {
      name: `edge ${index} ${edge.from}->${edge.to}`,
      points: points.map(([dx, dy]) => ({ x: x + dx, y: y + dy })),
      from: edge.from,
      to: edge.to,
      heads: { start: start !== null, end: end !== null },
      ...(edge.label === undefined ? {} : { label: element(`${edgeKey(index)}:label`) }),
    };
  });

  return {
    nodes,
    groupLabels,
    edgeLabels,
    arrows,
    nested: [
      ...spec.nodes.flatMap((node, index) => (node.group === undefined ? [] : [{ inner: nodes[index]!, outer: group(node.group) }])),
      ...spec.groups.flatMap((child) => (child.parent === undefined ? [] : [{ inner: group(child.id), outer: group(child.parent) }])),
    ],
    bounded: [...nodes, ...nodeLabels, ...groups, ...groupLabels, ...edgeLabels, ...arrows.map(polylineBox)],
  };
}

// Excalidraw draws an arrowhead min(25, segment / 2) long from the segment it ends on, so a short one
// shrinks the head instead of the arrow.
function shortHeadSegments(arrow: Arrow): string[] {
  const ends: [boolean, Point | undefined, Point | undefined][] = [
    [arrow.heads.end, arrow.points.at(-2), arrow.points.at(-1)],
    [arrow.heads.start, arrow.points[1], arrow.points[0]],
  ];
  return ends.flatMap(([drawn, from, to]) => {
    if (!drawn || !from || !to) return [];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return length + SLACK >= ARROWHEAD_ROOM ? [] : [`${arrow.name} ends on a segment of ${round(length)}px at ${pointAt(to)}`];
  });
}

// Two arrowheads closer together than their own width read as one blob, so every end on a side has to
// keep its distance from its neighbour along that side.
function crowdedSides(scene: Scene): string[] {
  const sides = new Map<string, { at: number; name: string }[]>();
  const place = (id: string, end: Point, next: Point | undefined, name: string): void => {
    const node = scene.nodes.find((candidate) => candidate.id === id);
    const side = next && arrivalSide(end, next);
    if (!node || !side) return;
    const key = `${node.name} ${side}`;
    const along = side === "left" || side === "right" ? end.y : end.x;
    sides.set(key, [...(sides.get(key) ?? []), { at: along, name }]);
  };
  for (const arrow of scene.arrows) {
    place(arrow.from, arrow.points[0]!, arrow.points[1], arrow.name);
    place(arrow.to, arrow.points.at(-1)!, arrow.points.at(-2), arrow.name);
  }
  return [...sides].flatMap(([key, ends]) => {
    const sorted = [...ends].sort((a, b) => a.at - b.at);
    return sorted.slice(1).flatMap((end, index) => {
      const previous = sorted[index]!;
      const gap = end.at - previous.at;
      return gap + SLACK >= END_SPACING ? [] : [`${key}: ${previous.name} and ${end.name} are ${round(gap)}px apart`];
    });
  });
}

// Two arrows closer than LANE_SPACING along a shared stretch read as one thick line once the picture is
// scaled down. Runs of one arrow are left alone, and so are runs that only meet end to end.
function closeLanes(scene: Scene): string[] {
  const runs = scene.arrows.flatMap((arrow) =>
    arrow.points.slice(1).map((to, index) => {
      const from = arrow.points[index]!;
      const vertical = Math.abs(from.x - to.x) < SLACK;
      const [along, across] = vertical ? (["y", "x"] as const) : (["x", "y"] as const);
      return { arrow: arrow.name, vertical, at: from[across], lo: Math.min(from[along], to[along]), hi: Math.max(from[along], to[along]) };
    }),
  );
  return runs.flatMap((run, index) =>
    runs.slice(index + 1).flatMap((other) => {
      if (other.arrow === run.arrow || other.vertical !== run.vertical) return [];
      const shared = Math.min(run.hi, other.hi) - Math.max(run.lo, other.lo);
      const gap = Math.abs(run.at - other.at);
      if (shared <= 0 || gap + LANE_SLACK >= LANE_SPACING) return [];
      return [`${run.arrow} and ${other.arrow} run ${round(gap)}px apart for ${round(shared)}px at ${run.vertical ? "x" : "y"}=${round(run.at)}`];
    }),
  );
}

// A step this short draws as part of a straight line, so the arrow looks straight in the render and shows a stair
// once it is selected in the editor.
function jogs(arrow: Arrow): string[] {
  return arrow.points.slice(1).flatMap((to, index) => {
    const from = arrow.points[index]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return length >= MIN_SEGMENT ? [] : [`${arrow.name} steps ${round(length)}px at ${pointAt(from)}-${pointAt(to)}`];
  });
}

// The side an end comes in through, read off the segment it closes: an end on a curved outline sits inside
// the box, off every side of it.
function arrivalSide(end: Point, next: Point): "left" | "right" | "top" | "bottom" | undefined {
  const dx = end.x - next.x;
  const dy = end.y - next.y;
  if (dx === 0 && dy === 0) return undefined;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "left" : "right";
  return dy > 0 ? "top" : "bottom";
}

// ELK ends an arrow on its node's box, which is the line Excalidraw draws only for a sharp rectangle.
function offOutline(scene: Scene, arrow: Arrow): string[] {
  const ends: [string, Point][] = [
    [arrow.from, arrow.points[0]!],
    [arrow.to, arrow.points.at(-1)!],
  ];
  return ends.flatMap(([id, end]) => {
    const node = scene.nodes.find((candidate) => candidate.id === id);
    if (!node) return [];
    const gap = distanceToPolyline(node.outline, end);
    return gap <= OUTLINE_SLACK ? [] : [`${arrow.name} ends ${round(gap)}px off the outline of ${node.name} at ${pointAt(end)}`];
  });
}

// What Excalidraw strokes for a node: the ellipse inscribed in its box, or a rectangle whose rounded corners are
// quadratic curves from cornerRadius along one side to cornerRadius along the next, pulled towards the box corner.
function drawnOutline(shape: SceneElement): Point[] {
  const { x, y, width: w, height: h } = shape;
  if (shape.type === "ellipse") {
    return Array.from({ length: ELLIPSE_STEPS + 1 }, (_, i) => {
      const angle = (2 * Math.PI * i) / ELLIPSE_STEPS;
      return { x: x + (w / 2) * (1 + Math.cos(angle)), y: y + (h / 2) * (1 + Math.sin(angle)) };
    });
  }
  const r = shape.roundness ? cornerRadius(w, h) : 0;
  const corners: [Point, Point, Point][] = [
    [{ x: w - r, y: 0 }, { x: w, y: 0 }, { x: w, y: r }],
    [{ x: w, y: h - r }, { x: w, y: h }, { x: w - r, y: h }],
    [{ x: r, y: h }, { x: 0, y: h }, { x: 0, y: h - r }],
    [{ x: 0, y: r }, { x: 0, y: 0 }, { x: r, y: 0 }],
  ];
  const curves = corners.flatMap(([from, corner, to]) =>
    Array.from({ length: CORNER_STEPS + 1 }, (_, i) => {
      const t = i / CORNER_STEPS;
      const [a, b, c] = [(1 - t) * (1 - t), 2 * (1 - t) * t, t * t];
      return { x: x + a * from.x + b * corner.x + c * to.x, y: y + a * from.y + b * corner.y + c * to.y };
    }),
  );
  return [...curves, curves[0]!];
}

// Excalidraw blanks the line behind a bound label, so a self loop whose outer segment is no longer than the
// label centred on it comes out as two stubs with a word between them instead of a loop.
function buriedLoopSegment(arrow: Arrow): string[] {
  const { label } = arrow;
  if (arrow.from !== arrow.to || !label || arrow.points.length < 2) return [];
  const [from, to] = nearestSegment(arrow.points, { x: label.x + label.width / 2, y: label.y + label.height / 2 });
  const vertical = Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
  const [start, end] = vertical ? [from.y, to.y] : [from.x, to.x];
  const [low, high] = [Math.min(start, end), Math.max(start, end)];
  const [labelLow, labelSpan] = vertical ? [label.y, label.height] : [label.x, label.width];
  const runs = [labelLow - low, high - labelLow - labelSpan];
  if (runs.every((run) => run + SLACK >= LOOP_LABEL_RUN)) return [];
  return [`${arrow.name} label sits on a ${round(high - low)}px segment showing ${runs.map(round).join("px and ")}px of line`];
}

// Excalidraw blanks the line LABEL_MASK round a bound label and draws a head up to ARROWHEAD_LENGTH back from its
// tip, so a label close to a head leaves no line between them and the head reads as part of the text.
function buriedHeads(arrow: Arrow): string[] {
  const { label, points } = arrow;
  if (!label) return [];
  const mask = { x: label.x - LABEL_MASK, y: label.y - LABEL_MASK, width: label.width + LABEL_MASK * 2, height: label.height + LABEL_MASK * 2 };
  const lengths = points.slice(1).map((to, i) => Math.hypot(to.x - points[i]!.x, to.y - points[i]!.y));
  let enters = Infinity;
  let leaves = -Infinity;
  let travelled = 0;
  for (const [i, length] of lengths.entries()) {
    const through = stretchThrough(points[i]!, points[i + 1]!, mask);
    if (through) {
      enters = Math.min(enters, travelled + through[0] * length);
      leaves = Math.max(leaves, travelled + through[1] * length);
    }
    travelled += length;
  }
  if (enters > leaves) return [];
  const head = (segment: number): number => Math.min(ARROWHEAD_LENGTH, segment / 2);
  const runs: [boolean, string, number][] = [
    [arrow.heads.start, "start", enters - head(lengths[0]!)],
    [arrow.heads.end, "end", travelled - head(lengths.at(-1)!) - leaves],
  ];
  return runs.flatMap(([drawn, end, run]) =>
    !drawn || run + LABEL_RUN_SLACK >= LABEL_HEAD_RUN ? [] : [`${arrow.name} label shows ${round(run)}px of line before its ${end} arrowhead`],
  );
}

function nearestSegment(points: Point[], target: Point): [Point, Point] {
  let best: { distance: number; segment: [Point, Point] } = { distance: Infinity, segment: [points[0]!, points[1]!] };
  for (let i = 1; i < points.length; i++) {
    const segment: [Point, Point] = [points[i - 1]!, points[i]!];
    const distance = distanceToSegment(target, ...segment);
    if (distance < best.distance) best = { distance, segment };
  }
  return best.segment;
}

function distanceToPolyline(points: Point[], target: Point): number {
  return Math.min(...points.slice(1).map((point, i) => distanceToSegment(target, points[i]!, point)));
}

function distanceToSegment(target: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  const s = squared === 0 ? 0 : Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / squared));
  return Math.hypot(target.x - (a.x + dx * s), target.y - (a.y + dy * s));
}

// An arrow element stores its origin at the first polyline point, which is rarely the top-left corner.
function polylineBox(arrow: Arrow): Named {
  const xs = arrow.points.map((point) => point.x);
  const ys = arrow.points.map((point) => point.y);
  const [left, top] = [Math.min(...xs), Math.min(...ys)];
  return { name: arrow.name, box: { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top } };
}

/** Strict on every side, so boxes that share an edge count as clear of each other. */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** True when the segment passes through the interior of the box. Grazing an edge does not count. */
function crosses(from: Point, to: Point, box: Box): boolean {
  return stretchThrough(from, to, box) !== undefined;
}

/** Where the segment runs through the interior of the box, as fractions of its length, or undefined when it does not. */
function stretchThrough(from: Point, to: Point, box: Box): [number, number] | undefined {
  let enter = 0;
  let exit = 1;
  const clip = (direction: number, room: number): boolean => {
    if (direction === 0) return room > 0;
    const t = room / direction;
    if (direction < 0) enter = Math.max(enter, t);
    else exit = Math.min(exit, t);
    return true;
  };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const inside =
    clip(-dx, from.x - box.x) &&
    clip(dx, box.x + box.width - from.x) &&
    clip(-dy, from.y - box.y) &&
    clip(dy, box.y + box.height - from.y) &&
    enter < exit;
  return inside ? [enter, exit] : undefined;
}

function overlapsWithin(items: Named[]): string[] {
  return items.flatMap((item, index) => overlapsAcross([item], items.slice(index + 1)));
}

function overlapsAcross(left: Named[], right: Named[]): string[] {
  return left.flatMap((item) =>
    right.filter((other) => overlaps(item.box, other.box)).map((other) => `${boxAt(item)} overlaps ${boxAt(other)}`),
  );
}

function crossings(arrow: Arrow, label: Named): string[] {
  const found: string[] = [];
  for (let i = 1; i < arrow.points.length; i++) {
    const from = arrow.points[i - 1]!;
    const to = arrow.points[i]!;
    if (crosses(from, to, label.box)) found.push(`${arrow.name} segment ${pointAt(from)}-${pointAt(to)} crosses ${boxAt(label)}`);
  }
  return found;
}

function boxAt(item: Named): string {
  return `${item.name} ${round(item.box.x)},${round(item.box.y)} ${round(item.box.width)}x${round(item.box.height)}`;
}

function pointAt(point: Point): string {
  return `(${round(point.x)},${round(point.y)})`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
