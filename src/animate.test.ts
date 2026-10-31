import { describe, expect, it } from "vitest";
import { animationName, animationPlan, beats, beatTiming } from "./animate.js";
import { build, type Built } from "./pipeline.js";
import { estimateMeasurer } from "./render/estimate.js";
import { ANIMATION } from "./style.js";
import { readSpec, specFiles } from "./test-support.js";
import type { AnimationOrder, AnimationPlan } from "./types.js";

const built = new Map<string, Promise<Built>>();
const builtOf = (file: string) => {
  if (!built.has(file)) built.set(file, build(readSpec(file), estimateMeasurer));
  return built.get(file)!;
};

async function beatsOf(file: string, order: AnimationOrder): Promise<string[][]> {
  const { spec, layout, drawing } = await builtOf(file);
  return beats(spec, layout, drawing.keys, order);
}

async function planOf(file: string, order: AnimationOrder): Promise<AnimationPlan> {
  const { spec, drawing } = await builtOf(file);
  return animationPlan(drawing, await beatsOf(file, order), animationName(spec, order));
}

describe("beats", () => {
  it.each<[AnimationOrder, string[]]>([
    [
      "story",
      [
        "title",
        "node:web node:web:label",
        "group:aws group:aws:label group:k8s group:k8s:label node:api node:api:label",
        "edge:0 edge:0:label",
        "node:pg node:pg:label",
        "edge:1",
        "node:redis node:redis:label",
        "edge:2",
        "node:q node:q:label",
        "edge:3",
        "node:worker node:worker:label",
        "edge:4",
        "node:stripe node:stripe:label",
        "edge:5 edge:5:label",
      ],
    ],
    [
      "layers",
      [
        "title",
        "node:web node:web:label",
        "group:aws group:aws:label group:k8s group:k8s:label node:api node:api:label node:worker node:worker:label",
        "edge:0 edge:0:label",
        "node:q node:q:label node:pg node:pg:label node:redis node:redis:label",
        "edge:1 edge:2 edge:3 edge:4",
        "node:stripe node:stripe:label",
        "edge:5 edge:5:label",
      ],
    ],
  ])("brings in examples/order-pipeline in %s order", async (order, expected) => {
    expect((await beatsOf("examples/order-pipeline.json", order)).map((keys) => keys.join(" "))).toEqual(expected);
  });

  for (const file of specFiles) {
    it.each<AnimationOrder>(["story", "layers"])(`puts every key of ${file} in exactly one beat, in %s order`, async (order) => {
      const { drawing } = await builtOf(file);

      const all = (await beatsOf(file, order)).flat();

      expect([...all].sort()).toEqual([...drawing.keys].sort());
      expect(new Set(all).size).toBe(all.length);
    });
  }

  it("brings in an element under a node with its node, whatever follows the node id", async () => {
    const { spec, layout, drawing } = await builtOf("examples/order-pipeline.json");
    const keys = drawing.keys.flatMap((key) => (key === "node:api:label" ? [key, "node:api:icon"] : [key]));

    const story = beats(spec, layout, keys, "story");

    expect(story[2]).toEqual(["group:aws", "group:aws:label", "group:k8s", "group:k8s:label", "node:api", "node:api:label", "node:api:icon"]);
  });

  it("names a key that belongs to nothing in the spec", async () => {
    const { spec, layout, drawing } = await builtOf("examples/order-pipeline.json");

    expect(() => beats(spec, layout, [...drawing.keys, "node:ghost:icon"], "story")).toThrow("no beat brings in node:ghost:icon");
  });
});

