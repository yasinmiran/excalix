import { describe, expect, it } from "vitest";
import {
  ARROWHEAD_ROOM,
  END_SPACING,
  LABEL_HEAD_RUN,
  LABEL_MARGIN,
  LOOP_LABEL_RUN,
  type Route,
  type Shaped,
  layout,
  placeGroupLabel,
  tidyRoutes,
} from "./layout.js";
import { ARROWHEAD_LENGTH, FONT, LABEL_MASK, nodeSize, outlineOf } from "./style.js";
import type { Box, Kind, LayoutInput, LayoutResult, Point, RoutedEdge, RoutedLabel, TextSize } from "./types.js";

function estimate(text: string, fontSize: number): TextSize {
  return { width: text.length * fontSize * 0.6, height: fontSize * FONT.lineHeight };
}

function node(id: string, label: string, kind: Kind, group?: string) {
  return { id, outline: outlineOf(kind), ...nodeSize(kind, estimate(label, FONT.node)), ...(group ? { group } : {}) };
}

function group(id: string, label: string, parent?: string) {
  return { id, label: estimate(label, FONT.group), ...(parent ? { parent } : {}) };
}

function edge(index: number, from: string, to: string, label?: string) {
  return { id: `edge:${index}`, from, to, ...(label ? { label: estimate(label, FONT.edge) } : {}) };
}

const orderPipeline: LayoutInput = {
  direction: "lr",
  groups: [group("aws", "AWS eu-north-1"), group("k8s", "EKS", "aws")],
  nodes: [
    node("web", "Web app", "client"),
    node("api", "Order API", "service", "k8s"),
    node("worker", "Fulfilment", "service", "k8s"),
    node("q", "orders.created", "queue", "aws"),
    node("pg", "Postgres", "datastore", "aws"),
    node("redis", "Redis", "cache", "aws"),
    node("stripe", "Stripe", "external"),
  ],
  edges: [
    edge(0, "web", "api", "POST /orders"),
    edge(1, "api", "pg"),
    edge(2, "api", "redis"),
    edge(3, "api", "q"),
    edge(4, "q", "worker"),
    edge(5, "worker", "stripe", "charge"),
  ],
};

const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const within = (v: number, lo: number, hi: number) => v >= lo - 1 && v <= hi + 1;

function onBorder(p: Point, box: Box): boolean {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const onVertical = (near(p.x, box.x) || near(p.x, right)) && within(p.y, box.y, bottom);
  const onHorizontal = (near(p.y, box.y) || near(p.y, bottom)) && within(p.x, box.x, right);
  return onVertical || onHorizontal;
}

function contains(outer: Box, inner: Box, pad: { top: number; side: number }): boolean {
  return (
    inner.x >= outer.x + pad.side &&
    inner.y >= outer.y + pad.top &&
    inner.x + inner.width <= outer.x + outer.width - pad.side &&
    inner.y + inner.height <= outer.y + outer.height - pad.side
  );
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function labelBox(label: RoutedLabel, size: TextSize): Box {
  return { x: label.x, y: label.y, ...size };
}

function centreOf(label: RoutedLabel, size: TextSize): Point {
  return { x: label.x + size.width / 2, y: label.y + size.height / 2 };
}

function grow(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, width: box.width + by * 2, height: box.height + by * 2 };
}

function segments(points: Point[]): [Point, Point][] {
  return points.slice(1).map((p, i) => [points[i]!, p]);
}

function distanceToPolyline(points: Point[], target: Point): number {
  return Math.min(
    ...segments(points).map(([a, b]) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const square = dx * dx + dy * dy;
      const s = square === 0 ? 0 : Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / square));
      return Math.hypot(target.x - a.x - dx * s, target.y - a.y - dy * s);
    }),
  );
}

function pointAt(points: Point[], position: number): Point {
  const lengths = segments(points).map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
  let remaining = position * lengths.reduce((total, length) => total + length, 0);
  for (const [index, [a, b]] of segments(points).entries()) {
    const length = lengths[index]!;
    if (remaining <= length || index === lengths.length - 1) {
      const s = length === 0 ? 0 : remaining / length;
      return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
    }
    remaining -= length;
  }
  return points[0]!;
}

// Where the line along an arrow's last segment crosses the ellipse inscribed in box, on the side it comes from.
function ellipseCrossing(box: Box, end: Point, before: Point): number {
  const [cx, cy, rx, ry] = [box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2];
  if (end.y === before.y) return cx + Math.sign(before.x - end.x) * rx * Math.sqrt(1 - ((end.y - cy) / ry) ** 2);
  return cy + Math.sign(before.y - end.y) * ry * Math.sqrt(1 - ((end.x - cx) / rx) ** 2);
}

