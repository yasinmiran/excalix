import { createHash } from "node:crypto";
import { edgeKey, hashSpec } from "./ids.js";
import { ANIMATION, EDGE } from "./style.js";
import type { AnimationOrder, AnimationPlan, Drawing, ElementMotion, LayoutResult, RouteMask, Spec } from "./types.js";

// Excalidraw dashes a line 8 on and 8 + strokeWidth off, so moving the dashes by one period loops seamlessly.
const DASH_PERIOD = 16 + EDGE.strokeWidth;

/**
 * The keys of a drawing in the beats that bring them in, in order. Story follows the spec: the title, then per edge
 * its source with the groups around it, its target likewise, then the arrow; nodes no edge reached come last. Layers
 * follows the layout: nodes whose boxes overlap along the flow come in together, each layer followed by the arrows
 * whose ends are now both there. A key joins the beat of what it belongs to, so `node:api:label` and anything else
 * under `node:api` come in with the node.
 */
export function beats(spec: Spec, layout: LayoutResult, keys: string[], order: AnimationOrder): string[][] {
  const steps = order === "story" ? story(spec) : layers(spec, layout);
  const beatOf = new Map(steps.flatMap((owners, beat) => owners.map((owner) => [owner, beat] as const)));
  const grouped = steps.map((): string[] => []);
  for (const key of keys) {
    const beat = beatOf.get(ownerOf(key));
    if (beat === undefined) throw new Error(`no beat brings in ${key}`);
    grouped[beat]!.push(key);
  }
  return grouped;
}

/** How long one of `count` beats lasts, and how long a solid arrow takes to draw on within it. */
export function beatTiming(count: number): { beat: number; draw: number } {
  const beat = Math.round(Math.min(ANIMATION.maxBeat, Math.max(ANIMATION.minBeat, ANIMATION.build / count)));
  return { beat, draw: Math.min(ANIMATION.draw, beat) };
}

/**
 * The prefix of every class and keyframes a plan names, one per spec and order. An SVG inlined in a page shares the
 * page's style sheet, so two diagrams on one page that named the same keyframes would both run on one's timing.
 */
export function animationName(spec: Spec, order: AnimationOrder): string {
  return `xa-${createHash("sha256").update(`${hashSpec(spec)}:${order}`).digest("hex").slice(0, 6)}`;
}

/**
 * The motion of every element and the CSS that runs it, one loop of `cycle` ms, every name in it starting with `name`.
 * The first beat shows from the start, so a frame taken at any moment has something on it. Every hidden state lives
 * in a keyframe and none in a base style, so a renderer that ignores animation draws the finished diagram; one that
 * runs it and keeps the first frame, such as a file browser's thumbnail, shows the opening beat alone.
 */
export function animationPlan(drawing: Drawing, beats: string[][], name: string): AnimationPlan {
  const { beat, draw } = beatTiming(beats.length);
  const beatOf = new Map(beats.flatMap((keys, index) => keys.map((key) => [key, index] as const)));
  const drawn = new Set<number>();
  let marches = false;
  const elements = drawing.elements.map((element, index): ElementMotion => {
    const at = beatOf.get(drawing.keys[index]!);
    if (at === undefined) throw new Error(`no beat brings in ${drawing.keys[index]}`);
    const motion: ElementMotion = {};
    if (at > 0) motion.className = `${name}-b${at}`;
    if (element.type !== "arrow") return motion;
    if (element.strokeStyle === "dashed") {
      motion.march = `${name}-flow`;
      marches = true;
    } else if (at > 0) {
      motion.draw = { mask: routeMask(element.points, `${name}-m${index}`, `${name}-d${at}`), heads: `${name}-h${at}` };
      drawn.add(at);
    }
    return motion;
  });

  const settled = (at: number) => at * beat + (drawn.has(at) ? Math.max(ANIMATION.fade, draw + ANIMATION.heads) : ANIMATION.fade);
  let build = 0;
  for (let at = 1; at < beats.length; at++) build = Math.max(build, settled(at));
  const cycle = build + ANIMATION.hold;
  // Thousandths of a percent of the cycle, about a tenth of a millisecond, so the CSS stays short and exact.
  const tick = (ms: number) => Math.round((100_000 * ms) / cycle);
  const pct = (ticks: number) => `${ticks / 1000}%`;
  const loop = `${cycle}ms linear infinite`;

  const rules: string[] = [];
  for (let at = 1; at < beats.length; at++) {
    const start = at * beat;
    rules.push(`@keyframes ${name}-b${at}{0%,${pct(tick(start))}{opacity:0}${pct(tick(start + ANIMATION.fade))}{opacity:1}}`);
    rules.push(`.${name}-b${at}{animation:${name}-b${at} ${loop}}`);
    if (!drawn.has(at)) continue;
    // The mask's dash array goes back to none a tick after the line is whole, so the finished line is the static one.
    const whole = tick(start + draw);
    rules.push(
      `@keyframes ${name}-d${at}{0%,${pct(tick(start))}{stroke-dasharray:1;stroke-dashoffset:1}` +
        `${pct(whole)}{stroke-dasharray:1;stroke-dashoffset:0}${pct(whole + 1)}{stroke-dasharray:none}}`,
    );
    rules.push(`.${name}-d${at}{animation:${name}-d${at} ${loop}}`);
    rules.push(`@keyframes ${name}-h${at}{0%,${pct(tick(start + draw))}{opacity:0}${pct(tick(start + draw + ANIMATION.heads))}{opacity:1}}`);
    rules.push(`.${name}-h${at}{animation:${name}-h${at} ${loop}}`);
  }
  if (marches) {
    rules.push(`@keyframes ${name}-flow{to{stroke-dashoffset:-${DASH_PERIOD}}}`);
    rules.push(`.${name}-flow{animation:${name}-flow ${ANIMATION.march}ms linear infinite}`);
  }
  // Scoped to the classes a plan names, which all start xa-: an SVG inlined in a page shares the page's style sheet.
  rules.push('@media (prefers-reduced-motion:reduce){[class^="xa-"]{animation:none!important}}');
  return { elements, css: rules.join("\n"), cycle };
}

