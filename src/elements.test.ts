import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "excalidraw-types/element/src/types";
import { describe, expect, it } from "vitest";
import { EXCALIX_EPOCH, buildElements, toDocument } from "./elements.js";
import { estimateMeasurer } from "./render/estimate.js";
import { FONT, nodeSize } from "./style.js";
import type { LayoutResult, Measured, Point, Spec } from "./types.js";

const spec: Spec = {
  title: "order pipeline",
  direction: "lr",
  groups: [
    { id: "aws", label: "AWS" },
    { id: "k8s", label: "EKS", parent: "aws" },
  ],
  nodes: [
    { id: "web", label: "Web app", kind: "client" },
    { id: "api", label: "Order API", kind: "service", group: "k8s" },
    { id: "worker", label: "Worker", kind: "service", group: "k8s" },
    { id: "pg", label: "Postgres", kind: "datastore", group: "aws" },
  ],
  edges: [
    { from: "web", to: "api", label: "POST /orders", style: "async", arrows: "forward" },
    { from: "api", to: "worker", style: "sync", arrows: "both" },
    { from: "worker", to: "pg", style: "sync", arrows: "forward" },
    { from: "api", to: "api", style: "sync", arrows: "forward" },
  ],
};

async function measure(source: Spec): Promise<Measured> {
  const one = async (text: string, fontSize: number) => (await estimateMeasurer.measure([text], fontSize))[0]!;
  const measured: Measured = { nodeLabels: {}, groupLabels: {}, edgeLabels: {} };
  for (const node of source.nodes) measured.nodeLabels[node.id] = await one(node.label, FONT.node);
  for (const group of source.groups) measured.groupLabels[group.id] = await one(group.label, FONT.group);
  for (const [index, edge] of source.edges.entries()) {
    if (edge.label) measured.edgeLabels[`edge:${index}`] = await one(edge.label, FONT.edge);
  }
  if (source.title) measured.title = await one(source.title, FONT.title);
  return measured;
}

const measured = await measure(spec);
const size = (id: string) => nodeSize(spec.nodes.find((n) => n.id === id)!.kind, measured.nodeLabels[id]!);

const layout: LayoutResult = {
  nodes: {
    web: { x: 0, y: 150, ...size("web") },
    api: { x: 295, y: 104, ...size("api") },
    worker: { x: 515, y: 104, ...size("worker") },
    pg: { x: 295, y: 300, ...size("pg") },
  },
  groups: {
    aws: { x: 231, y: 0, width: 600, height: 420 },
    k8s: { x: 263, y: 52, width: 480, height: 180 },
  },
  edges: {
    "edge:0": {
      points: [
        { x: 167, y: 184 },
        { x: 231, y: 184 },
        { x: 231, y: 132.5 },
        { x: 295, y: 132.5 },
      ],
      label: { x: 205.4, y: 110 },
    },
    "edge:1": {
      points: [
        { x: 451, y: 132.5 },
        { x: 515, y: 132.5 },
      ],
    },
    "edge:2": {
      points: [
        { x: 575, y: 161 },
        { x: 575, y: 230 },
        { x: 367, y: 230 },
        { x: 367, y: 300 },
      ],
    },
    "edge:3": {
      points: [
        { x: 451, y: 120 },
        { x: 471, y: 120 },
        { x: 471, y: 90 },
        { x: 400, y: 90 },
        { x: 400, y: 104 },
      ],
    },
  },
  bounds: { x: 0, y: 0, width: 831, height: 420 },
};

const BASE_KEYS = [
  "angle", "backgroundColor", "boundElements", "created", "fillStyle", "frameId", "groupIds", "height", "id",
  "index", "isDeleted", "link", "locked", "opacity", "roughness", "roundness", "seed", "strokeColor",
  "strokeStyle", "strokeWidth", "type", "updated", "version", "versionNonce", "width", "x", "y",
];
const TEXT_KEYS = [
  "autoResize", "baseFontSize", "containerId", "fontFamily", "fontSize", "labelPosition", "lineHeight",
  "originalText", "text", "textAlign", "verticalAlign",
];
const ARROW_KEYS = ["elbowed", "endArrowhead", "endBinding", "points", "startArrowhead", "startBinding"];

