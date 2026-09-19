import { afterAll, beforeAll } from "vitest";
import { describeGeometry } from "../test-support.js";
import type { Renderer } from "../types.js";
import { createBrowserRenderer } from "./browser.js";

// The same invariants as src/geometry.test.ts, on the metrics the rendered output actually uses.
let renderer: Renderer;

beforeAll(async () => {
  renderer = await createBrowserRenderer();
});

afterAll(async () => {
  await renderer?.close();
});

describeGeometry("[browser] geometry of", () => renderer.measurer);