// Points where a run of one edge crosses a run of another, away from the ends of either.
function crossingsIn(result: LayoutResult): number {
  const runs = Object.entries(result.edges).flatMap(([id, { points }]) =>
    segments(points).map(([a, b]) => {
      const vertical = a.x === b.x;
      const [along, across] = vertical ? (["y", "x"] as const) : (["x", "y"] as const);
      return { id, vertical, at: a[across], low: Math.min(a[along], b[along]), high: Math.max(a[along], b[along]) };
    }),
  );
  const crossing = runs.flatMap((h) =>
    runs.filter((v) => v.id !== h.id && !h.vertical && v.vertical && h.low < v.at && v.at < h.high && v.low < h.at && h.at < v.high),
  );
  return crossing.length;
}

function allPoints(result: LayoutResult): Point[] {
  const boxes = [...Object.values(result.nodes), ...Object.values(result.groups)];
  return [
    ...boxes.flatMap((b) => [b, { x: b.x + b.width, y: b.y + b.height }]),
    ...Object.values(result.edges).flatMap((e) => e.points),
  ];
}

describe("layout on the order pipeline", () => {
  const run = layout(orderPipeline);

  // Box, not outline: no end in the order pipeline sits where an outline leaves its box, so none is moved.
  // endsOnOutline in test-support.ts checks the drawn outline for every spec.
  it("routes every order pipeline edge from its source box to its target box", async () => {
    const result = await run;
    for (const spec of orderPipeline.edges) {
      const { points } = result.edges[spec.id]!;
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(onBorder(points[0]!, result.nodes[spec.from]!), `${spec.id} start`).toBe(true);
      expect(onBorder(points.at(-1)!, result.nodes[spec.to]!), `${spec.id} end`).toBe(true);
    }
  });

  it("keeps polylines orthogonal, so bend points are included", async () => {
    const result = await run;
    for (const { points } of Object.values(result.edges)) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        expect(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6).toBe(true);
      }
    }
    expect(Object.values(result.edges).some((e) => e.points.length > 2)).toBe(true);
  });

  it("nests nodes and groups inside their group with padding", async () => {
    const result = await run;
    const padding = (id: string) => ({ top: orderPipeline.groups.find((g) => g.id === id)!.label.height + 16, side: 16 });
    for (const spec of orderPipeline.nodes) {
      if (!spec.group) continue;
      expect(contains(result.groups[spec.group]!, result.nodes[spec.id]!, padding(spec.group)), spec.id).toBe(true);
    }
    expect(contains(result.groups.aws!, result.groups.k8s!, padding("aws"))).toBe(true);
    expect(overlaps(result.groups.aws!, result.nodes.web!)).toBe(false);
    expect(overlaps(result.groups.aws!, result.nodes.stripe!)).toBe(false);
  });

  it("never shrinks a node below its input size, and leaves a quiet one alone", async () => {
    const result = await run;
    for (const spec of orderPipeline.nodes) {
      expect(result.nodes[spec.id]!.width, spec.id).toBeGreaterThanOrEqual(spec.width);
      expect(result.nodes[spec.id]!.height, spec.id).toBeGreaterThanOrEqual(spec.height);
    }
    const web = orderPipeline.nodes.find((n) => n.id === "web")!;
    expect(result.nodes.web).toMatchObject({ width: web.width, height: web.height });
  });

  it("places labels only on labelled edges", async () => {
    const result = await run;
    for (const spec of orderPipeline.edges) {
      const label = result.edges[spec.id]!.label;
      if (spec.label) {
        expect(label).toBeDefined();
        expect(within(label!.x, 0, result.bounds.width)).toBe(true);
        expect(within(label!.y, 0, result.bounds.height)).toBe(true);
      } else {
        expect(label).toBeUndefined();
      }
    }
  });

  it("centres every label on its polyline at the stored position", async () => {
    const result = await run;
    for (const spec of orderPipeline.edges) {
      if (!spec.label) continue;
      const routed = result.edges[spec.id]!;
      const centre = centreOf(routed.label!, spec.label);
      expect(distanceToPolyline(routed.points, centre), spec.id).toBeLessThan(1);
      expect(pointAt(routed.points, routed.label!.position).x, `${spec.id} x`).toBeCloseTo(centre.x, 6);
      expect(pointAt(routed.points, routed.label!.position).y, `${spec.id} y`).toBeCloseTo(centre.y, 6);
    }
  });

  it("keeps the clearance it reserved around every label", async () => {
    const result = await run;
    for (const spec of orderPipeline.edges) {
      if (!spec.label) continue;
      const reserved = grow(labelBox(result.edges[spec.id]!.label!, spec.label), LABEL_MARGIN);
      for (const [id, box] of Object.entries(result.nodes)) expect(overlaps(reserved, box), `${spec.id} over ${id}`).toBe(false);
    }
  });

  it("normalises bounds to (0, 0) around everything", async () => {
    const result = await run;
    const points = allPoints(result);
    expect(Math.min(...points.map((p) => p.x))).toBe(0);
    expect(Math.min(...points.map((p) => p.y))).toBe(0);
    expect(Math.max(...points.map((p) => p.x))).toBeLessThanOrEqual(result.bounds.width);
    expect(Math.max(...points.map((p) => p.y))).toBeLessThanOrEqual(result.bounds.height);
    expect(result.bounds).toMatchObject({ x: 0, y: 0 });
    for (const spec of orderPipeline.edges) {
      if (!spec.label) continue;
      const box = labelBox(result.edges[spec.id]!.label!, spec.label);
      expect(box.x, spec.id).toBeGreaterThanOrEqual(0);
      expect(box.y, spec.id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, spec.id).toBeLessThanOrEqual(result.bounds.width);
      expect(box.y + box.height, spec.id).toBeLessThanOrEqual(result.bounds.height);
    }
  });

  it("is deterministic", async () => {
    expect(await layout(orderPipeline)).toEqual(await layout(orderPipeline));
  });
});

