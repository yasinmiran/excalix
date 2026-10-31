import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sizeNote, sketch, viewScale } from "./pipeline.js";
import { estimateMeasurer } from "./render/estimate.js";
import { embeddedScene, measuringOnly, readSpec, specFiles } from "./test-support.js";

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

  it.each(examples.flatMap((example) => [`${example}.svg`, `${example}.png`]))("%s carries the elements of its .excalidraw", (file) => {
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
    const written = JSON.parse(read(file.replace(/\.(svg|png)$/, ".excalidraw")).toString("utf8")) as { elements: unknown[] };
    const image = file.endsWith(".svg") ? read(file).toString("utf8") : new Uint8Array(read(file));

    const scene = embeddedScene(image);

    expect(scene).toMatchObject({ type: "excalidraw", source: "excalix" });
    expect(JSON.stringify(scene!.elements)).toBe(JSON.stringify(written.elements));
  });
});
