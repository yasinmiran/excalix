import { describe, expect, it } from "vitest";
import { ARROWHEAD_ROOM, END_SPACING, LABEL_MARGIN, layout, placeGroupLabel } from "./layout.js";
import { FONT, nodeSize } from "./style.js";
import type { Box, Kind, LayoutInput, LayoutResult, Point, RoutedEdge, RoutedLabel, TextSize } from "./types.js";

function estimate(text: string, fontSize: number): TextSize {
  return { width: text.length * fontSize * 0.6, height: fontSize * FONT.lineHeight };
}

function node(id: string, label: string, kind: Kind, group?: string) {
  return { id, ...nodeSize(kind, estimate(label, FONT.node)), ...(group ? { group } : {}) };
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

function allPoints(result: LayoutResult): Point[] {
  const boxes = [...Object.values(result.nodes), ...Object.values(result.groups)];
  return [
    ...boxes.flatMap((b) => [b, { x: b.x + b.width, y: b.y + b.height }]),
    ...Object.values(result.edges).flatMap((e) => e.points),
  ];
}

describe("layout on the order pipeline", () => {
  const run = layout(orderPipeline);

  it("routes every edge from the source border to the target border", async () => {
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

  it("grows a node along the side several arrows land on, in both directions", async () => {
    for (const direction of ["lr", "tb"] as const) {
      const result = await layout({
        direction,
        groups: [],
        nodes: [node("hub", "Hub", "service"), node("a", "A", "service"), node("b", "B", "service"), node("c", "C", "service")],
        edges: [edge(0, "a", "hub"), edge(1, "b", "hub"), edge(2, "c", "hub")],
      });
      const hub = result.nodes.hub!;
      expect(direction === "lr" ? hub.height : hub.width, direction).toBeGreaterThanOrEqual(4 * END_SPACING);
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
