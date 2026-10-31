import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ExcalidrawElement, ExcalidrawTextElement } from "excalidraw-types/element/src/types";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sketch } from "../pipeline.js";
import { EDGE_LABEL_WIDTH, FONT } from "../style.js";
import { embeddedScene, measuringOnly, readSpec, specFiles } from "../test-support.js";
import type { Point, Renderer } from "../types.js";
import { wrapTexts } from "../wrap.js";
import { createBrowserRenderer, launchBrowser, openRenderPage } from "./browser.js";
import { estimateMeasurer } from "./estimate.js";

const ORIGIN = "http://excalix.local";
const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="module">
  try {
    window.excalix = { editor: await import("/editor.js") };
  } catch (error) {
    window.excalix = { error: String(error) };
  }
</script>`;

interface EditorWindow {
  excalix: {
    editor: { loadFromBlob(blob: Blob, localAppState: null, localElements: null): Promise<{ elements: unknown[] }> };
    error?: string;
  };
}

interface Scene {
  getElement(id: string): ExcalidrawElement | null;
  getNonDeletedElements(): readonly ExcalidrawElement[];
}

/** The slice of @excalidraw/element these checks call, the code the editor runs on an element as it moves. */
interface ElementWindow {
  excalidrawElement: {
    Scene: new (elements: ExcalidrawElement[]) => Scene;
    dragSelectedElements(
      pointerDownState: { originalElements: Map<string, ExcalidrawElement> },
      selected: ExcalidrawElement[],
      offset: Point,
      scene: Scene,
      snapOffset: Point,
      gridSize: null,
    ): void;
    getBoundTextMaxWidth(container: ExcalidrawElement, text: ExcalidrawTextElement): number;
    getFontString(text: ExcalidrawTextElement): string;
    setCustomTextMetricsProvider(provider: { getLineWidth(text: string, font: string): number }): void;
    wrapText(text: string, font: string, maxWidth: number): string;
  };
}

interface Rewrapped {
  id: string;
  asIs: string;
  narrowest?: string;
}

/** A text as a drag left it, and which drag that was. */
interface Dragged {
  drag: string;
  id: string;
  text: string;
  originalText: string;
  width: number;
  height: number;
}

interface SourceMap {
  sources: string[];
  sourcesContent?: (string | null)[];
}

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const DATA_SOURCE = /^(?!.*node_modules).*\bdata\/(restore|blob)\.ts$/;
// The element code restore calls into: binding repair, fractional indices, bound text, version bumps.
const ELEMENT_FILES = "binding|fractionalIndex|mutateElement|textElement";
const BUNDLED_ELEMENT_SOURCE = new RegExp(`^(?!.*node_modules).*\\belement/src/(${ELEMENT_FILES})\\.ts$`);
const ELEMENT_SOURCE = new RegExp(`^(?:\\.\\./)+src/(${ELEMENT_FILES})\\.ts$`);

/** The editor's own loadFromBlob, bundled with its dependencies so the page needs nothing but this origin. */
async function bundleEditor(): Promise<Uint8Array> {
  const result = await build({
    stdin: { contents: `export { loadFromBlob } from "@excalidraw/excalidraw";`, resolveDir: here },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    // React picks its build from process.env.NODE_ENV, which a page has no process to read from.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  const [bundle] = result.outputFiles;
  if (!bundle) throw new Error("esbuild produced no bundle");
  return bundle.contents;
}

/** The editor's element code, what it runs on a bound text whenever its container moves or resizes, as one script. */
async function bundleElement(): Promise<string> {
  const result = await build({
    stdin: {
      contents: [
        `export { Scene, dragSelectedElements, getBoundTextMaxWidth, setCustomTextMetricsProvider, wrapText } from "@excalidraw/element";`,
        `export { getFontString } from "@excalidraw/common";`,
      ].join("\n"),
      // pnpm links the editor's own packages beside it and nowhere a test file could resolve them from.
      resolveDir: dirname(require.resolve("@excalidraw/excalidraw")),
    },
    bundle: true,
    format: "iife",
    globalName: "excalidrawElement",
    write: false,
    logLevel: "silent",
  });
  const [bundle] = result.outputFiles;
  if (!bundle) throw new Error("esbuild produced no bundle");
  return bundle.text;
}

/** Points the editor's text measuring at the estimate's metric: 0.6 of the font size for every UTF-16 code unit. */
function measureAsEstimated(): void {
  const { setCustomTextMetricsProvider } = (window as unknown as ElementWindow).excalidrawElement;
  setCustomTextMetricsProvider({ getLineWidth: (text, font) => text.length * parseFloat(font) * 0.6 });
}

function wrapInPage({ texts, font, maxWidth }: { texts: string[]; font: string; maxWidth: number }): string[] {
  const { wrapText } = (window as unknown as ElementWindow).excalidrawElement;
  return texts.map((text) => wrapText(text, font, maxWidth));
}

/**
 * The lines the editor wraps each bound text to when its container changes: dragging a node re-wraps the labels of
 * its arrows, and a resize re-wraps its own. An arrow is tried as it is and at its narrowest, where the wrap width
 * reaches its floor. The editor loads the fonts of every text in a scene it opens, so the page does too.
 */
async function rewrapInPage(elements: ExcalidrawElement[]): Promise<Rewrapped[]> {
  const { wrapText, getBoundTextMaxWidth, getFontString } = (window as unknown as ElementWindow).excalidrawElement;
  const texts = elements.filter((element) => element.type === "text");
  await Promise.all(texts.map((text) => document.fonts.load(getFontString(text), text.text)));
  const byId = new Map(elements.map((element) => [element.id, element]));
  return texts.flatMap((text) => {
    const container = text.containerId ? byId.get(text.containerId) : undefined;
    if (!container) return [];
    const rewrap = (shape: ExcalidrawElement) => wrapText(text.originalText, getFontString(text), getBoundTextMaxWidth(shape, text));
    return [{ id: text.id, asIs: rewrap(container), ...(container.type === "arrow" ? { narrowest: rewrap({ ...container, width: 0 }) } : {}) }];
  });
}

/**
 * Every text after each drag the editor makes of a node with arrows: of the node alone, as once its group is entered,
 * and of the outermost group around it, as a plain click selects it. Each is moved four ways and onto every node it
 * has an arrow to, which shrinks that arrow to its narrowest. dragSelectedElements is what the editor calls on every
 * pointer move, with the elements as they were at pointer down, so each drag starts from a fresh copy of the file;
 * opening the file leaves every element as written, which the file load check proves.
 */
async function dragInPage(json: string): Promise<Dragged[]> {
  const { Scene, dragSelectedElements, getFontString } = (window as unknown as ElementWindow).excalidrawElement;
  const fresh = () => (JSON.parse(json) as { elements: ExcalidrawElement[] }).elements;
  const elements = fresh();
  const texts = elements.filter((element) => element.type === "text");
  await Promise.all(texts.map((text) => document.fonts.load(getFontString(text), text.text)));
  const byId = new Map(elements.map((element) => [element.id, element]));
  const ends = elements.flatMap((element) =>
    element.type === "arrow" && element.startBinding && element.endBinding ? [[element.startBinding.elementId, element.endBinding.elementId]] : [],
  );
  const dragged: Dragged[] = [];
  for (const node of elements.filter((element) => element.boundElements?.some((bound) => bound.type === "arrow"))) {
    const outermost = node.groupIds[node.groupIds.length - 1];
    const selections = [[node.id], ...(outermost ? [elements.filter((e) => e.groupIds.includes(outermost)).map((e) => e.id)] : [])];
    const neighbours = ends.flatMap((pair) => (pair.includes(node.id) ? pair.filter((id) => id !== node.id) : []));
    const offsets = [
      { x: 400, y: 0 },
      { x: -400, y: 0 },
      { x: 0, y: 400 },
      { x: 0, y: -400 },
      ...neighbours.flatMap((id) => {
        const other = byId.get(id);
        return other ? [{ x: other.x - node.x, y: other.y - node.y }] : [];
      }),
    ];
    for (const ids of selections) {
      for (const offset of offsets) {
        const scene = new Scene(fresh());
        const selected = ids.flatMap((id) => scene.getElement(id) ?? []);
        dragSelectedElements({ originalElements: byId }, selected, offset, scene, { x: 0, y: 0 }, null);
        const drag = `${node.id}${ids.length > 1 ? " with its group" : ""} by ${offset.x},${offset.y}`;
        for (const text of scene.getNonDeletedElements()) {
          if (text.type !== "text") continue;
          const { id, originalText, width, height } = text;
          dragged.push({ drag, id, text: text.text, originalText, width, height });
        }
      }
    }
  }
  return dragged;
}

async function openEditorPage(browser: Browser): Promise<Page> {
  const editor = Buffer.from(await bundleEditor());
  const page = await browser.newPage();
  // Anything off this origin is aborted, which is what keeps the load path offline.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: PAGE });
    if (url.pathname === "/editor.js") return route.fulfill({ contentType: "text/javascript", body: editor });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => "excalix" in window);
  const loadError = await page.evaluate(() => (window as unknown as EditorWindow).excalix.error);
  if (loadError) throw new Error(`@excalidraw/excalidraw failed to load: ${loadError}`);
  return page;
}

/** What opening the file does to its elements: loadFromBlob restores them with repairBindings and deleteInvisibleElements. */
async function loadInPage({ json, type }: { json: string; type: string }): Promise<unknown[]> {
  const { editor } = (window as unknown as EditorWindow).excalix;
  return (await editor.loadFromBlob(new Blob([json], { type }), null, null)).elements;
}

/** What dropping an exported image on the editor does: loadFromBlob finds the scene inside it and restores that. */
async function loadImageInPage({ base64, type }: { base64: string; type: string }): Promise<unknown[]> {
  const { editor } = (window as unknown as EditorWindow).excalix;
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return (await editor.loadFromBlob(new Blob([bytes], { type }), null, null)).elements;
}

/** The sources matching pattern in the development sourcemaps of the package at entry, keyed prefix/name. */
async function sourcesOf(entry: string, pattern: RegExp, prefix: string): Promise<Record<string, string>> {
  const dir = join(dirname(entry), "../dev");
  const sources: Record<string, string> = {};
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".js.map"))) {
    const map = JSON.parse(await readFile(join(dir, name), "utf8")) as SourceMap;
    map.sources.forEach((source, i) => {
      const file = pattern.exec(source)?.[1];
      const content = map.sourcesContent?.[i];
      if (file && content) sources[`${prefix}/${file}`] = content;
    });
  }
  return sources;
}

// The editor is a separate package from the bundle that renders, and only matches it when it is the build the
// bundle was cut from. Against any other build the round trip below proves nothing about the files excalix writes.
describe("Excalidraw editor build", () => {
  it("loads files with the code the @excalidraw/utils bundle carries", async () => {
    const utils = require.resolve("@excalidraw/utils");
    const editorEntry = require.resolve("@excalidraw/excalidraw");
    // The element package the editor itself resolves, not whichever copy sits at the top of node_modules.
    const element = require.resolve("@excalidraw/element", { paths: [dirname(editorEntry)] });
    const [bundleData, bundleElement, editorData, editorElement] = await Promise.all([
      sourcesOf(utils, DATA_SOURCE, "data"),
      sourcesOf(utils, BUNDLED_ELEMENT_SOURCE, "element"),
      sourcesOf(editorEntry, DATA_SOURCE, "data"),
      sourcesOf(element, ELEMENT_SOURCE, "element"),
    ]);
    const bundle = { ...bundleData, ...bundleElement };
    const editor = { ...editorData, ...editorElement };

    expect(Object.keys(bundle).sort()).toEqual([
      "data/blob",
      "data/restore",
      "element/binding",
      "element/fractionalIndex",
      "element/mutateElement",
      "element/textElement",
    ]);
    expect(editor, "pin @excalidraw/excalidraw to the build @excalidraw/utils was cut from").toEqual(bundle);
  });
});

describe("[browser] Excalidraw file load", () => {
  let renderer: Renderer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    renderer = await createBrowserRenderer();
    browser = await chromium.launch();
    page = await openEditorPage(browser);
  });

  afterAll(async () => {
    await browser?.close();
    await renderer?.close();
  });

  for (const file of specFiles) {
    it(`opens ${file} with every element as written`, async () => {
      const { excalidraw } = await sketch(readSpec(file), measuringOnly(renderer.measurer));
      const written = JSON.parse(excalidraw).elements as ExcalidrawElement[];

      const loaded = (await page.evaluate(loadInPage, { json: excalidraw, type: EXCALIDRAW_MIME })) as ExcalidrawElement[];

      expect(loaded).toEqual(written);
      // Key order too: the editor saves what it loaded, so an open-then-save should leave the file byte-identical.
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(written));
    });
  }
});

describe("[browser] Excalidraw image load", () => {
  let renderer: Renderer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    renderer = await createBrowserRenderer();
    browser = await chromium.launch();
    page = await openEditorPage(browser);
  });

  afterAll(async () => {
    await browser?.close();
    await renderer?.close();
  });

  // The two formats embed different appState, so the elements are what has to come back as written.
  for (const file of specFiles.filter((file) => file.startsWith("examples/"))) {
    it(`reopens the SVG and the PNG of ${file} as the elements of its .excalidraw`, async () => {
      const { excalidraw, svg, png } = await sketch(readSpec(file), renderer);
      const written = JSON.stringify(JSON.parse(excalidraw).elements);

      const fromSvg = await page.evaluate(loadImageInPage, { base64: Buffer.from(svg).toString("base64"), type: "image/svg+xml" });
      const fromPng = await page.evaluate(loadImageInPage, { base64: Buffer.from(png).toString("base64"), type: "image/png" });

      expect(JSON.stringify(fromSvg)).toBe(written);
      expect(JSON.stringify(fromPng)).toBe(written);
      expect(embeddedScene(svg)?.source).toBe("excalix");
      expect(embeddedScene(png)?.source).toBe("excalix");
    });
  }
});

// Every kind of break the editor makes: between words, after a hyphen, between brackets, inside a dotted name and a
// URL, between CJK characters, around emoji, at the author's own line breaks, and none inside a run of spaces.
const LABELS = [
  "places an order with the cart contents and the payment token",
  "emits com.example.orders.OrderCreated to the bus",
  "GET https://api.example.com/v2/orders/{orderId}/line-items",
  "s3://bucket-name/some/very/long/object/key/path.parquet",
  "fan-out to the order-service and the billing-service workers",
  "POST  /exports   with   the   nightly   batch",
  "writes the order\nand its line items in one transaction",
  "注文を作成して、在庫サービスに「予約」を依頼する",
  "下单后通知库存服务预留商品并发送确认邮件给用户",
  "order confirmed 📦 send the receipt email",
  "👨‍👩‍👧 family plan 🇳🇴🇸🇪🇩🇰 nordic launch 👍🏽 approved",
];

describe("[browser] Excalidraw re-wrap", () => {
  let renderer: Renderer;
  let browser: Browser;
  let page: Page;
  let estimating: Page;

  beforeAll(async () => {
    const element = await bundleElement();
    renderer = await createBrowserRenderer();
    browser = await launchBrowser();
    page = await openRenderPage(browser);
    await page.addScriptTag({ content: element });
    estimating = await browser.newPage();
    await estimating.addScriptTag({ content: element });
    await estimating.evaluate(measureAsEstimated);
  });

  afterAll(async () => {
    await browser?.close();
    await renderer?.close();
  });

  // One metric on both sides, so any difference is in where a line breaks and not in how wide a browser draws it.
  it("breaks every label where the editor's wrapText breaks it", async () => {
    for (const maxWidth of [EDGE_LABEL_WIDTH, FONT.edge * 11]) {
      const ours = await wrapTexts(LABELS, FONT.edge, maxWidth, estimateMeasurer);
      const editors = await estimating.evaluate(wrapInPage, { texts: LABELS, font: `${FONT.edge}px Excalifont`, maxWidth });
      expect(ours).toEqual(editors);
    }
  });

  for (const file of specFiles) {
    it(`keeps every bound text in ${file} on its lines when its container changes`, async () => {
      const { excalidraw } = await sketch(readSpec(file), measuringOnly(renderer.measurer));
      const elements = JSON.parse(excalidraw).elements as ExcalidrawElement[];

      const rewrapped = await page.evaluate(rewrapInPage, elements);

      const types = new Map(elements.map((element) => [element.id, element.type]));
      const written = elements.flatMap((text) =>
        text.type === "text" && text.containerId
          ? [{ id: text.id, asIs: text.text, ...(types.get(text.containerId) === "arrow" ? { narrowest: text.text } : {}) }]
          : [],
      );
      expect(rewrapped).toEqual(written);
    });

    it(`keeps every text in ${file} as written when a node is dragged`, async () => {
      const { excalidraw } = await sketch(readSpec(file), measuringOnly(renderer.measurer));
      const elements = JSON.parse(excalidraw).elements as ExcalidrawElement[];
      const written = new Map(elements.flatMap((text) => (text.type === "text" ? [[text.id, text] as const] : [])));

      const dragged = await page.evaluate(dragInPage, excalidraw);

      expect(dragged.length > 0).toBe(elements.some((element) => element.type === "arrow"));
      // The editor keeps the width it measures, and the file stores that width rounded up to the whole pixel.
      const changed = dragged.filter(({ id, text, originalText, width, height }) => {
        const before = written.get(id);
        return text !== before?.text || originalText !== before.originalText || height !== before.height || Math.ceil(width) !== before.width;
      });
      expect(changed).toEqual([]);
    });
  }
});
