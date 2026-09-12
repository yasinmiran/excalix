import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExcalidrawElement, ExcalidrawTextElement } from "excalidraw-types/element/src/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Renderer } from "../types.js";
import { createBrowserRenderer } from "./browser.js";

const OUT_DIR = "out/render-check";
const EXCALIFONT_STACK = "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function base(id: string, x: number, y: number, width: number, height: number) {
  return {
    id,
    x,
    y,
    width,
    height,
    angle: 0 as never,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 2,
    strokeStyle: "solid" as const,
    roughness: 1,
    opacity: 100,
    roundness: null,
    seed: 1_234_567,
    version: 1,
    versionNonce: 7_654_321,
    index: null,
    isDeleted: false as const,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1_700_000_000_000,
    created: null,
    link: null,
    locked: false,
  };
}

function label(id: string, containerId: string, text: string, box: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }): ExcalidrawTextElement {
  return {
    ...base(id, box.x + (box.width - size.width) / 2, box.y + (box.height - size.height) / 2, size.width, size.height),
    type: "text",
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 5,
    baseFontSize: null,
    textAlign: "center",
    verticalAlign: "middle",
    containerId,
    autoResize: true,
    lineHeight: 1.25 as ExcalidrawTextElement["lineHeight"],
  };
}

function scene(labelText: string, labelSize: { width: number; height: number }): ExcalidrawElement[] {
  const api = { x: 0, y: 0, width: 160, height: 64 };
  return [
    {
      ...base("api", api.x, api.y, api.width, api.height),
      type: "rectangle",
      backgroundColor: "#a5d8ff",
      roundness: { type: 3 },
      boundElements: [{ type: "text", id: "api-label" }],
    },
    label("api-label", "api", labelText, api, labelSize),
    { ...base("web", 300, 0, 140, 64), type: "ellipse", backgroundColor: "#e9ecef" },
    {
      ...base("edge", 160, 32, 140, 0),
      type: "arrow",
      points: [
        [0, 0],
        [140, 0],
      ] as never,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    },
  ];
}

function pngDimensions(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function svgDimensions(svg: string): { width: number; height: number } {
  const width = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1]);
  const height = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1]);
  return { width, height };
}

describe("[browser] createBrowserRenderer", () => {
  let renderer: Renderer;
  let elements: ExcalidrawElement[];

  beforeAll(async () => {
    renderer = await createBrowserRenderer();
    const [size] = await renderer.measurer.measure(["Order API"], 20);
    elements = scene("Order API", size!);
    await mkdir(OUT_DIR, { recursive: true });
  });

  afterAll(async () => {
    await renderer?.close();
    await renderer?.close();
  });

  it("measures Excalifont like Excalidraw does", async () => {
    const [single, multi] = await renderer.measurer.measure(["Order API", "Order\nAPI"], 20);
    expect(single!.width).toBeGreaterThan(60);
    expect(single!.width).toBeLessThan(140);
    expect(single!.height).toBe(25);
    expect(multi!.width).toBeLessThan(single!.width);
    expect(multi!.height).toBe(50);
  });

  it("exports a self-contained SVG with a subsetted Excalifont", async () => {
    const svg = await renderer.svg(elements);
    await writeFile(join(OUT_DIR, "sample.svg"), svg);

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Order API");
    expect(svg.length).toBeLessThan(300_000);
    expect(svg).toContain(`font-family="${EXCALIFONT_STACK}"`);

    const fontFace = /@font-face \{ font-family: Excalifont; src: url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\); \}/.exec(svg);
    expect(fontFace).not.toBeNull();
    expect(fontFace![1]!.length).toBeLessThan(12_000);
  });

  it("renders byte-identical SVG for the same elements", async () => {
    const first = await renderer.svg(elements);
    const second = await renderer.svg(elements);
    expect(second).toBe(first);
  });

  it("renders byte-identical SVG when several font faces are inlined", async () => {
    const [size] = await renderer.measurer.measure(["Łódź API"], 20);
    const mixed = scene("Łódź API", size!);
    const first = await renderer.svg(mixed);
    const second = await renderer.svg(mixed);
    expect(first.match(/@font-face/g)).toHaveLength(2);
    expect(second).toBe(first);
  });

  it("exports a PNG at 2x the SVG size", async () => {
    const [svg, png] = await Promise.all([renderer.svg(elements), renderer.png(elements)]);
    await writeFile(join(OUT_DIR, "sample.png"), png);

    expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    const expected = svgDimensions(svg);
    const actual = pngDimensions(png);
    expect(Math.abs(actual.width - expected.width * 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(actual.height - expected.height * 2)).toBeLessThanOrEqual(2);
  });
});