describe("layout in whole pixels", () => {
  it("moves to the origin by whole pixels when a label on a half pixel sets the bounds", async () => {
    // In tb a self loop runs down the node's left side, and its label is centred on that run, so the label's
    // odd width puts the leftmost thing in the layout on a half pixel.
    const result = await layout({ direction: "tb", groups: [], nodes: [node("w", "Worker", "service")], edges: [edge(0, "w", "w", "abc")] });
    const label = labelBox(result.edges["edge:0"]!.label!, estimate("abc", FONT.edge));
    for (const point of allPoints(result)) {
      expect(Number.isInteger(point.x) && Number.isInteger(point.y), `${point.x},${point.y}`).toBe(true);
    }
    expect(result.bounds).toMatchObject({ x: 0, y: 0 });
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(result.bounds.width);
  });
});

describe("layout edge cases", () => {
  it("survives a self edge", async () => {
    const result = await layout({
      direction: "lr",
      groups: [],
      nodes: [node("a", "A", "service")],
      edges: [edge(0, "a", "a")],
    });
    expect(result.edges["edge:0"]!.points.length).toBeGreaterThanOrEqual(2);
  });

  it("stands a labelled self loop off its node in both directions", async () => {
    const text = "retry until it sticks";
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [group("g", "Group")],
        nodes: [node("a", "A", "service", "g"), node("b", "B", "service", "g")],
        edges: [edge(0, "a", "a", text), edge(1, "a", "b")],
      });
      const routed = result.edges["edge:0"]!;
      const size = estimate(text, FONT.edge);
      expect(distanceToPolyline(routed.points, centreOf(routed.label!, size)), direction).toBeLessThan(1);
      expect(overlaps(grow(labelBox(routed.label!, size), LABEL_MARGIN), result.nodes.a!), direction).toBe(false);
    }
  });

  it("centres labels on the path for tb and across a group border", async () => {
    const text = "crosses out";
    const result = await layout({
      direction: "tb",
      groups: [group("g", "Group")],
      nodes: [node("a", "A", "service", "g"), node("b", "B", "service")],
      edges: [edge(0, "a", "b", text)],
    });
    const routed = result.edges["edge:0"]!;
    const size = estimate(text, FONT.edge);
    expect(distanceToPolyline(routed.points, centreOf(routed.label!, size))).toBeLessThan(1);
    expect(overlaps(grow(labelBox(routed.label!, size), LABEL_MARGIN), result.nodes.a!)).toBe(false);
    expect(overlaps(grow(labelBox(routed.label!, size), LABEL_MARGIN), result.nodes.b!)).toBe(false);
  });

  it("spreads the arrows that land on one side of a node, in both directions", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [],
        nodes: [node("hub", "Hub", "service"), node("a", "A", "service"), node("b", "B", "service"), node("c", "C", "service")],
        edges: [edge(0, "a", "hub"), edge(1, "b", "hub"), edge(2, "c", "hub")],
      });
      const along = (p: Point) => (direction === "lr" ? p.y : p.x);
      const ends = ["edge:0", "edge:1", "edge:2"].map((id) => along(result.edges[id]!.points.at(-1)!)).sort((a, b) => a - b);
      expect(ends[1]! - ends[0]!, direction).toBeGreaterThanOrEqual(END_SPACING);
      expect(ends[2]! - ends[1]!, direction).toBeGreaterThanOrEqual(END_SPACING);
    }
  });

  it("breaks a loop between groups at the edges listed against reading order, in both directions", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [group("platform", "Platform"), group("svc", "Services", "platform"), group("bg", "Background", "platform")],
        nodes: [
          node("gw", "Gateway", "service", "platform"),
          node("tasks", "Tasks", "service", "svc"),
          node("reports", "Reports", "service", "svc"),
          node("notif", "Notifications", "service", "svc"),
          node("audit", "Audit log", "service", "svc"),
          node("q", "Job queue", "queue", "bg"),
          node("workers", "Workers", "service", "bg"),
        ],
        edges: [
          edge(0, "gw", "tasks"),
          edge(1, "gw", "reports"),
          edge(2, "tasks", "q"),
          edge(3, "reports", "q"),
          edge(4, "q", "workers"),
          edge(5, "workers", "notif"),
          edge(6, "workers", "audit"),
        ],
      });
      const across = (p: Point) => (direction === "lr" ? p.x : p.y);
      const extent = (b: Box) => (direction === "lr" ? b.width : b.height);
      const svc = result.groups.svc!;
      const bg = result.groups.bg!;
      expect(across(bg), direction).toBeGreaterThan(across(svc) + extent(svc));
      for (const id of ["edge:2", "edge:3"]) {
        const source = result.nodes[id === "edge:2" ? "tasks" : "reports"]!;
        const leaves = Math.min(...result.edges[id]!.points.map(across));
        expect(leaves, `${direction} ${id}`).toBeGreaterThanOrEqual(across(source) + extent(source));
      }
    }
  });

  it("ends the arrows on a crowded side of an ellipse on its curve, in both directions", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [],
        nodes: [node("a", "A", "service"), node("b", "B", "service"), node("c", "C", "service"), node("web", "Browser", "client")],
        edges: [edge(0, "a", "web"), edge(1, "b", "web"), edge(2, "c", "web")],
      });
      const web = result.nodes.web!;
      const insets = ["edge:0", "edge:1", "edge:2"].map((id) => {
        const { points } = result.edges[id]!;
        const [before, end] = [points.at(-2)!, points.at(-1)!];
        const across = direction === "lr" ? end.x : end.y;
        expect(direction === "lr" ? before.y : before.x, `${id} ${direction}`).toBe(direction === "lr" ? end.y : end.x);
        expect(Math.hypot(end.x - before.x, end.y - before.y), `${id} ${direction}`).toBeGreaterThanOrEqual(ARROWHEAD_ROOM);
        expect(Math.abs(across - ellipseCrossing(web, end, before)), `${id} ${direction}`).toBeLessThanOrEqual(0.5);
        return direction === "lr" ? end.x - web.x : end.y - web.y;
      });
      expect(Math.max(...insets), direction).toBeGreaterThan(1);
    }
  });

  it("grows a node with a labelled self loop only as far as the loop needs, in both directions", async () => {
    const text = "retries";
    const label = estimate(text, FONT.edge);
    for (const direction of ["lr", "tb"] as const) {
      const a = node("a", "stream processor", "service");
      const result = await layout({ direction, groups: [], nodes: [a], edges: [edge(0, "a", "a", text)] });
      const outer = (direction === "lr" ? label.width : label.height) + (LABEL_MARGIN + LOOP_LABEL_RUN) * 2;
      const { points } = result.edges["edge:0"]!;
      const along = (p: Point) => (direction === "lr" ? p.x : p.y);
      expect(Math.abs(along(points.at(-1)!) - along(points[0]!)), direction).toBeGreaterThanOrEqual(outer);
      if (direction === "lr") expect(result.nodes.a!.width).toBe(a.width);
      else expect(result.nodes.a!.height).toBeLessThanOrEqual(outer + 2 * END_SPACING);
    }
  });

  it("stands a self loop off its node far enough for a full arrowhead", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [],
        nodes: [node("a", "A", "service")],
        edges: [edge(0, "a", "a")],
      });
      const { points } = result.edges["edge:0"]!;
      const [last, end] = [points.at(-2)!, points.at(-1)!];
      expect(Math.hypot(end.x - last.x, end.y - last.y), direction).toBeGreaterThanOrEqual(ARROWHEAD_ROOM);
    }
  });

  it("stacks layers vertically for tb", async () => {
    const result = await layout({
      direction: "tb",
      groups: [],
      nodes: [node("a", "A", "service"), node("b", "B", "service")],
      edges: [edge(0, "a", "b")],
    });
    const { a, b } = result.nodes;
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height + ARROWHEAD_ROOM);
    const { points } = result.edges["edge:0"]!;
    expect(near(points[0]!.y, a!.y + a!.height)).toBe(true);
    expect(near(points.at(-1)!.y, b!.y)).toBe(true);
  });

  it("widens a group to fit its label in both directions", async () => {
    const wide = "a very long group label that outgrows its only child";
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [group("g", wide)],
        nodes: [node("a", "A", "service", "g")],
        edges: [],
      });
      expect(result.groups.g!.width, direction).toBeGreaterThanOrEqual(estimate(wide, FONT.group).width + 32);
    }
  });

  it("leaves a label room along its edge for the line before an arrowhead and no more, in both directions", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [],
        nodes: [node("a", "A", "service"), node("b", "B", "service")],
        edges: [edge(0, "a", "b", "writes to")],
      });
      const label = labelBox(result.edges["edge:0"]!.label!, estimate("writes to", FONT.edge));
      const [a, b] = [result.nodes.a!, result.nodes.b!];
      const gaps =
        direction === "lr" ? [label.x - (a.x + a.width), b.x - (label.x + label.width)] : [label.y - (a.y + a.height), b.y - (label.y + label.height)];
      for (const gap of gaps) expect(near(gap, LABEL_MASK + LABEL_HEAD_RUN + ARROWHEAD_LENGTH), `${direction} ${gap}`).toBe(true);
    }
  });

  it("gives the nodes of one layer the length of the longest along the flow, and leaves other layers alone", async () => {
    const tall = { id: "b", outline: "sharp" as const, width: 120, height: 81 };
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [],
        nodes: [node("hub", "Hub", "service"), node("a", "A", "service"), node("wide", "A much longer name", "service"), tall],
        edges: [edge(0, "hub", "a"), edge(1, "hub", "wide"), edge(2, "hub", "b")],
      });
      const extent = direction === "lr" ? "width" : "height";
      const layer = ["a", "wide", "b"].map((id) => result.nodes[id]![extent]);
      expect(new Set(layer).size, `${direction} ${layer}`).toBe(1);
      expect(result.nodes.hub![extent], direction).toBeLessThan(layer[0]!);
    }
  });

  it("evens a layer only among nodes some path of edges joins, in both directions", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const nodes = [
        node("a", "A", "service"),
        node("b", "B", "service"),
        { ...node("long", "A much longer name heading another chain", "service"), height: 81 },
        node("c", "C", "service"),
        { ...node("note", "Every service here also reports to the shared monitoring stack", "external"), height: 105 },
      ];
      const result = await layout({ direction, groups: [], nodes, edges: [edge(0, "a", "b"), edge(1, "long", "c")] });
      const extent = direction === "lr" ? "width" : "height";
      for (const id of ["a", "long", "note"]) {
        expect(result.nodes[id]![extent], `${direction} ${id}`).toBe(nodes.find((n) => n.id === id)![extent]);
      }
    }
  });

  it("evens a layer only among nodes of one group, in both directions", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const narrow = node("narrow", "A", "service", "left");
      const result = await layout({
        direction,
        groups: [group("left", "Left"), group("right", "Right")],
        nodes: [narrow, { ...node("wide", "A much longer name", "service", "right"), height: 81 }, node("sink", "Sink", "service")],
        edges: [edge(0, "narrow", "sink"), edge(1, "wide", "sink")],
      });
      const [start, extent] = direction === "lr" ? (["x", "width"] as const) : (["y", "height"] as const);
      const [a, b] = [result.nodes.narrow!, result.nodes.wide!];
      expect(a[start] < b[start] + b[extent] && b[start] < a[start] + a[extent], `${direction} side by side`).toBe(true);
      expect(a[extent], direction).toBe(narrow[extent]);
    }
  });

  it("searches as hard for an order without crossings inside a group as at the top", async () => {
    const pairs = [
      ["n5", "n7"],
      ["n0", "n7"],
      ["n6", "n0"],
      ["n9", "n6"],
      ["n3", "n7"],
      ["n7", "n6"],
      ["n5", "n9"],
      ["n8", "n0"],
    ];
    const graph = (inGroup: boolean): LayoutInput => ({
      direction: "lr",
      groups: inGroup ? [group("g", "Group")] : [],
      nodes: Array.from({ length: 10 }, (_, i) => node(`n${i}`, "A", "service", inGroup ? "g" : undefined)),
      edges: pairs.map(([from, to], i) => edge(i, from!, to!)),
    });
    for (const inGroup of [false, true]) expect(crossingsIn(await layout(graph(inGroup))), `in group ${inGroup}`).toBe(0);
  });

  it("gives an empty group its label size", async () => {
    const result = await layout({
      direction: "lr",
      groups: [group("g", "empty")],
      nodes: [node("a", "A", "service")],
      edges: [],
    });
    const label = estimate("empty", FONT.group);
    expect(result.groups.g).toMatchObject({ width: label.width + 32, height: label.height + 32 });
  });
});

