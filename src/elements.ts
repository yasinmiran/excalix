import type {
  BoundElement,
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawEllipseElement,
  ExcalidrawRectangleElement,
  ExcalidrawTextElement,
  FixedPoint,
} from "excalidraw-types/element/src/types";
import type { LocalPoint, Radians } from "excalidraw-types/math/src/types";
import { createIdSource, edgeKey, hashSpec, type IdSource } from "./ids.js";
import { EDGE, EDGE_STYLES, FONT, GROUP_STYLE, NODE, NODE_STYLES, STROKE, TITLE_GAP, arrowheads } from "./style.js";
import type { Box, EdgeSpec, GroupSpec, LayoutResult, Measured, NodeSpec, Point, Spec, TextSize } from "./types.js";

export const EXCALIX_EPOCH = 1_700_000_000_000;

const ADAPTIVE_RADIUS = 3;
const TRANSPARENT = "transparent";

type ElementBase = Omit<ExcalidrawRectangleElement, "type">;
type ShapeElement = ExcalidrawRectangleElement | ExcalidrawEllipseElement;

/**
 * Excalidraw's branded numerics. Only the declarations of the packages that own their
 * constructors are vendored, so the brand is asserted here and nowhere else.
 */
export const radians = (value: number) => value as Radians;
export const localPoint = (x: number, y: number) => [x, y] as LocalPoint;
export const lineHeight = (value: number) => value as ExcalidrawTextElement["lineHeight"];

interface Stroke {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: ExcalidrawElement["fillStyle"];
  strokeWidth: number;
  strokeStyle: ExcalidrawElement["strokeStyle"];
  roughness: number;
  roundness: ExcalidrawElement["roundness"];
}

interface TextOptions {
  key: string;
  text: string;
  fontSize: number;
  color: string;
  position: Point;
  size: TextSize;
  groupIds: string[];
  containerId?: string;
  labelPosition?: number;
  align?: { textAlign: "left" | "center"; verticalAlign: "top" | "middle" };
}

const TEXT_STROKE: Omit<Stroke, "strokeColor"> = {
  backgroundColor: TRANSPARENT,
  fillStyle: "solid",
  strokeWidth: NODE.strokeWidth,
  strokeStyle: "solid",
  roughness: NODE.roughness,
  roundness: null,
};

/** Turns a laid-out spec into Excalidraw elements. Pure and deterministic. */
export function buildElements(spec: Spec, layout: LayoutResult, measured: Measured): ExcalidrawElement[] {
  const ids = createIdSource(hashSpec(spec));
  const parents = new Map(spec.groups.map((group) => [group.id, group.parent]));
  const groupChains = groupChainsOf(spec.groups, parents, ids);
  const chainOf = (group: string | undefined) => (group === undefined ? [] : (groupChains.get(group) ?? []));
  const nodeIds = new Map(spec.nodes.map((node) => [node.id, ids.id(`node:${node.id}`)]));
  const arrowsByNode = new Map<string, BoundElement[]>();
  spec.edges.forEach((edge, index) => {
    const bound: BoundElement = { type: "arrow", id: ids.id(edgeKey(index)) };
    for (const nodeId of new Set([edge.from, edge.to])) {
      const arrows = arrowsByNode.get(nodeId);
      if (arrows) arrows.push(bound);
      else arrowsByNode.set(nodeId, [bound]);
    }
  });

  // Excalidraw needs the members of a group contiguous in the array, so each group emits its own block:
  // rect, label, direct nodes, then nested groups.
  const nodesIn = groupBy(spec.nodes, (node) => node.group);
  const groupsIn = groupBy(spec.groups, (group) => group.parent);
  const elements: ExcalidrawElement[] = [];
  const pushNode = (node: NodeSpec) =>
    elements.push(
      ...nodeElements(node, ids, box(layout.nodes, node.id), measured.nodeLabels[node.id], chainOf(node.group), arrowsByNode.get(node.id) ?? []),
    );
  const pushGroup = (group: GroupSpec): void => {
    elements.push(...groupElements(group, ids, box(layout.groups, group.id), measured.groupLabels[group.id], chainOf(group.id)));
    for (const node of nodesIn.get(group.id) ?? []) pushNode(node);
    for (const child of groupsIn.get(group.id) ?? []) pushGroup(child);
  };
  for (const root of groupsIn.get(undefined) ?? []) pushGroup(root);
  for (const node of nodesIn.get(undefined) ?? []) pushNode(node);
  spec.edges.forEach((edge, index) => {
    const routed = layout.edges[edgeKey(index)];
    if (!routed) throw new Error(`layout has no route for ${edgeKey(index)}`);
    elements.push(...edgeElements(edge, index, ids, routed, measured.edgeLabels[edgeKey(index)], nodeIds, layout.nodes));
  });
  if (spec.title !== undefined && measured.title) {
    elements.push(
      textElement(ids, {
        key: "title",
        text: spec.title,
        fontSize: FONT.title,
        color: STROKE,
        position: { x: layout.bounds.x, y: layout.bounds.y - TITLE_GAP - measured.title.height },
        size: measured.title,
        groupIds: [],
      }),
    );
  }
  return elements;
}