const elements = buildElements(spec, layout, measured);
const byId = new Map(elements.map((element) => [element.id, element]));
const isText = (e: ExcalidrawElement): e is ExcalidrawTextElement => e.type === "text";
const isArrow = (e: ExcalidrawElement): e is ExcalidrawArrowElement => e.type === "arrow";
const texts = elements.filter(isText);
const arrows = elements.filter(isArrow);
const textOf = (text: string) => texts.find((t) => t.text === text)!;
const shapeOf = (label: string) => byId.get(textOf(label).containerId!)!;
const arrowAt = (index: number) => arrows[index]!;

describe("buildElements", () => {
  it("carries exactly the documented keys per type", () => {
    for (const element of elements) {
      const extra = element.type === "text" ? TEXT_KEYS : element.type === "arrow" ? ARROW_KEYS : [];
      expect(Object.keys(element).sort(), `${element.type} ${element.id}`).toEqual([...BASE_KEYS, ...extra].sort());
    }
  });

  it("fills the base with the contract's constants", () => {
    for (const element of elements) {
      expect(element).toMatchObject({
        angle: 0, opacity: 100, version: 1, index: null, isDeleted: false, frameId: null,
        updated: EXCALIX_EPOCH, created: null, link: null, locked: false,
      });
      expect(element.id).toMatch(/^[0-9A-Za-z]{20}$/);
      expect(element.seed).toBeGreaterThanOrEqual(0);
      expect(element.seed).toBeLessThan(2 ** 31);
      expect(element.versionNonce).not.toBe(element.seed);
    }
  });

  it("only references existing element ids", () => {
    for (const element of elements) {
      for (const bound of element.boundElements ?? []) expect(byId.has(bound.id), bound.id).toBe(true);
      if (isText(element) && element.containerId) expect(byId.has(element.containerId)).toBe(true);
      if (isArrow(element)) {
        expect(byId.has(element.startBinding!.elementId)).toBe(true);
        expect(byId.has(element.endBinding!.elementId)).toBe(true);
      }
    }
  });

  it("keeps group ids out of the element id space and nests them deepest first", () => {
    const awsRect = elements[0]!;
    const k8sRect = elements[2]!;
    const [awsGroup] = awsRect.groupIds;
    const [k8sGroup] = k8sRect.groupIds;
    expect(awsRect.groupIds).toEqual([awsGroup]);
    expect(textOf("AWS").groupIds).toEqual([awsGroup]);
    expect(k8sRect.groupIds).toEqual([k8sGroup, awsGroup]);
    expect(textOf("EKS").groupIds).toEqual([k8sGroup, awsGroup]);
    expect(shapeOf("Order API").groupIds).toEqual([k8sGroup, awsGroup]);
    expect(textOf("Order API").groupIds).toEqual([k8sGroup, awsGroup]);
    expect(shapeOf("Postgres").groupIds).toEqual([awsGroup]);
    expect(shapeOf("Web app").groupIds).toEqual([]);
    for (const arrow of arrows) expect(arrow.groupIds).toEqual([]);
    for (const groupId of [awsGroup, k8sGroup]) expect(byId.has(groupId!)).toBe(false);
  });

  it("binds labels and containers both ways", () => {
    for (const text of texts.filter((t) => t.containerId)) {
      expect(byId.get(text.containerId!)!.boundElements).toContainEqual({ type: "text", id: text.id });
    }
    for (const element of elements) {
      for (const bound of (element.boundElements ?? []).filter((b) => b.type === "text")) {
        expect((byId.get(bound.id) as ExcalidrawTextElement).containerId).toBe(element.id);
      }
    }
  });

  it("lists every arrow in both bound shapes, once for a self edge", () => {
    for (const arrow of arrows) {
      const bound = { type: "arrow", id: arrow.id };
      expect(byId.get(arrow.startBinding!.elementId)!.boundElements).toContainEqual(bound);
      expect(byId.get(arrow.endBinding!.elementId)!.boundElements).toContainEqual(bound);
    }
    const self = arrowAt(3);
    const api = shapeOf("Order API");
    expect(self.startBinding!.elementId).toBe(api.id);
    expect(self.endBinding!.elementId).toBe(api.id);
    expect(api.boundElements!.filter((b) => b.id === self.id)).toHaveLength(1);
  });

  it("centres node labels in their container with the measured size", () => {
    for (const node of spec.nodes) {
      const text = textOf(node.label);
      const box = layout.nodes[node.id]!;
      const measure = measured.nodeLabels[node.id]!;
      expect(text.originalText).toBe(text.text);
      expect(text.width).toBe(measure.width);
      expect(text.height).toBe(measure.height);
      expect(text.x + text.width / 2).toBeCloseTo(box.x + box.width / 2);
      expect(text.y + text.height / 2).toBeCloseTo(box.y + box.height / 2);
      expect(text).toMatchObject({
        textAlign: "center", verticalAlign: "middle", autoResize: true, baseFontSize: null,
        lineHeight: FONT.lineHeight, fontSize: FONT.node, fontFamily: FONT.family, labelPosition: null,
      });
    }
  });

  it("styles shapes per kind", () => {
    expect(shapeOf("Web app")).toMatchObject({ type: "ellipse", backgroundColor: "#e9ecef", roundness: null });
    expect(shapeOf("Order API")).toMatchObject({ type: "rectangle", backgroundColor: "#a5d8ff", roundness: { type: 3 } });
    expect(shapeOf("Postgres")).toMatchObject({ type: "rectangle", backgroundColor: "#b2f2bb", roundness: null, fillStyle: "solid" });
    expect(elements[0]).toMatchObject({ type: "rectangle", strokeStyle: "dashed", strokeWidth: 1, backgroundColor: "#f8f9fa" });
    expect(textOf("AWS")).toMatchObject({ x: 231 + 16, y: 16, strokeColor: "#495057", fontSize: FONT.group, containerId: null });
  });

  it("anchors arrows at the first layout point with relative points", () => {
    spec.edges.forEach((_, index) => {
      const arrow = arrowAt(index);
      const points = layout.edges[`edge:${index}`]!.points;
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const lastRelative = arrow.points[arrow.points.length - 1]!;
      expect(arrow.points[0]).toEqual([0, 0]);
      expect(arrow.points).toHaveLength(points.length);
      expect([arrow.x, arrow.y]).toEqual([first.x, first.y]);
      expect([arrow.x + lastRelative[0], arrow.y + lastRelative[1]]).toEqual([last.x, last.y]);
      expect(arrow).toMatchObject({ elbowed: false, roundness: null, strokeWidth: 2 });
    });
    expect(arrowAt(0).width).toBe(295 - 167);
    expect(arrowAt(0).height).toBe(184 - 132.5);
  });

  it("stores inside-mode fixed points normalised to the bound box, nudging exact halves", () => {
    expect(arrowAt(0).startBinding).toEqual({ elementId: shapeOf("Web app").id, fixedPoint: [1, 0.5001], mode: "inside" });
    expect(arrowAt(0).endBinding).toEqual({ elementId: shapeOf("Order API").id, fixedPoint: [0, 0.5001], mode: "inside" });
    expect(arrowAt(2).startBinding!.fixedPoint).toEqual([0.5001, 1]);
    expect(arrowAt(2).endBinding!.fixedPoint).toEqual([0.5001, 0]);
    const [fx, fy] = arrowAt(3).startBinding!.fixedPoint;
    expect(fx).toBe(1);
    expect(fy).toBeCloseTo((120 - 104) / size("api").height);
  });

  it("applies edge style and arrowheads", () => {
    expect(arrowAt(0)).toMatchObject({ strokeStyle: "dashed", startArrowhead: null, endArrowhead: "arrow" });
    expect(arrowAt(1)).toMatchObject({ strokeStyle: "solid", startArrowhead: "arrow", endArrowhead: "arrow" });
    expect(arrowAt(2)).toMatchObject({ startArrowhead: null, endArrowhead: "arrow" });
  });

  it("places the edge label on the arrow path at its labelPosition", () => {
    const arrow = arrowAt(0);
    const label = textOf("POST /orders");
    const t = label.labelPosition!;
    const onPath = pointAt(layout.edges["edge:0"]!.points, t);
    expect(label.containerId).toBe(arrow.id);
    expect(arrow.boundElements).toEqual([{ type: "text", id: label.id }]);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
    expect(label.x + label.width / 2).toBeCloseTo(onPath.x, 6);
    expect(label.y + label.height / 2).toBeCloseTo(onPath.y, 6);
    expect(onPath).toEqual({ x: 263, y: 132.5 });
    expect(label).toMatchObject({ fontSize: FONT.edge, textAlign: "center", verticalAlign: "middle", groupIds: [] });
    expect(label.width).toBe(measured.edgeLabels["edge:0"]!.width);
    for (const other of [1, 2, 3]) expect(arrowAt(other).boundElements).toEqual([]);
  });

  it("puts the title above the bounds with the gap", () => {
    const title = textOf("order pipeline");
    expect(title).toMatchObject({ x: 0, y: -32 - measured.title!.height, fontSize: FONT.title, containerId: null, groupIds: [] });
    expect(elements[elements.length - 1]).toBe(title);
  });

  it("orders groups outermost first, then nodes, arrows, title", () => {
    expect(elements.map((e) => (isText(e) ? `text:${e.text}` : e.type))).toEqual([
      "rectangle", "text:AWS", "rectangle", "text:EKS",
      "ellipse", "text:Web app", "rectangle", "text:Order API", "rectangle", "text:Worker", "rectangle", "text:Postgres",
      "arrow", "text:POST /orders", "arrow", "arrow", "arrow",
      "text:order pipeline",
    ]);
  });

  it("is deterministic and reseeds everything when the spec changes", () => {
    expect(buildElements(spec, layout, measured)).toEqual(elements);
    const retitled = buildElements({ ...spec, title: "other" }, layout, measured);
    const ids = new Set(elements.map((e) => e.id));
    for (const element of retitled) expect(ids.has(element.id)).toBe(false);
  });

  it("skips the title when the spec has none", () => {
    const untitled = buildElements({ ...spec, title: undefined }, layout, { ...measured, title: undefined });
    expect(untitled).toHaveLength(elements.length - 1);
    expect(untitled.some((e) => isText(e) && e.text === "order pipeline")).toBe(false);
  });
});

describe("toDocument", () => {
  it("wraps elements in the documented envelope", () => {
    const parsed = JSON.parse(toDocument(elements));
    expect(parsed).toMatchObject({
      type: "excalidraw", version: 2, source: "excalix",
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 }, files: {},
    });
    expect(parsed.elements).toEqual(JSON.parse(JSON.stringify(elements)));
    expect(toDocument(elements)).toBe(toDocument(buildElements(spec, layout, measured)));
  });
});

function pointAt(points: Point[], t: number): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let remaining = t * lengths.reduce((a, b) => a + b, 0);
  for (const [i, length] of lengths.entries()) {
    if (remaining <= length) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const s = length === 0 ? 0 : remaining / length;
      return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
    }
    remaining -= length;
  }
  return points[points.length - 1]!;
}
