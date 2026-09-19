import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIdSource, edgeKey, hashSpec } from "./ids.js";
import { sketch } from "./pipeline.js";
import { estimateMeasurer } from "./render/estimate.js";
import { parseSpec } from "./spec.js";
import type { Box, Point, Renderer } from "./types.js";

type Invariant =
  | "nodesApart"
  | "nodesNested"
  | "labelsClearNodes"
  | "labelsClearLabels"
  | "arrowsClearGroupLabels"
  | "insideBounds";

const TITLES: Record<Invariant, string> = {
  nodesApart: "no two node boxes overlap",
  nodesNested: "every node sits inside its group and every group inside its parent",
  labelsClearNodes: "no edge label overlaps a node box",
  labelsClearLabels: "no two edge labels overlap",
  arrowsClearGroupLabels: "no arrow segment crosses a group label",
  insideBounds: "every box but the title starts inside the layout bounds",
};

// Layout defects the pipeline still has. Fixing one makes its it.fails pass, which fails the suite
// until the entry is deleted, so this table can never drift ahead of the code.
const KNOWN: Record<string, Partial<Record<Invariant, string>>> = {
  "stress/dense-tb.json": {
    arrowsClearGroupLabels: 'the arrows into "redis" enter the data group from above, through its label',
  },
  "stress/nogroupnodes.json": {
    arrowsClearGroupLabels: "an arrow entering the leftmost child of a group from above passes through the group label",
  },
};

const root = fileURLToPath(new URL("..", import.meta.url));

const specFiles = ["examples", "stress"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${dir}/${name}`),
);

const renderer: Renderer = {
  measurer: estimateMeasurer,
  svg: async () => "",
  png: async () => new Uint8Array(),
  close: async () => {},
};

interface Named {
  name: string;
  box: Box;
}

interface Arrow {
  name: string;
  points: Point[];
}

interface Scene {
  nodes: Named[];
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

async function sceneOf(file: string): Promise<Scene> {
  const input: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
  const spec = parseSpec(input);
  const ids = createIdSource(hashSpec(spec));
  const elements = JSON.parse((await sketch(input, renderer)).excalidraw).elements as SceneElement[];
  const byId = new Map(elements.map((element) => [element.id, element]));
  const element = (key: string): SceneElement => {
    const found = byId.get(ids.id(key));
    if (!found) throw new Error(`${file} has no element for ${key}`);
    return found;
  };
  const named = (name: string, key: string): Named => ({ name, box: element(key) });
  const group = (id: string): Named => named(`group ${id}`, `group:${id}`);

  const nodes = spec.nodes.map((node) => named(`node ${node.id}`, `node:${node.id}`));
  const nodeLabels = spec.nodes.map((node) => named(`node ${node.id} label`, `node:${node.id}:label`));
  const groups = spec.groups.map(({ id }) => group(id));
  const groupLabels = spec.groups.map(({ id }) => named(`group ${id} label`, `group:${id}:label`));
  const edgeLabels = spec.edges.flatMap((edge, index) =>
    edge.label === undefined ? [] : [named(`edge ${index} label "${edge.label}"`, `${edgeKey(index)}:label`)],
  );
  const arrows = spec.edges.map((edge, index) => {
    const { x, y, points = [] } = element(edgeKey(index));
    return { name: `edge ${index} ${edge.from}->${edge.to}`, points: points.map(([dx, dy]) => ({ x: x + dx, y: y + dy })) };
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

for (const file of specFiles) {
  describe(`geometry of ${file}`, () => {
    const scene = sceneOf(file);
    const check = (invariant: Invariant, violations: (scene: Scene) => string[]): void => {
      const body = async () => {
        expect(violations(await scene)).toEqual([]);
      };
      const reason = KNOWN[file]?.[invariant];
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
    check("insideBounds", (scene) =>
      scene.bounded.filter(({ box }) => box.x < 0 || box.y < 0).map((item) => `${boxAt(item)} starts left of x=0 or above y=0`),
    );
  });
}