/**
 * The mask a line draws on through. Half its stroke takes in half the line's width, a pixel of antialiasing, and the
 * furthest roughjs bows a segment off its route: 4px, or for one over 500px, 0.8px and 1/250 of its length. A
 * segment's x and y distances added are never under its length.
 */
function routeMask(points: readonly (readonly [number, number])[], id: string, className: string): RouteMask {
  let longest = 0;
  for (let at = 1; at < points.length; at++) {
    longest = Math.max(longest, Math.abs(points[at]![0] - points[at - 1]![0]) + Math.abs(points[at]![1] - points[at - 1]![1]));
  }
  const strokeWidth = Math.max(ANIMATION.mask, Math.ceil(longest / 50));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.floor(Math.min(...xs) - strokeWidth);
  const y = Math.floor(Math.min(...ys) - strokeWidth);
  return {
    id,
    d: points.map(([px, py], at) => `${at === 0 ? "M" : "L"}${px} ${py}`).join(" "),
    strokeWidth,
    x,
    y,
    width: Math.ceil(Math.max(...xs) + strokeWidth) - x,
    height: Math.ceil(Math.max(...ys) + strokeWidth) - y,
    className,
  };
}

function story(spec: Spec): string[][] {
  const { steps, reveal } = revealer();
  const { node, group } = ownersOf(spec);
  if (spec.title !== undefined) reveal(["title"]);
  spec.edges.forEach((edge, index) => {
    reveal(node(edge.from));
    reveal(node(edge.to));
    reveal([edgeKey(index)]);
  });
  for (const { id } of spec.nodes) reveal(node(id));
  for (const { id } of spec.groups) reveal(group(id));
  return steps;
}

function layers(spec: Spec, layout: LayoutResult): string[][] {
  const [start, extent] = spec.direction === "tb" ? (["y", "height"] as const) : (["x", "width"] as const);
  const boxes = spec.nodes
    .map(({ id }) => {
      const box = layout.nodes[id];
      if (!box) throw new Error(`layout has no box for ${id}`);
      return { id, box };
    })
    .sort((a, b) => a.box[start] - b.box[start]);
  // The layers ELK placed, read back with the overlap test evenLayers uses, here across every node rather than per
  // group, so one beat is one column (or row) of the whole diagram: boxes that overlap along the flow share one.
  const buckets: string[][] = [];
  let end = -Infinity;
  for (const { id, box } of boxes) {
    if (buckets.length === 0 || box[start] >= end) buckets.push([]);
    buckets.at(-1)!.push(id);
    end = Math.max(end, box[start] + box[extent]);
  }

  const { steps, reveal } = revealer();
  const { node, group } = ownersOf(spec);
  if (spec.title !== undefined) reveal(["title"]);
  const there = new Set<string>();
  for (const bucket of buckets) {
    reveal(bucket.flatMap(node));
    for (const id of bucket) there.add(id);
    reveal(spec.edges.flatMap((edge, index) => (there.has(edge.from) && there.has(edge.to) ? [edgeKey(index)] : [])));
  }
  for (const { id } of spec.groups) reveal(group(id));
  return steps;
}

/** Collects beats of owner keys, each owner in the first beat that names it, and no beat left empty. */
function revealer(): { steps: string[][]; reveal: (owners: string[]) => void } {
  const shown = new Set<string>();
  const steps: string[][] = [];
  const reveal = (owners: string[]) => {
    const fresh = [...new Set(owners)].filter((owner) => !shown.has(owner));
    for (const owner of fresh) shown.add(owner);
    if (fresh.length > 0) steps.push(fresh);
  };
  return { steps, reveal };
}

/** The owner keys that bring in a node or a group: its own, after those of the groups around it, outermost first. */
function ownersOf(spec: Spec): { node: (id: string) => string[]; group: (id: string) => string[] } {
  const parentOf = new Map(spec.groups.map((group) => [group.id, group.parent]));
  const groupOf = new Map(spec.nodes.map((node) => [node.id, node.group]));
  const group = (id: string | undefined): string[] => {
    const owners: string[] = [];
    for (let at = id; at !== undefined; at = parentOf.get(at)) owners.unshift(`group:${at}`);
    return owners;
  };
  return { node: (id) => [...group(groupOf.get(id)), `node:${id}`], group };
}

// Ids hold no colon, so the first two parts of a key name what it belongs to: `title`, `group:aws`, `node:api`, `edge:3`.
function ownerOf(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}
