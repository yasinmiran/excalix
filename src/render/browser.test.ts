import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { ExcalidrawElement, ExcalidrawTextElement } from "excalidraw-types/element/src/types";
import { type Browser, chromium, type Page, webkit } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lineHeight, localPoint, radians } from "../elements.js";
import { iconSvg } from "../icons.js";
import { ICON_NAMES } from "../spec.js";
import { fractionalIndex } from "../fractional-index.js";
import { pngSize, sketch, writeSketch } from "../pipeline.js";
import { embeddedScene, pngChunks, readSpec, specFiles } from "../test-support.js";
import type { Renderer } from "../types.js";
import { createBrowserRenderer, launchBrowser, openRenderPage, wholePixels } from "./browser.js";
import { codePointRanges, PINNED_FAMILY, pinnedFaces, pinnedFontFaceRules } from "./pinned-fonts.js";

const OUT_DIR = "out/render-check";
const LIGHT = { dark: false, files: {} };
const DARK = { dark: true, files: {} };
const EXCALIFONT_STACK = "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function base(id: string, x: number, y: number, width: number, height: number) {
  return {
    id,
    x,
    y,
    width,
    height,
    angle: radians(0),
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
    lineHeight: lineHeight(1.25),
  };
}

// Each element gets the fractional index restore would give it, since restore runs on the scene an export embeds
// and stamps a time and a random nonce on any element it has to change.
function scene(labelText: string, labelSize: { width: number; height: number }): ExcalidrawElement[] {
  const api = { x: 0, y: 0, width: 160, height: 64 };
  const elements: ExcalidrawElement[] = [
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
      points: [localPoint(0, 0), localPoint(140, 0)],
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    },
  ];
  return elements.map((element, position) => ({ ...element, index: fractionalIndex(position) }));
}