describe("animation plan", () => {
  it("draws a solid arrow on, marches a dashed one, and leaves the opening beat as it is", async () => {
    const { spec, drawing } = await builtOf("examples/order-pipeline.json");
    const plan = await planOf("examples/order-pipeline.json", "story");
    const name = animationName(spec, "story");
    const motionOf = (key: string) => plan.elements[drawing.keys.indexOf(key)];

    expect(plan.elements).toHaveLength(drawing.elements.length);
    expect(motionOf("title")).toEqual({});
    expect(motionOf("node:web")).toEqual({ className: `${name}-b1` });
    expect(motionOf("edge:1")).toEqual({
      className: `${name}-b5`,
      draw: {
        mask: {
          id: `${name}-m${drawing.keys.indexOf("edge:1")}`,
          d: "M0 0 L60 0 L60 -62 L96 -62",
          strokeWidth: 16,
          x: -16,
          y: -78,
          width: 128,
          height: 94,
          className: `${name}-d5`,
        },
        heads: `${name}-h5`,
      },
    });
    expect(motionOf("edge:0:label")).toEqual({ className: `${name}-b3` });
    expect(motionOf("edge:3")).toEqual({ className: `${name}-b9`, march: `${name}-flow` });
  });

  it("widens the mask a line draws on through for a long segment, which roughjs bows further off its route", async () => {
    const { drawing } = await builtOf("stress/multi-region-lr.json");
    const plan = await planOf("stress/multi-region-lr.json", "story");

    const mask = plan.elements[drawing.keys.indexOf("edge:22")]!.draw!.mask;

    expect(mask.d).toBe("M0 0 L1059 0");
    expect(mask.strokeWidth).toBe(Math.ceil(1059 / 50));
    expect([mask.x, mask.y, mask.width, mask.height]).toEqual([-22, -22, 1059 + 44, 44]);
  });

  it("names its classes and keyframes apart for each spec and order, the same every time", async () => {
    const names = await Promise.all(
      ["examples/order-pipeline.json", "examples/auth-flow.json"].flatMap((file) =>
        (["story", "layers"] as const).map(async (order) => animationName((await builtOf(file)).spec, order)),
      ),
    );

    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name).toMatch(/^xa-[0-9a-f]{6}$/);
    expect(animationName((await build(readSpec("examples/order-pipeline.json"), estimateMeasurer)).spec, "story")).toBe(names[0]);
    const plan = await planOf("examples/order-pipeline.json", "story");
    const named = [...plan.css.matchAll(/(?:@keyframes |\.)(xa-[\w-]+)/g)].map(([, found]) => found!);
    expect(named.length).toBeGreaterThan(0);
    for (const found of named) expect(found.startsWith(`${names[0]}-`)).toBe(true);
  });

  it("writes the same CSS for the same spec, and puts the hidden states in keyframes alone", async () => {
    const file = "examples/order-pipeline.json";
    const first = await planOf(file, "story");
    const again = await build(readSpec(file), estimateMeasurer);

    const second = animationPlan(again.drawing, beats(again.spec, again.layout, again.drawing.keys, "story"), animationName(again.spec, "story"));

    expect(second).toEqual(first);
    const outsideKeyframes = first.css.replace(/@keyframes [\w-]+\{(?:[^{}]*\{[^{}]*\})*\}/g, "");
    expect(outsideKeyframes).not.toMatch(/opacity|stroke-dash/);
    expect(first.css).toContain('@media (prefers-reduced-motion:reduce){[class^="xa-"]{animation:none!important}}');
  });

  it("times order-pipeline's story at the documented beat, draw and hold", async () => {
    const file = "examples/order-pipeline.json";
    const plan = await planOf(file, "story");
    const name = animationName((await builtOf(file)).spec, "story");

    // 14 beats: 571 ms each, the last one's line drawn by 571 and its heads in by 771, then the hold.
    expect(beatTiming(14)).toEqual({ beat: 571, draw: 571 });
    expect(plan.cycle).toBe(13 * 571 + 571 + ANIMATION.heads + ANIMATION.hold);
    expect(plan.css).toContain(`.${name}-b1{animation:${name}-b1 ${plan.cycle}ms linear infinite}`);
    expect(plan.css).toContain(`.${name}-flow{animation:${name}-flow 900ms linear infinite}`);
    expect(plan.css).toContain(`@keyframes ${name}-flow{to{stroke-dashoffset:-18}}`);
  });

  it("speeds a long story up to the shortest beat, so ride-hailing's 33 beats loop in under 12 s", async () => {
    const file = "examples/ride-hailing.json";
    const story = await beatsOf(file, "story");

    const plan = await planOf(file, "story");

    expect(story).toHaveLength(33);
    expect(beatTiming(33)).toEqual({ beat: ANIMATION.minBeat, draw: ANIMATION.minBeat });
    expect(plan.cycle).toBe(32 * 250 + 250 + ANIMATION.heads + ANIMATION.hold);
    expect(plan.cycle).toBeLessThan(12_000);
    expect(33 * ANIMATION.maxBeat + ANIMATION.hold).toBeGreaterThan(26_000);
  });

  it.each([
    [4, { beat: 700, draw: 600 }],
    [16, { beat: 500, draw: 500 }],
    [100, { beat: 250, draw: 250 }],
  ])("gives %i beats a beat and draw of %o", (count, expected) => {
    expect(beatTiming(count)).toEqual(expected);
  });

  it("leaves a diagram of one beat still, with nothing to animate", async () => {
    const plan = await planOf("stress/single.json", "story");

    expect(plan.elements.every((motion) => Object.keys(motion).length === 0)).toBe(true);
    expect(plan.css).not.toContain("@keyframes");
  });
});
