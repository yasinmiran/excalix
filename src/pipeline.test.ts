import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sizeNote, sketch, viewScale, writeSketch } from "./pipeline.js";
import { estimateMeasurer } from "./render/estimate.js";
import { embeddedScene, measuringOnly, readSpec, specFiles, withoutAnimation } from "./test-support.js";
import type { Renderer } from "./types.js";

const renderer = measuringOnly(estimateMeasurer);

// Array order is part of the spec, so only the keys inside each object move.
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  }
  return value;
}

describe("sketch determinism", () => {
  for (const file of specFiles) {
    it(`sketches ${file} byte for byte the same twice`, async () => {
      const spec = readSpec(file);
      const first = await sketch(spec, renderer);
      const second = await sketch(spec, renderer);
      expect(second.excalidraw).toBe(first.excalidraw);
    });
  }

  it("ignores the key order inside the spec's objects", async () => {
    const spec = readSpec("examples/order-pipeline.json");
    const shuffled = reverseKeys(spec);
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(spec));
    expect((await sketch(shuffled, renderer)).excalidraw).toBe((await sketch(spec, renderer)).excalidraw);
  });
});

// What a model is handed passes through Claude Code's 2000px cap on a side, then the API's cap of 4784 tiles.
describe("size note", () => {
  it.each([
    ["a long strip, shrunk by its long edge", { width: 11124, height: 354 }, 2000 / 11124, "2000x64 px", 5],
    ["a dense square, shrunk by its area more than by its edge", { width: 5700, height: 5700 }, Math.sqrt((4784 * 784) / 5700 ** 2), "1937x1937 px", 10],
  ])("speaks up for %s", (_case, full, scale, seen, label) => {
    expect(viewScale(full)).toBeCloseTo(scale, 10);
    expect(sizeNote(full)).toBe(
      `note: a model reads this diagram at ${seen}, where its edge labels are about ${label}px tall, too small to read. ` +
        `Split it into an overview and a detail diagram, or shorten the longest labels; the PNG on disk keeps the full ${full.width}x${full.height}.`,
    );
  });

  it("lets the dense square through on its long edge alone, which is why the area counts", () => {
    expect(16 * 2 * (2000 / 5700)).toBeGreaterThan(11);
  });

  it.each([
    ["a small diagram that arrives whole", { width: 1606, height: 1338 }],
    ["one wide enough to be scaled, with labels that still read", { width: 5344, height: 1138 }],
  ])("stays quiet for %s", (_case, full) => {
    expect(sizeNote(full)).toBeUndefined();
  });
});

// Each committed render is also the scene, so dropping it on excalidraw.com reopens the drawing it shows.
describe("the scene inside the committed renders", () => {
  const examples = specFiles.filter((file) => file.startsWith("examples/")).map((file) => file.replace(/\.json$/, ""));

  const animated = examples.map((example) => `${example}.animated.svg`).filter((file) => existsSync(new URL(`../${file}`, import.meta.url)));
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));

  it.each(examples.flatMap((example) => [`${example}.svg`, `${example}.png`]).concat(animated))("%s carries the elements and files of its .excalidraw", (file) => {
    const written = JSON.parse(read(file.replace(/(\.animated)?\.(svg|png)$/, ".excalidraw")).toString("utf8")) as { elements: unknown[]; files: object };
    const image = file.endsWith(".svg") ? read(file).toString("utf8") : new Uint8Array(read(file));

    const scene = embeddedScene(image);

    expect(scene).toMatchObject({ type: "excalidraw", source: "excalix" });
    expect(JSON.stringify(scene!.elements)).toBe(JSON.stringify(written.elements));
    expect(JSON.stringify(scene!.files)).toBe(JSON.stringify(written.files));
  });

  it("commits an animated example", () => {
    expect(animated).toEqual(["examples/order-pipeline.animated.svg"]);
  });

  it.each(animated)("%s is its static svg with the animation added and nothing else changed", (file) => {
    expect(withoutAnimation(read(file).toString("utf8"))).toBe(read(file.replace(".animated", "")).toString("utf8"));
  });
});