/** The same 2x PNG export the renderer makes, with no scene in it. */
async function plainPngInPage(elements: unknown[]): Promise<number[]> {
  const { utils } = (window as unknown as { excalix: { utils: { exportToBlob(args: object): Promise<Blob> } } }).excalix;
  const blob = await utils.exportToBlob({
    data: { elements, appState: { exportBackground: true, viewBackgroundColor: "#ffffff" }, files: {} },
    config: { padding: 24, scale: 2, mimeType: "image/png" },
  });
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

/** The colour of the top-left pixel as #rrggbb: every PNG filter leaves the first pixel of the first row as it is. */
function cornerColour(png: Uint8Array): string {
  const pixels = inflateSync(Buffer.concat(pngChunks(png).flatMap(({ type, data }) => (type === "IDAT" ? [data] : []))));
  return `#${pixels.subarray(1, 4).toString("hex")}`;
}

/** The fill of the rect an SVG export draws its background with. */
function backgroundFill(svg: string): string | undefined {
  return /<rect x="0" y="0" width="[\d.]+" height="[\d.]+" fill="(#[0-9a-f]+)">/.exec(svg)?.[1];
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

  // Ten CJK glyphs are exactly the line an edge label wraps at, so a width a hair over it would wrap them on Linux only.
  it("measures a run of CJK glyphs at exactly the font size each", async () => {
    const [cjk] = await renderer.measurer.measure(["下单后通知库存服务预"], 16);
    expect(cjk!.width).toBe(160);
  });

  it("rounds a width up to the same whole pixel whether its glyph advances carry Linux's 2^-15px or not", () => {
    // macOS and Linux widths of the same texts, as Chromium measured them on each.
    expect([160, 160.00030518, 102.95991516, 102.96017456].map(wholePixels)).toEqual([160, 160, 103, 103]);
    expect(wholePixels(160.02)).toBe(161);
  });

  it("exports a self-contained SVG with a subsetted Excalifont", async () => {
    const svg = await renderer.svg(elements, LIGHT);
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
    const first = await renderer.svg(elements, LIGHT);
    const second = await renderer.svg(elements, LIGHT);
    expect(second).toBe(first);
  });

  it("renders byte-identical SVG when several font faces are inlined", async () => {
    const [size] = await renderer.measurer.measure(["Łódź API"], 20);
    const mixed = scene("Łódź API", size!);
    const first = await renderer.svg(mixed, LIGHT);
    const second = await renderer.svg(mixed, LIGHT);
    expect(first.match(/@font-face/g)).toHaveLength(2);
    expect(second).toBe(first);
  });

  it("embeds the scene without changing a pixel", async () => {
    // The renderer's own launch flags: without them Linux hints glyphs differently and no pixel comparison holds.
    const browser = await launchBrowser();
    try {
      const page = await openRenderPage(browser);
      const plain = new Uint8Array(await page.evaluate(plainPngInPage, elements));
      const embedded = await renderer.png(elements, { ...LIGHT, scale: 2 });

      const idat = (png: Uint8Array) => Buffer.concat(pngChunks(png).flatMap(({ type, data }) => (type === "IDAT" ? [data] : [])));
      expect(pngChunks(embedded).map(({ type }) => type)).toEqual([...pngChunks(plain).map(({ type }) => type).slice(0, -1), "tEXt", "IEND"]);
      expect(idat(embedded).equals(idat(plain))).toBe(true);
      // Restore fills in a field or two these hand-made elements leave out; file-load.test.ts holds a sketch's to the byte.
      const ids = (scene: { elements: unknown[] } | undefined) => scene?.elements.map((element) => (element as { id: string }).id);
      expect(ids(embeddedScene(embedded))).toEqual(elements.map((element) => element.id));
      expect(ids(embeddedScene(await renderer.svg(elements, LIGHT)))).toEqual(elements.map((element) => element.id));
    } finally {
      await browser.close();
    }
  });

  // Each format reads dark mode from a different switch and ignores the other's, so only the output tells.
  it("draws the dark SVG and PNG on Excalidraw's dark background, at the light ones' size", async () => {
    const [lightSvg, darkSvg] = await Promise.all([renderer.svg(elements, LIGHT), renderer.svg(elements, DARK)]);
    const [lightPng, darkPng] = await Promise.all([renderer.png(elements, { ...LIGHT, scale: 2 }), renderer.png(elements, { ...DARK, scale: 2 })]);
    await writeFile(join(OUT_DIR, "sample.dark.png"), darkPng);

    expect([backgroundFill(lightSvg), backgroundFill(darkSvg)]).toEqual(["#ffffff", "#121212"]);
    expect([cornerColour(lightPng), cornerColour(darkPng)]).toEqual(["#ffffff", "#121212"]);
    expect(Buffer.from(darkPng).equals(Buffer.from(lightPng))).toBe(false);
    expect(pngDimensions(darkPng)).toEqual(pngDimensions(lightPng));
  });

  it("renders the dark SVG and PNG byte for byte the same twice", async () => {
    expect(await renderer.svg(elements, DARK)).toBe(await renderer.svg(elements, DARK));
    const [first, second] = [await renderer.png(elements, { ...DARK, scale: 2 }), await renderer.png(elements, { ...DARK, scale: 2 })];
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("exports a PNG at 2x the SVG size", async () => {
    const [svg, png] = await Promise.all([renderer.svg(elements, LIGHT), renderer.png(elements, { ...LIGHT, scale: 2 })]);
    await writeFile(join(OUT_DIR, "sample.png"), png);

    expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    const expected = svgDimensions(svg);
    const actual = pngDimensions(png);
    expect(Math.abs(actual.width - expected.width * 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(actual.height - expected.height * 2)).toBeLessThanOrEqual(2);
  });
});

// The copy an agent is handed: as large as Claude Code passes through whole, and never at the cost of the file.
describe("[browser] preview", () => {
  let renderer: Renderer;

  beforeAll(async () => {
    renderer = await createBrowserRenderer();
  });

  afterAll(async () => {
    await renderer?.close();
  });

  for (const file of specFiles) {
    it(`fits the preview of ${file} into 2000 pixels a side, filling them when it has to shrink, with the scene and its files`, async () => {
      const { excalidraw, png, preview } = await sketch(readSpec(file), renderer, { preview: true });

      const full = pngSize(png);
      const shown = pngSize(preview!.png);
      if (Math.max(full.width, full.height) <= 2000) {
        expect(preview!.png).toBe(png);
        expect(preview!.scale).toBe(2);
      } else {
        expect(Math.max(shown.width, shown.height)).toBeLessThanOrEqual(2000);
        expect(Math.max(shown.width, shown.height)).toBeGreaterThanOrEqual(1999);
        expect(preview!.scale).toBeLessThan(2);
      }
      expect(embeddedScene(preview!.png)?.files).toEqual(JSON.parse(excalidraw).files);
    });
  }

  // The embedded scene is the one thing in these files that restore could stamp with a clock, so a real sketch, not
  // a hand-made scene, has to come out the same twice. Images are drawn once each has loaded, so one with icons too.
  it.each(["examples/order-pipeline.json", "examples/icons.json"])("renders the SVG and PNG of %s, light and dark, byte for byte the same twice", async (file) => {
    const spec = readSpec(file);

    const [first, second] = [await sketch(spec, renderer, { theme: "both" }), await sketch(spec, renderer, { theme: "both" })];

    expect(second.svg).toBe(first.svg);
    expect(second.dark!.svg).toBe(first.dark!.svg);
    expect(Buffer.from(second.png).equals(Buffer.from(first.png))).toBe(true);
    expect(Buffer.from(second.dark!.png).equals(Buffer.from(first.dark!.png))).toBe(true);
  });

  it("leaves the PNG it writes to disk as it is without a preview", async () => {
    const spec = readSpec("stress/multi-region-lr.json");
    const out = join(await mkdtemp(join(tmpdir(), "excalix-preview-")), "diagram");

    const { result } = await writeSketch(spec, out, renderer, { preview: true });

    expect(pngSize(result.preview!.png).width).toBe(2000);
    expect((await readFile(`${out}.png`)).equals((await sketch(spec, renderer)).png)).toBe(true);
  });
});

// Every glyph here must come from a font excalix ships, never from the host, or the label measures differently on
// macOS and Linux.
const PINNED_LABELS = [
  "Ünïcödé Ελληνικά Привет",
  "日本語 한국어 中文",
  "deploy 🚀 ✅ ⚡ 👍🏽 🇳🇴 🗄️ 👩‍💻",
  "→ ⇒ ✓ ✔ ✗ ★ ☁ ⚙ ⚠ ➜ ⟶",
  "☁️ ✔️ ⚙️ ⚠️ ❤️ ↔️ 1️⃣ #️⃣ ©️",
  "≤ ≥ ≠ ∞ ┌─┐ │ └─┘",
  "שלום مرحبا",
];

/** No shipped face covers Thai, so the host draws it: the control that shows a host font gets caught. */
const HOST_LABEL = "สวัสดี";

interface PlatformFont {
  familyName: string;
  isCustomFont: boolean;
  glyphCount: number;
}

/** Appends one line per text in Excalidraw's own font stack, with every face it needs loaded. */
async function showLines(page: Page, texts: string[]): Promise<void> {
  await page.evaluate(
    async ({ texts, font }) => {
      await Promise.all(texts.map((text) => document.fonts.load(font, text)));
      for (const text of texts) {
        const line = document.createElement("div");
        line.style.font = font;
        line.style.whiteSpace = "pre";
        line.textContent = text;
        document.body.append(line);
      }
    },
    { texts, font: `20px ${EXCALIFONT_STACK}` },
  );
}

/** The fonts Chromium drew each matching node with, as DevTools reports them. */
async function platformFonts(page: Page, selector: string): Promise<PlatformFont[][]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
  const drawn: PlatformFont[][] = [];
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    drawn.push(fonts.map(({ familyName, isCustomFont, glyphCount }) => ({ familyName, isCustomFont, glyphCount })));
  }
  await cdp.detach();
  return drawn;
}

function byFamily(fonts: PlatformFont[]): PlatformFont[] {
  return [...fonts].sort((a, b) => a.familyName.localeCompare(b.familyName));
}

/** Every character a unicode-range names, less the line and paragraph separators, which a browser breaks on instead of drawing. */
function characters(unicodeRange: string): string[] {
  return codePointRanges(unicodeRange)
    .flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, offset) => String.fromCodePoint(from + offset)))
    .filter((char) => !/[\p{Zl}\p{Zp}]/u.test(char));
}