// Routes and nodes built by hand, each a few pixels from the move a guard is there to refuse or allow.
describe("tidyRoutes", () => {
  const at = (x: number, y: number, width = 20, height = 20): Shaped => ({ box: { x, y, width, height }, outline: "sharp" });
  const route = (id: string, from: string, to: string, points: [number, number][]): Route => ({
    edge: { id, from, to },
    points: points.map(([x, y]) => ({ x, y })),
  });
  // A 40x20 label whose reserved box keeps 6px beside the text left and right, and 12px above and below.
  const labelled = (r: Route, reserved: Point): Route => ({
    ...r,
    edge: { ...r.edge, label: { width: 40, height: 20 } },
    label: { reserved, laid: { width: 52, height: 44 } },
  });
  const tidied = (routes: Route[], nodes: Record<string, Shaped>): [number, number][][] => {
    tidyRoutes(routes, new Map(Object.entries(nodes)));
    return routes.map(({ points }) => points.map(({ x, y }): [number, number] => [x, y]));
  };

  it("folds a step even where that leaves a lane a pixel under LANE_SPACING", () => {
    // Folding onto x=100 leaves the run 15px from b's lane; folding onto x=102 would leave it 14px from c's.
    const routes = [
      route("a", "a0", "a1", [[0, 0], [100, 0], [100, 50], [102, 50], [102, 100], [200, 100]]),
      route("b", "b0", "b1", [[85, 50], [85, 100]]),
      route("c", "c0", "c1", [[116, 0], [116, 50]]),
    ];
    const nodes = { a0: at(-20, -10), a1: at(200, 90), b0: at(75, 30), b1: at(75, 100), c0: at(106, -20), c1: at(106, 50) };
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [100, 0], [100, 100], [200, 100]]);
  });

  // a's last run and b's first pass 10px apart. Moving either one's channel clear of the other would leave its end run
  // under ARROWHEAD_ROOM, and b's end on s cannot slide nearer s's bottom corner, so only a's end on c can move: 6px up
  // c's side, to y=16.
  const crowdedEnds = (c: Shaped): [Route[], Record<string, Shaped>] => [
    [
      route("a", "s", "c", [[0, 0], [50, 0], [50, 22], [128, 22]]),
      route("b", "s", "d", [[0, 32], [92, 32], [92, 74], [320, 74]]),
    ],
    { s: at(-60, -20, 60, 72), c, d: at(320, 54, 40, 40) },
  ];

  it("slides a crowded run that ends its route along its node's side when no run between two bends will go", () => {
    expect(tidied(...crowdedEnds(at(128, -10, 60, 60)))).toEqual([
      [[0, 0], [50, 0], [50, 16], [128, 16]],
      [[0, 32], [92, 32], [92, 74], [320, 74]],
    ]);
  });

  it("never slides an end within END_SPACING of another end on its side", () => {
    // g ends on c's side 34px above a's end, and the slide would leave them 28px apart.
    const [routes, nodes] = crowdedEnds(at(128, -40, 60, 90));
    routes.push(route("g", "g0", "c", [[90, -12], [128, -12]]));
    nodes.g0 = at(70, -22);
    expect(tidied(routes, nodes).slice(0, 2)).toEqual([
      [[0, 0], [50, 0], [50, 22], [128, 22]],
      [[0, 32], [92, 32], [92, 74], [320, 74]],
    ]);
  });

  it("never slides a lone end onto a rounded corner's curve", () => {
    // c's corners curve for 15px, and the slide would take a's end from 20px off the top one to 14px.
    expect(tidied(...crowdedEnds({ ...at(128, 2, 60, 60), outline: "rounded" }))).toEqual([
      [[0, 0], [50, 0], [50, 22], [128, 22]],
      [[0, 32], [92, 32], [92, 74], [320, 74]],
    ]);
  });

  it("spaces two arrows that swap sides in a channel by swapping their places in it", () => {
    // a's last run and b's first pass 10px apart, and neither end can slide: a's would come within 25px of c's top
    // corner, b's of s's bottom one. a's channel moves to 16px past where b turns down instead.
    const routes = [
      route("a", "s", "c", [[0, 0], [60, 0], [60, 22], [300, 22]]),
      route("b", "s", "d", [[0, 32], [92, 32], [92, 200], [320, 200]]),
      route("e", "f", "c", [[200, 150], [250, 150], [250, 54], [300, 54]]),
    ];
    const nodes = { s: at(-60, -27, 60, 86), c: at(300, -5, 60, 86), d: at(320, 180, 40, 40), f: at(180, 140) };
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [108, 0], [108, 22], [300, 22]]);
  });

  // The same two arrows with a's label on its crowded run, then on the run that pulling a back would move: either
  // way the label would leave its box, so b is pulled back instead.
  for (const [where, reserved] of [
    ["the crowded run", { x: 154, y: 0 }],
    ["the run it would move", { x: 34, y: -11 }],
  ] as const) {
    it(`pulls back the other arrow when the label sits on ${where}`, () => {
      const routes = [
        route("a", "s", "c", [[0, 0], [60, 0], [60, 22], [300, 22]]),
        route("b", "s", "d", [[0, 32], [92, 32], [92, 200], [320, 200]]),
        route("e", "f", "c", [[200, 150], [250, 150], [250, 54], [300, 54]]),
      ];
      routes[0] = labelled(routes[0]!, reserved);
      const nodes = { s: at(-60, -27, 60, 86), c: at(300, -5, 60, 86), d: at(320, 180, 40, 40), f: at(180, 140) };
      expect(tidied(routes, nodes).slice(0, 2)).toEqual([
        [[0, 0], [60, 0], [60, 22], [300, 22]],
        [[0, 32], [44, 32], [44, 200], [320, 200]],
      ]);
    });
  }

  it("pushes a crowded run between two bends sideways before it tries pulling one back", () => {
    // a's run along y=22 lies 10px from b's first and could be spaced either way: pushed 6px up, or cut short by
    // pulling its bend at x=60 back to 16px past where b turns down.
    const routes = [
      route("a", "s", "c", [[0, 0], [60, 0], [60, 22], [240, 22], [240, 60], [300, 60]]),
      route("b", "s", "d", [[0, 32], [92, 32], [92, 200], [320, 200]]),
    ];
    const nodes = { s: at(-60, -27, 60, 86), c: at(300, 40, 60, 40), d: at(320, 180, 40, 40) };
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [60, 0], [60, 16], [240, 16], [240, 60], [300, 60]]);
  });

  // a's run between two bends lies 10px from b's straight line, and pushing it 6px away is the only way to space them.
  const crowdedByB = (b = 110): [Route[], Record<string, Shaped>] => [
    [route("a", "a0", "a1", [[0, 0], [100, 0], [100, 200], [300, 200]]), route("b", "b0", "b1", [[b, -50], [b, 150]])],
    { a0: at(-20, -10), a1: at(300, 190), b0: at(b - 10, -70), b1: at(b - 10, 150) },
  ];

  it("pushes a crowded run even where that leaves it a pixel under LANE_SPACING from another lane", () => {
    const [routes, nodes] = crowdedByB();
    routes.push(route("c", "c0", "m", [[79, -30], [79, 90]]), route("d", "m", "d1", [[79, 110], [79, 230]]));
    Object.assign(nodes, { c0: at(69, -50), m: at(69, 90), d1: at(69, 230) });
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [94, 0], [94, 200], [300, 200]]);
  });

  it("leaves two lanes 15px apart alone, as rounding a pair ELK spaced exactly can leave them", () => {
    const [routes, nodes] = crowdedByB(115);
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [100, 0], [100, 200], [300, 200]]);
  });

  it("never pushes a run across another arrow", () => {
    // b is 10px left of a's run and c 3px right of it. Pushing a's run right of c would cross both of c's horizontal
    // runs, so c moves instead.
    const [routes, nodes] = crowdedByB(90);
    routes.push(route("c", "c0", "c1", [[200, -50], [103, -50], [103, 20], [200, 20]]));
    Object.assign(nodes, { c0: at(200, -60), c1: at(200, 10) });
    expect(tidied(routes, nodes)).toEqual([
      [[0, 0], [100, 0], [100, 200], [300, 200]],
      [[90, -50], [90, 150]],
      [[200, -50], [116, -50], [116, 20], [200, 20]],
    ]);
  });

  it("never pushes a run so far that a segment next to it comes out under MIN_SEGMENT", () => {
    const [routes, nodes] = crowdedByB();
    routes[0] = route("a", "a0", "a1", [[0, -100], [0, 0], [96, 0], [96, 10], [100, 10], [100, 200], [300, 200]]);
    routes[1] = route("b", "b0", "b1", [[110, 20], [110, 150]]);
    Object.assign(nodes, { a0: at(-10, -120), b0: at(100, 0) });
    expect(tidied(routes, nodes)[0]).toEqual([[0, -100], [0, 0], [96, 0], [96, 10], [100, 10], [100, 200], [300, 200]]);
  });

  it("never pushes a run so far that the run under an arrowhead comes out under ARROWHEAD_ROOM", () => {
    const [routes, nodes] = crowdedByB();
    routes[0] = route("a", "a0", "a1", [[60, 0], [100, 0], [100, 200], [300, 200]]);
    nodes.a0 = at(40, -10);
    expect(tidied(routes, nodes)[0]).toEqual([[60, 0], [100, 0], [100, 200], [300, 200]]);
  });

  it("never pushes the run under a label further than the box ELK reserved for it leaves room", () => {
    // The label's box leaves 6px beside the text, and b is 8px off a's run.
    const [routes, nodes] = crowdedByB(108);
    routes[0] = labelled(routes[0]!, { x: 74, y: 78 });
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [100, 0], [100, 200], [300, 200]]);
  });

  it("pushes the run under a label across the flow as far as the 12px its box keeps above and below the text", () => {
    // b is 8px off a's labelled run, as above, but the run is horizontal, so the push moves it in y.
    const routes = [
      labelled(route("a", "a0", "a1", [[0, 0], [0, 100], [200, 100], [200, 300]]), { x: 74, y: 78 }),
      route("b", "b0", "b1", [[-50, 108], [150, 108]]),
    ];
    const nodes = { a0: at(-10, -20), a1: at(190, 300), b0: at(-70, 98), b1: at(150, 98) };
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [0, 92], [200, 92], [200, 300]]);
  });

  it("never moves a self loop to space it from another arrow", () => {
    const routes = [route("l", "n", "n", [[20, 0], [20, -40], [80, -40], [80, 0]]), route("x", "x0", "x1", [[90, -60], [90, -10]])];
    const nodes = { n: at(0, 0, 100, 40), x0: at(80, -80), x1: at(80, -10) };
    expect(tidied(routes, nodes)[0]).toEqual([[20, 0], [20, -40], [80, -40], [80, 0]]);
  });

  // A 2px step between two runs, of which only the one between two bends can move: the end of the other would come
  // within END_SPACING of n's end on b. Folding it moves a's run 2px right, onto x=102.
  const stepBesideEnd = (): [Route[], Record<string, Shaped>] => [
    [route("a", "a0", "b", [[0, 0], [100, 0], [100, 50], [102, 50], [102, 100]]), route("n", "n0", "b", [[70, 60], [70, 100]])],
    { a0: at(-20, -10), b: at(40, 100, 100, 40), n0: at(60, 40) },
  ];

  it("folds a step by moving the run between two bends beside it", () => {
    expect(tidied(...stepBesideEnd())[0]).toEqual([[0, 0], [102, 0], [102, 100]]);
  });

  it("never folds a step into a crowded lane", () => {
    const [routes, nodes] = stepBesideEnd();
    routes.push(route("c", "c0", "c1", [[115, 0], [115, 50]]));
    Object.assign(nodes, { c0: at(105, -20), c1: at(105, 50) });
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [100, 0], [100, 50], [102, 50], [102, 100]]);
  });

  it("never folds a step through a node", () => {
    const [routes, nodes] = stepBesideEnd();
    nodes.o = at(101, 10, 40, 20);
    expect(tidied(routes, nodes)[0]).toEqual([[0, 0], [100, 0], [100, 50], [102, 50], [102, 100]]);
  });

  // A 2px step between two end runs. Its start cannot move: b leaves s 32px below it. Its end can only slide up c's
  // side, towards the corner, where ELK left it 27px off.
  const stepNearCorner = (top: number): [Route[], Record<string, Shaped>] => [
    [
      route("a", "s", "c", [[0, 0], [50, 0], [50, 2], [100, 2]]),
      route("b", "s", "e", [[0, 32], [30, 32], [30, 200], [300, 200]]),
      route("d", "f", "c", [[70, 160], [70, 34], [100, 34]]),
    ],
    { s: at(-60, -27, 60, 86), c: at(100, top, 60, 86), e: at(300, 180, 40, 40), f: at(60, 160) },
  ];

  it("folds a step by sliding an end 25px from a corner on a side holding other ends", () => {
    expect(tidied(...stepNearCorner(-25))[0]).toEqual([[0, 0], [100, 0]]);
  });

  it("leaves a step whose fold would slide an end nearer a corner than 25px", () => {
    expect(tidied(...stepNearCorner(-24))[0]).toEqual([[0, 0], [50, 0], [50, 2], [100, 2]]);
  });
});

describe("placeGroupLabel", () => {
  const box = { x: 0, y: 0, width: 300, height: 200 };
  const label = { width: 80, height: 20 };
  const down = (x: number): RoutedEdge => ({ points: [{ x, y: 0 }, { x, y: 100 }] });

  it("keeps the label in the corner when nothing crosses the strip", () => {
    expect(placeGroupLabel(box, label, [down(200)])).toEqual({ x: 16, y: 16 });
  });

  it("slides the label past a crossing arrow", () => {
    expect(placeGroupLabel(box, label, [down(60)])).toEqual({ x: 72, y: 16 });
  });

  it("falls back to the corner when no spot in the strip is free", () => {
    expect(placeGroupLabel(box, label, [down(60), down(140), down(220)])).toEqual({ x: 16, y: 16 });
  });
});