/** A renderer that answers with what it was asked for, and a PNG header 4400 pixels wide at 2x. */
function recording(): { renderer: Renderer; calls: string[] } {
  const calls: string[] = [];
  const theme = (dark: boolean) => (dark ? "dark" : "light");
  const renderer: Renderer = {
    measurer: estimateMeasurer,
    svg: async (_elements, { dark }) => {
      calls.push(`svg ${theme(dark)}`);
      return `<svg ${theme(dark)}/>`;
    },
    animatedSvg: async (_elements, { dark, plan }) => {
      calls.push(`animated svg ${theme(dark)} of ${plan.elements.length}`);
      return `<svg animated ${theme(dark)}/>`;
    },
    png: async (_elements, { dark, scale }) => {
      calls.push(`png ${theme(dark)} at ${scale.toFixed(3)}`);
      const header = new Uint8Array(24);
      new DataView(header.buffer).setUint32(16, Math.trunc(2200 * scale));
      new DataView(header.buffer).setUint32(20, Math.trunc(500 * scale));
      return header;
    },
    close: async () => {},
  };
  return { renderer, calls };
}

describe("theme", () => {
  const spec = readSpec("examples/order-pipeline.json");

  it.each([
    ["light", ["svg light", "png light at 2.000", "png light at 0.909"], "<svg light/>", undefined],
    ["dark", ["svg dark", "png dark at 2.000", "png dark at 0.909"], "<svg dark/>", undefined],
    ["both", ["svg light", "png light at 2.000", "svg dark", "png dark at 2.000", "png light at 0.909"], "<svg light/>", "<svg dark/>"],
  ] as const)("draws %s, with the preview in the theme of the png", async (theme, expected, svg, dark) => {
    const { renderer, calls } = recording();

    const result = await sketch(spec, renderer, { theme, preview: true });

    expect(calls).toEqual(expected);
    expect(result.svg).toBe(svg);
    expect(result.dark?.svg).toBe(dark);
  });

  it("writes the dark pair beside the light files only for both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "excalix-theme-"));

    const { files } = await writeSketch(spec, join(dir, "both/diagram"), recording().renderer, { theme: "both" });
    await writeSketch(spec, join(dir, "dark/diagram"), recording().renderer, { theme: "dark" });

    expect(files.dark).toEqual({ svg: join(dir, "both/diagram.dark.svg"), png: join(dir, "both/diagram.dark.png") });
    expect((await readdir(join(dir, "both"))).sort()).toEqual(["diagram.dark.png", "diagram.dark.svg", "diagram.excalidraw", "diagram.png", "diagram.svg"]);
    expect((await readdir(join(dir, "dark"))).sort()).toEqual(["diagram.excalidraw", "diagram.png", "diagram.svg"]);
  });
});

describe("animate", () => {
  const spec = readSpec("examples/order-pipeline.json");

  it("draws an animated svg after each static pair, in the theme of that pair", async () => {
    const { renderer, calls } = recording();

    const result = await sketch(spec, renderer, { theme: "both", animate: "story" });

    expect(calls).toEqual(["svg light", "png light at 2.000", "animated svg light of 27", "svg dark", "png dark at 2.000", "animated svg dark of 27"]);
    expect(result.animatedSvg).toBe("<svg animated light/>");
    expect(result.dark?.animatedSvg).toBe("<svg animated dark/>");
  });

  it("writes <out>.animated.svg beside <out>.svg, and the dark one beside the dark pair, only when asked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "excalix-animate-"));

    const { files } = await writeSketch(spec, join(dir, "both/diagram"), recording().renderer, { theme: "both", animate: "layers" });
    const { files: still } = await writeSketch(spec, join(dir, "still/diagram"), recording().renderer, { theme: "both" });

    expect(files.animatedSvg).toBe(join(dir, "both/diagram.animated.svg"));
    expect(files.dark?.animatedSvg).toBe(join(dir, "both/diagram.dark.animated.svg"));
    expect((await readdir(join(dir, "both"))).sort()).toEqual([
      "diagram.animated.svg", "diagram.dark.animated.svg", "diagram.dark.png", "diagram.dark.svg", "diagram.excalidraw", "diagram.png", "diagram.svg",
    ]);
    expect(still).not.toHaveProperty("animatedSvg");
    expect(still.dark).not.toHaveProperty("animatedSvg");
  });
});