function overlaps(a: [number, number][], b: [number, number][]): boolean {
  return a.some(([from, to]) => b.some(([start, end]) => from <= end && start <= to));
}

describe("[browser] pinned fallback fonts", () => {
  let browser: Browser;
  let renderer: Renderer;

  beforeAll(async () => {
    [browser, renderer] = await Promise.all([chromium.launch(), createBrowserRenderer()]);
  });

  afterAll(async () => {
    await Promise.all([browser?.close(), renderer?.close()]);
  });

  it("draws every glyph of a non-Latin label from a font excalix ships, and Thai from the host", async () => {
    const page = await openRenderPage(browser);
    await showLines(page, [...PINNED_LABELS, HOST_LABEL]);
    const hostFamilies = (await platformFonts(page, "body > div")).map((fonts) =>
      fonts.filter((font) => !font.isCustomFont).map((font) => font.familyName),
    );

    expect(hostFamilies.slice(0, -1)).toEqual(PINNED_LABELS.map(() => []));
    expect(hostFamilies.at(-1)).not.toEqual([]);
  });

  it("joins an emoji sequence into one glyph, U+FE0F in its spelling or not", async () => {
    const sequences = ["👍🏽", "☝🏽", "🇳🇴", "👩‍💻", "👨‍👩‍👧", "🏃‍♂️", "🏃‍♂", "🧑‍⚕️", "❤️‍🔥", "❤‍🔥", "🏳️‍🌈", "👁️‍🗨️", "1️⃣", "#️⃣", "☁️"];
    const page = await openRenderPage(browser);
    await showLines(page, sequences);
    const drawn = (await platformFonts(page, "body > div")).map((fonts) => fonts.map(({ familyName, glyphCount }) => `${familyName} x${glyphCount}`));

    expect(Object.fromEntries(sequences.map((sequence, index) => [sequence, drawn[index]]))).toEqual(
      Object.fromEntries(sequences.map((sequence) => [sequence, ["Twemoji Mozilla x1"]])),
    );
  });

  it("draws every code point a pinned face claims from that face, and a sequence base as emoji before U+FE0F, as text on its own", async () => {
    const [twemoji, dejavu] = await pinnedFaces();
    const page = await openRenderPage(browser);
    await showLines(page, [
      characters(twemoji!.unicodeRange).join(""),
      characters(twemoji!.sequenceRange!).join("\u{fe0f}") + "\u{fe0f}",
      characters(dejavu!.unicodeRange).join(""),
      characters(twemoji!.sequenceRange!).join(" "),
    ]);
    // A host font of the same name would pass by name alone, so each line must also come from a shipped face.
    const families = (await platformFonts(page, "body > div")).map((fonts) =>
      fonts.map((font) => `${font.familyName}${font.isCustomFont ? "" : " (host)"}`).sort(),
    );

    expect(families).toEqual([["Twemoji Mozilla"], ["Twemoji Mozilla"], ["DejaVu Sans"], ["DejaVu Sans", "Excalifont"]]);
  });

  // pinnedFontFaceRules picks a face per cluster without a browser, so its rule has to agree with what the page draws:
  // a symbol drawn as text needs its glyph in the SVG, and one drawn as emoji is left to the viewer.
  it("embeds a symbol's text glyph exactly where the page draws the symbol from DejaVu", async () => {
    const texts = ["☁", "☁️", "☁⃣", "☝🏽", "❤‍🔥", "🏃‍♂", "🏳‍⚧", "☁‍🔥", "✔‍✔️", "☁‍☁", "♂‍♀", "✔‍x", "→‍🔥"];
    const page = await openRenderPage(browser);
    await showLines(page, texts);
    const drawn = await platformFonts(page, "body > div");
    const embedded = await Promise.all(texts.map(async (text) => (await pinnedFontFaceRules([text])).length > 0));

    expect(Object.fromEntries(texts.map((text, index) => [text, embedded[index]]))).toEqual(
      Object.fromEntries(texts.map((text, index) => [text, drawn[index]!.some((font) => font.familyName === "DejaVu Sans")])),
    );
  });

  it("embeds the pinned glyphs an SVG draws, so it renders the same in a browser without them", async () => {
    const text = "api → ✓ ☁ ⚙ ≤ ┌─┐ Ελληνικά שלום مرحبا";
    const [size] = await renderer.measurer.measure([text], 20);
    const svg = await renderer.svg(scene(text, size!), LIGHT);
    const page = await openRenderPage(browser);
    await showLines(page, [text]);
    const [measured] = await platformFonts(page, "body > div");

    const viewer = await browser.newPage();
    await viewer.setContent(svg);
    await viewer.evaluate(async () => {
      const loads: Promise<FontFace>[] = [];
      document.fonts.forEach((face) => loads.push(face.load()));
      await Promise.all(loads);
    });
    const [drawn] = await platformFonts(viewer, "svg text");

    expect(byFamily(drawn!)).toEqual(byFamily(measured!));
    expect(drawn!.every((font) => font.isCustomFont)).toBe(true);
  });

  it("embeds only the glyphs drawn as text, byte for byte the same each time, and leaves color emoji to the viewer", async () => {
    const text = "deploy 🚀 ☁️ 1️⃣ ☁ → ✓";
    const [size] = await renderer.measurer.measure([text], 20);
    const first = await renderer.svg(scene(text, size!), LIGHT);
    const second = await renderer.svg(scene(text, size!), LIGHT);
    const pinnedRanges = [...first.matchAll(/font-family: Xiaolai; src: url\(data:font\/ttf;base64,[\w+/=]+\); unicode-range: ([^;]+);/g)];

    expect(pinnedRanges.map(([, range]) => range)).toEqual(["U+2192,U+2601,U+2713"]);
    expect(second).toBe(first);
  });

  // Within a family the last declared face wins an overlap, so only clear ranges leave the bundle's drawing as it was.
  // A sequence range overlaps Excalifont on purpose: that family comes first in the stack and has the plain digit.
  it("keeps the pinned ranges clear of the bundle's own faces and of each other", async () => {
    const pinned = await pinnedFaces();
    const page = await openRenderPage(browser);
    const loaded = await page.evaluate(() => {
      const faces: { family: string; unicodeRange: string }[] = [];
      document.fonts.forEach((face) => faces.push({ family: face.family, unicodeRange: face.unicodeRange }));
      return faces;
    });
    const bundled = loaded.slice(0, -pinned.length);
    const bundledRanges = (family: string) => bundled.filter((face) => face.family === family).map((face) => codePointRanges(face.unicodeRange));
    const clashes = pinned.flatMap((face) => {
      const own = codePointRanges(face.unicodeRange);
      const drawn = face.sequenceRange ? [...own, ...codePointRanges(face.sequenceRange)] : own;
      return [
        ...bundledRanges("Excalifont").filter((ranges) => overlaps(own, ranges)).map(() => `${face.file} and Excalifont`),
        ...bundledRanges("Xiaolai").filter((ranges) => overlaps(drawn, ranges)).map(() => `${face.file} and Xiaolai`),
        ...pinned.filter((other) => other !== face && overlaps(own, codePointRanges(other.unicodeRange))).map((other) => `${face.file} and ${other.file}`),
      ];
    });

    expect(loaded.slice(-pinned.length).map((face) => face.family)).toEqual(pinned.map(() => PINNED_FAMILY));
    expect(bundledRanges("Excalifont").length).toBeGreaterThan(0);
    expect(clashes).toEqual([]);
  });
});