/** Wraps elements in a .excalidraw document. */
export function toDocument(elements: ExcalidrawElement[]): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "excalix",
      elements,
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
      files: {},
    },
    null,
    2,
  );
}

function groupElements(group: GroupSpec, ids: IdSource, box: Box, label: TextSize | undefined, groupIds: string[]): ExcalidrawElement[] {
  const key = `group:${group.id}`;
  const rect: ExcalidrawRectangleElement = {
    ...base(ids, key, box, groupIds, {
      strokeColor: GROUP_STYLE.stroke,
      backgroundColor: GROUP_STYLE.fill,
      fillStyle: "solid",
      strokeWidth: GROUP_STYLE.strokeWidth,
      strokeStyle: GROUP_STYLE.strokeStyle,
      roughness: NODE.roughness,
      roundness: null,
    }),
    type: "rectangle",
  };
  return [
    rect,
    textElement(ids, {
      key: `${key}:label`,
      text: group.label,
      fontSize: FONT.group,
      color: GROUP_STYLE.labelColor,
      position: { x: box.x + GROUP_STYLE.padding, y: box.y + GROUP_STYLE.padding },
      size: label ?? { width: 0, height: 0 },
      groupIds,
    }),
  ];
}

function nodeElements(
  node: NodeSpec,
  ids: IdSource,
  box: Box,
  label: TextSize | undefined,
  groupIds: string[],
  arrows: BoundElement[],
): ExcalidrawElement[] {
  const key = `node:${node.id}`;
  const style = NODE_STYLES[node.kind];
  const size = label ?? { width: 0, height: 0 };
  const labelId = ids.id(`${key}:label`);
  const shape: ShapeElement = {
    ...base(ids, key, box, groupIds, {
      strokeColor: style.stroke,
      backgroundColor: style.fill,
      fillStyle: style.fillStyle,
      strokeWidth: NODE.strokeWidth,
      strokeStyle: style.strokeStyle,
      roughness: NODE.roughness,
      roundness: style.rounded ? { type: ADAPTIVE_RADIUS } : null,
    }),
    type: style.shape,
    boundElements: [{ type: "text", id: labelId }, ...arrows],
  };
  return [
    shape,
    textElement(ids, {
      key: `${key}:label`,
      text: node.label,
      fontSize: FONT.node,
      color: STROKE,
      position: { x: box.x + (box.width - size.width) / 2, y: box.y + (box.height - size.height) / 2 },
      size,
      groupIds,
      containerId: shape.id,
      align: { textAlign: "center", verticalAlign: "middle" },
    }),
  ];
}

