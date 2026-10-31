import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExcalidrawElement, ExcalidrawTextElement } from "excalidraw-types/element/src/types";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lineHeight, localPoint, radians } from "../elements.js";
import { fractionalIndex } from "../fractional-index.js";
import { pngSize, sketch, writeSketch } from "../pipeline.js";
import { embeddedScene, pngChunks, readSpec, specFiles } from "../test-support.js";
import type { Renderer } from "../types.js";
import { createBrowserRenderer, launchBrowser, openRenderPage } from "./browser.js";
import { codePointRanges, PINNED_FAMILY, pinnedFaces, pinnedFontFaceRules } from "./pinned-fonts.js";

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

  it("embeds the scene without changing a pixel", async () => {
    // The renderer's own launch flags: without them Linux hints glyphs differently and no pixel comparison holds.
    const browser = await launchBrowser();
    try {
      const page = await openRenderPage(browser);
      const plain = new Uint8Array(await page.evaluate(plainPngInPage, elements));
      const embedded = await renderer.png(elements, { scale: 2 });

      const idat = (png: Uint8Array) => Buffer.concat(pngChunks(png).flatMap(({ type, data }) => (type === "IDAT" ? [data] : [])));
      expect(pngChunks(embedded).map(({ type }) => type)).toEqual([...pngChunks(plain).map(({ type }) => type).slice(0, -1), "tEXt", "IEND"]);
      expect(idat(embedded).equals(idat(plain))).toBe(true);
      // Restore fills in a field or two these hand-made elements leave out; file-load.test.ts holds a sketch's to the byte.
      const ids = (scene: { elements: unknown[] } | undefined) => scene?.elements.map((element) => (element as { id: string }).id);
      expect(ids(embeddedScene(embedded))).toEqual(elements.map((element) => element.id));
      expect(ids(embeddedScene(await renderer.svg(elements)))).toEqual(elements.map((element) => element.id));
    } finally {
      await browser.close();
    }
  });

  it("exports a PNG at 2x the SVG size", async () => {
    const [svg, png] = await Promise.all([renderer.svg(elements), renderer.png(elements, { scale: 2 })]);
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
    it(`fits the preview of ${file} into 2000 pixels a side, filling them when it has to shrink`, async () => {
      const { png, preview } = await sketch(readSpec(file), renderer, { preview: true });

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
    });
  }

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
    const svg = await renderer.svg(scene(text, size!));
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
    const first = await renderer.svg(scene(text, size!));
    const second = await renderer.svg(scene(text, size!));
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