/** Whether each file decodes as an image in the page: both exports draw nothing, or a grey placeholder, for one that does not. */
async function decodeInPage(dataURLs: string[]): Promise<{ width: number; height: number }[]> {
  return Promise.all(
    dataURLs.map(
      (src) =>
        new Promise<{ width: number; height: number }>((resolve) => {
          const image = new Image();
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
          image.onerror = () => resolve({ width: 0, height: 0 });
          image.src = src;
        }),
    ),
  );
}

/** The darkest and the lightest pixel in each box of a PNG, as grey levels, the mean of the three channels. */
async function extremesInPage({ base64, boxes }: { base64: string; boxes: { x: number; y: number; width: number; height: number }[] }) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  return boxes.map(({ x, y, width, height }) => {
    const { data } = context.getImageData(x, y, width, height);
    let darkest = 255;
    let lightest = 0;
    for (let i = 0; i < data.length; i += 4) {
      const grey = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      darkest = Math.min(darkest, grey);
      lightest = Math.max(lightest, grey);
    }
    return { darkest, lightest };
  });
}

describe("[browser] icons", () => {
  let renderer: Renderer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    renderer = await createBrowserRenderer();
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await renderer?.close();
  });

  it("decodes every icon in the catalog at its 24px size", async () => {
    const dataURLs = ICON_NAMES.map((name) => `data:image/svg+xml;base64,${Buffer.from(iconSvg(name)).toString("base64")}`);

    const sizes = await page.evaluate(decodeInPage, dataURLs);

    expect(Object.fromEntries(sizes.map((size, i) => [ICON_NAMES[i], size]))).toEqual(
      Object.fromEntries(ICON_NAMES.map((name) => [name, { width: 24, height: 24 }])),
    );
  });

  // A dark export darkens every colour in the scene but an image's own, except that it draws an SVG file through the
  // same transform, so an icon in the label colour stays in the label colour on #121212.
  it("draws an icon in the colour of its label, light and dark", async () => {
    const spec = { nodes: [{ id: "db", label: "Users DB", kind: "external", icon: "database" }] };
    const { excalidraw, png, svg, dark } = await sketch(spec, renderer, { theme: "both" });
    const elements = JSON.parse(excalidraw).elements as ExcalidrawElement[];
    const [, label, icon] = elements;
    // The layout puts the scene at the origin and the export pads it 24px, at 2 PNG pixels a scene pixel.
    const inPng = ({ x, y, width, height }: ExcalidrawElement) => ({ x: (x + 24) * 2, y: (y + 24) * 2, width: width * 2, height: height * 2 });
    const boxes = [inPng(label!), inPng(icon!)];

    const [lightLabel, lightIcon] = await page.evaluate(extremesInPage, { base64: Buffer.from(png).toString("base64"), boxes });
    const [darkLabel, darkIcon] = await page.evaluate(extremesInPage, { base64: Buffer.from(dark!.png).toString("base64"), boxes });

    expect(Math.abs(lightIcon!.darkest - lightLabel!.darkest)).toBeLessThanOrEqual(4);
    expect(lightIcon!.darkest).toBeLessThan(40);
    expect(Math.abs(darkIcon!.lightest - darkLabel!.lightest)).toBeLessThanOrEqual(4);
    expect(darkIcon!.lightest).toBeGreaterThan(190);
    expect(svg).toContain('<use href="#image-');
    expect(svg).not.toContain("filter=");
    expect(dark!.svg).toMatch(/<g filter="url\(#excalix-dark-image\)" transform="[^"]+"><use href="#image-/);
    expect(dark!.svg.match(/<filter id="excalix-dark-image"/g)).toHaveLength(1);
    expect(dark!.svg).not.toContain("invert(");
  });

  // The SVGs are read as images too, a dark one through the <picture> the markdown writes. WebKit ignores a CSS filter
  // function in an SVG filter attribute, which is what the export puts on each image.
  it("draws an icon in the colour of its label in an SVG shown in WebKit, light and dark", async () => {
    const spec = { nodes: [{ id: "db", label: "Users DB", kind: "external", icon: "database" }] };
    const { excalidraw, svg, dark } = await sketch(spec, renderer, { theme: "both" });
    const [, label, icon] = JSON.parse(excalidraw).elements as ExcalidrawElement[];
    const inSvg = ({ x, y, width, height }: ExcalidrawElement) => ({ x: x + 24, y: y + 24, width, height });
    const boxes = [inSvg(label!), inSvg(icon!)];
    const safari = await webkit.launch();
    try {
      const shown = async (markup: string) => {
        const [, width, height] = markup.match(/width="(\d+)" height="(\d+)"/)!.map(Number);
        const tab = await safari.newPage({ viewport: { width: width!, height: height! } });
        await tab.setContent(`<body style="margin:0"><img src="data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}"></body>`);
        await tab.locator("img").evaluate((image: HTMLImageElement) => image.decode());
        return (await tab.screenshot()).toString("base64");
      };

      const [lightLabel, lightIcon] = await page.evaluate(extremesInPage, { base64: await shown(svg), boxes });
      const [darkLabel, darkIcon] = await page.evaluate(extremesInPage, { base64: await shown(dark!.svg), boxes });

      // WebKit draws a filtered icon a few levels lighter than its label, by how many depends on the platform (6 on
      // macOS, 2 on Linux); an icon the filter misses is about 180 off.
      expect(Math.abs(lightIcon!.darkest - lightLabel!.darkest)).toBeLessThanOrEqual(12);
      expect(lightIcon!.darkest).toBeLessThan(40);
      expect(Math.abs(darkIcon!.lightest - darkLabel!.lightest)).toBeLessThanOrEqual(12);
      expect(darkIcon!.lightest).toBeGreaterThan(190);
    } finally {
      await safari.close();
    }
  });
});