function edgeElements(
  edge: EdgeSpec,
  index: number,
  ids: IdSource,
  routed: LayoutResult["edges"][string],
  label: TextSize | undefined,
  nodeIds: Map<string, string>,
  nodeBoxes: LayoutResult["nodes"],
): ExcalidrawElement[] {
  const key = edgeKey(index);
  const points = routed.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) throw new Error(`${key} needs at least two points`);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const heads = arrowheads(edge.arrows);
  const labelId = edge.label === undefined ? undefined : ids.id(`${key}:label`);
  const arrow: ExcalidrawArrowElement = {
    ...base(
      ids,
      key,
      { x: first.x, y: first.y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      [],
      {
        strokeColor: STROKE,
        backgroundColor: TRANSPARENT,
        fillStyle: "solid",
        strokeWidth: EDGE.strokeWidth,
        strokeStyle: EDGE_STYLES[edge.style].strokeStyle,
        roughness: EDGE.roughness,
        roundness: null,
      },
    ),
    type: "arrow",
    boundElements: labelId ? [{ type: "text", id: labelId }] : [],
    points: points.map((p) => localPoint(p.x - first.x, p.y - first.y)),
    startBinding: { elementId: nodeId(nodeIds, edge.from), fixedPoint: fixedPoint(box(nodeBoxes, edge.from), first), mode: "inside" },
    endBinding: { elementId: nodeId(nodeIds, edge.to), fixedPoint: fixedPoint(box(nodeBoxes, edge.to), last), mode: "inside" },
    startArrowhead: heads.start,
    endArrowhead: heads.end,
    elbowed: false,
  };
  if (edge.label === undefined) return [arrow];
  if (!label || !routed.label) throw new Error(`${key} has a label but no measure or label point`);
  const center = { x: routed.label.x + label.width / 2, y: routed.label.y + label.height / 2 };
  const { t, point } = nearestOnPolyline(points, center);
  return [
    arrow,
    textElement(ids, {
      key: `${key}:label`,
      text: edge.label,
      fontSize: FONT.edge,
      color: STROKE,
      position: { x: point.x - label.width / 2, y: point.y - label.height / 2 },
      size: label,
      groupIds: [],
      containerId: arrow.id,
      labelPosition: t,
      align: { textAlign: "center", verticalAlign: "middle" },
    }),
  ];
}

function textElement(ids: IdSource, options: TextOptions): ExcalidrawTextElement {
  const { textAlign, verticalAlign } = options.align ?? { textAlign: "left", verticalAlign: "top" };
  return {
    ...base(ids, options.key, { ...options.position, ...options.size }, options.groupIds, { strokeColor: options.color, ...TEXT_STROKE }),
    type: "text",
    fontSize: options.fontSize,
    fontFamily: FONT.family,
    baseFontSize: null,
    text: options.text,
    textAlign,
    verticalAlign,
    containerId: options.containerId ?? null,
    originalText: options.text,
    autoResize: true,
    lineHeight: lineHeight(FONT.lineHeight),
    labelPosition: options.labelPosition ?? null,
  };
}

function base(ids: IdSource, key: string, box: Box, groupIds: string[], stroke: Stroke): ElementBase {
  return {
    id: ids.id(key),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    angle: radians(0),
    ...stroke,
    opacity: 100,
    seed: ids.seed(key),
    version: 1,
    versionNonce: ids.seed(`${key}:nonce`),
    index: null,
    isDeleted: false,
    groupIds,
    frameId: null,
    boundElements: [],
    updated: EXCALIX_EPOCH,
    created: null,
    link: null,
    locked: false,
  };
}

/** Excalidraw group id chains per group, own id first then ancestors. */
function groupChainsOf(groups: GroupSpec[], parents: Map<string, string | undefined>, ids: IdSource): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  for (const group of groups) {
    const chain: string[] = [];
    for (let current: string | undefined = group.id; current !== undefined; current = parents.get(current)) {
      chain.push(ids.id(`group:${current}:groupId`));
    }
    chains.set(group.id, chain);
  }
  return chains;
}

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const buckets = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return buckets;
}

// Excalidraw's normalizeFixedPoint nudges a coordinate within 1e-4 of 0.5 to 0.5001 on restore;
// storing the nudged value keeps a reload byte-identical.
function fixedPoint(box: Box, point: Point): FixedPoint {
  const nudge = (v: number) => (Math.abs(v - 0.5) < 1e-4 ? 0.5001 : v);
  return [nudge((point.x - box.x) / box.width), nudge((point.y - box.y) / box.height)];
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

function box(boxes: Record<string, Box>, id: string): Box {
  const found = boxes[id];
  if (!found) throw new Error(`layout has no box for ${id}`);
  return found;
}

function nodeId(nodeIds: Map<string, string>, id: string): string {
  const found = nodeIds.get(id);
  if (!found) throw new Error(`unknown node ${id}`);
  return found;
}
