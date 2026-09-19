import { describe, expect, it } from "vitest";
import { sketch } from "./pipeline.js";
import { estimateMeasurer } from "./render/estimate.js";
import { measuringOnly, readSpec, specFiles } from "./test-support.js";

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
