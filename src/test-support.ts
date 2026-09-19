import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIdSource, edgeKey, hashSpec } from "./ids.js";
import { ARROWHEAD_ROOM, END_SPACING, LOOP_LABEL_RUN, borderSide } from "./layout.js";
import { sketch } from "./pipeline.js";
import { parseSpec } from "./spec.js";
import { arrowheads } from "./style.js";
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
  | "loopLabelRun"
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
  loopLabelRun: `a self loop's outer segment runs ${LOOP_LABEL_RUN}px past its label at both ends`,
  insideBounds: "every box but the title starts inside the layout bounds",
};

// ELK rounds its coordinates, so a distance counts as met when it misses by less than half a pixel.
const SLACK = 0.5;

interface Named {
  name: string;
  box: Box;
}

interface NamedNode extends Named {
  id: string;
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
  points?: [number, number][];
}

/** Registers the nine layout invariants for every committed spec, measured however the caller measures. */
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
      check("loopLabelRun", (scene) => scene.arrows.flatMap(buriedLoopSegment));
      check("insideBounds", (scene) =>
        scene.bounded.filter(({ box }) => box.x < 0 || box.y < 0).map((item) => `${boxAt(item)} starts left of x=0 or above y=0`),
      );
    });
  }
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

  const nodes = spec.nodes.map((node) => ({ id: node.id, ...named(`node ${node.id}`, `node:${node.id}`) }));
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
  const place = (id: string, point: Point, name: string): void => {
    const node = scene.nodes.find((candidate) => candidate.id === id);
    const side = node && borderSide(node.box, point);
    if (!node || !side) return;
    const key = `${node.name} ${side}`;
    const along = side === "left" || side === "right" ? point.y : point.x;
    sides.set(key, [...(sides.get(key) ?? []), { at: along, name }]);
  };
  for (const arrow of scene.arrows) {
    place(arrow.from, arrow.points[0]!, arrow.name);
    place(arrow.to, arrow.points.at(-1)!, arrow.name);
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

function nearestSegment(points: Point[], target: Point): [Point, Point] {
  let best: { distance: number; segment: [Point, Point] } = { distance: Infinity, segment: [points[0]!, points[1]!] };
  for (let i = 1; i < points.length; i++) {
    const segment: [Point, Point] = [points[i - 1]!, points[i]!];
    const distance = distanceToSegment(target, ...segment);
    if (distance < best.distance) best = { distance, segment };
  }
  return best.segment;
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
  return (
    clip(-dx, from.x - box.x) &&
    clip(dx, box.x + box.width - from.x) &&
    clip(-dy, from.y - box.y) &&
    clip(dy, box.y + box.height - from.y) &&
    enter < exit
  );
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
