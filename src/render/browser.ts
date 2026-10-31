import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { FONT } from "../style.js";
import type { AnimationPlan, ExportOptions, Renderer, SceneFiles, TextSize } from "../types.js";
import { fontsDir, PINNED_FAMILY, pinnedFaces, pinnedFontFaceRules } from "./pinned-fonts.js";

const ORIGIN = "http://excalix.local";
const VENDOR_PATH = "/vendor/";
const FONTS_PATH = "/fonts/";
const PADDING = 24;

/** Fallback order the bundle's getFontString produces for Excalifont. */
const EXCALIFONT_STACK = "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

// The embedded scene names the app that wrote it, which is the page's fake origin unless the page says otherwise.
const PAGE = `<!doctype html>
<meta charset="utf-8">
<script>
  window.EXCALIDRAW_ASSET_PATH = "${VENDOR_PATH}assets/";
  window.EXCALIDRAW_EXPORT_SOURCE = "excalix";
</script>
<script type="module">
  try {
    window.excalix = { utils: await import("${VENDOR_PATH}index.js") };
  } catch (error) {
    window.excalix = { error: String(error) };
  }
</script>`;

// A dark export wraps each SVG file in a <g> whose filter attribute holds the CSS filter function in `from`. WebKit
// ignores a filter function there, so Safari would draw every icon in the light stroke colour on the dark fills. The
// same transform as an SVG filter draws alike in every browser: the table is invert(93%) as the Filter Effects spec
// expands it, and sRGB because filter functions work in sRGB while SVG filters default to linearRGB.
const DARK_IMAGE_FILTER = {
  from: "invert(93%) hue-rotate(180deg)",
  url: "url(#excalix-dark-image)",
  markup:
    '<filter id="excalix-dark-image" color-interpolation-filters="sRGB"><feComponentTransfer>' +
    '<feFuncR type="table" tableValues="0.93 0.07"/><feFuncG type="table" tableValues="0.93 0.07"/>' +
    '<feFuncB type="table" tableValues="0.93 0.07"/></feComponentTransfer><feColorMatrix type="hueRotate" values="180"/></filter>',
};

interface ExportData {
  elements: unknown[];
  appState: { exportBackground: boolean; viewBackgroundColor: string; exportEmbedScene: boolean; exportWithDarkMode: boolean };
  files: SceneFiles;
}

/** The slice of @excalidraw/utils this renderer calls; it runs inside the page against the global the bundle assigns, not against an import. */
interface Utils {
  exportToCanvas(args: { data: ExportData }): Promise<HTMLCanvasElement>;
  exportToSvg(args: { data: ExportData; config: { padding: number } }): Promise<SVGSVGElement>;
  exportToBlob(args: { data: ExportData; config: { padding: number; scale: number; mimeType: string; theme: "light" | "dark" } }): Promise<Blob>;
}

interface ExcalixWindow {
  excalix: { utils: Utils; error?: string };
}

/** A pinned face as the page loads it. */
interface PageFace {
  url: string;
  unicodeRange: string;
}

const require = createRequire(import.meta.url);
const vendorDir = dirname(require.resolve("@excalidraw/utils"));
const servedDirs: ReadonlyArray<readonly [string, string]> = [
  [VENDOR_PATH, vendorDir],
  [FONTS_PATH, fontsDir],
];
const playwrightVersion = (require("playwright-core/package.json") as { version: string }).version;

// The scene goes into the SVG and the PNG too, so either opens in Excalidraw as an editable drawing. Dark mode is
// not part of that scene, so a dark export reopens as the light drawing. What goes in is the scene after restore,
// which stamps a time and a random nonce on any element it changes, so the files stay byte-stable only while
// restore leaves a sketch's elements as they are, which restore.test.ts holds it to. The files go into the scene as
// they are, in either theme: a dark export draws an SVG file through the filter that darkens every other colour
// (see DARK_IMAGE_FILTER).
function exportData(elements: unknown[], files: SceneFiles, dark = false): ExportData {
  return {
    elements,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportEmbedScene: true, exportWithDarkMode: dark },
    files,
  };
}

function fontString(fontSize: number): string {
  return `${fontSize}px ${EXCALIFONT_STACK}`;
}

async function serve(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) return route.abort();
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: PAGE });
  const served = servedDirs.find(([prefix]) => url.pathname.startsWith(prefix));
  if (!served) return route.fulfill({ status: 404 });
  const [prefix, dir] = served;
  const file = resolve(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
  if (!file.startsWith(dir + sep)) return route.fulfill({ status: 404 });
  try {
    const body = await readFile(file);
    return route.fulfill({ contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream", body });
  } catch {
    return route.fulfill({ status: 404 });
  }
}

/** Opens a page on the fake origin with the @excalidraw/utils bundle loaded as window.excalix.utils. */
export async function openBundlePage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.route("**/*", serve);
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => "excalix" in window);
  const loadError = await page.evaluate(() => (window as unknown as ExcalixWindow).excalix.error);
  if (loadError) throw new Error(`@excalidraw/utils failed to load: ${loadError}`);
  return page;
}

// Linux Chromium hints glyphs and snaps their advances to whole pixels unless told otherwise, which makes every label
// a pixel or two off what macOS and the Excalidraw editor measure. Both flags are no-ops where that is already the case.
const TEXT_METRIC_FLAGS = ["--font-render-hinting=none", "--enable-font-subpixel-positioning"];

/** Starts headless Chromium with the flags that make it measure text as macOS and the editor do. */
export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ args: TEXT_METRIC_FLAGS });
  } catch (error) {
    // A browser build only matches the playwright release that asks for it, so the command names this one.
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      throw new Error(`Chromium is not installed. Run: npx -y playwright@${playwrightVersion} install chromium`);
    }
    throw error;
  }
}

/** Opens the bundle page with Excalifont and the pinned fallback faces registered, ready to measure and export. */
export async function openRenderPage(browser: Browser): Promise<Page> {
  const page = await openBundlePage(browser);
  const faces: PageFace[] = (await pinnedFaces()).map(({ file, unicodeRange, sequenceRange }) => ({
    url: `${FONTS_PATH}${file}`,
    unicodeRange: sequenceRange ? `${unicodeRange},${sequenceRange}` : unicodeRange,
  }));
  await page.evaluate(registerFonts, {
    probe: exportData([fontProbe()], {}),
    family: "Excalifont",
    pinned: { family: PINNED_FAMILY, faces },
  });
  return page;
}

/** The text of every text element, which is what the bundle's own font embedding subsets by. */
function drawnTexts(elements: unknown[]): string[] {
  return elements.flatMap((element) => {
    const { type, originalText } = element as { type?: unknown; originalText?: unknown };
    return type === "text" && typeof originalText === "string" ? [originalText] : [];
  });
}

/**
 * How far under a measured width the whole pixel above it may start. Linux adds 2^-15px to every glyph advance macOS
 * measures exactly, so ten 16px CJK glyphs, each the font size wide, measure 160.0003 there and 160 here, and rounding
 * up alone puts them on different pixels. 1/64 covers a line of 500 glyphs. A box that falls that much short of its
 * text still holds it: a node pads its label 24px a side where the editor needs 5, and an edge label wraps 16px under
 * the editor's floor.
 */
const WIDTH_SLACK = 1 / 64;

/** The whole-pixel width the layout reserves for a text measured `width` wide, the same on macOS and Linux. */
export function wholePixels(width: number): number {
  return Math.ceil(width - WIDTH_SLACK);
}

/** Starts headless Chromium with @excalidraw/utils loaded. Call close() when done. */
export async function createBrowserRenderer(): Promise<Renderer> {
  const browser = await launchBrowser();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= browser.close());
  try {
    const page = await openRenderPage(browser);

    return {
      measurer: {
        measure: async (texts, fontSize) =>
          (await page.evaluate(measureInPage, { texts, font: fontString(fontSize), fontSize, lineHeight: FONT.lineHeight })).map(
            ({ width, height }) => ({ width: wholePixels(width), height }),
          ),
      },
      svg: (elements, options) => exportSvg(page, elements, options),
      animatedSvg: (elements, { plan, ...options }) => exportSvg(page, elements, options, plan),
      async png(elements, { dark, scale, files }) {
        const theme: "light" | "dark" = dark ? "dark" : "light";
        const base64 = await page.evaluate(pngInPage, { data: exportData(elements, files, dark), padding: PADDING, scale, theme });
        return new Uint8Array(Buffer.from(base64, "base64"));
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// The SVG export takes dark mode from the appState alone and the PNG export from its config alone. The animated SVG
// is the plain one annotated, so both come from this one export.
async function exportSvg(page: Page, elements: unknown[], { dark, files }: ExportOptions, animation?: AnimationPlan): Promise<string> {
  const fontFaces = await pinnedFontFaceRules(drawnTexts(elements));
  return page.evaluate(svgInPage, {
    data: exportData(elements, files, dark),
    padding: PADDING,
    fontFaces,
    darkImageFilter: DARK_IMAGE_FILTER,
    animation,
  });
}

/** The bundle only adds its font faces to document.fonts on a canvas export, so run one before measuring. */
function fontProbe(): unknown {
  return {
    type: "text",
    id: "excalix-font-probe",
    x: 0,
    y: 0,
    width: 20,
    height: 25,
    text: "A",
    originalText: "A",
    fontSize: 20,
    fontFamily: FONT.family,
    lineHeight: FONT.lineHeight,
  };
}

async function registerFonts({
  probe,
  family,
  pinned,
}: {
  probe: ExportData;
  family: string;
  pinned: { family: string; faces: PageFace[] };
}): Promise<void> {
  const { utils } = (window as unknown as ExcalixWindow).excalix;
  await utils.exportToCanvas({ data: probe });
  let registered = false;
  document.fonts.forEach((face) => {
    registered ||= face.family === family && face.status === "loaded";
  });
  if (!registered) throw new Error(`${family} did not register in document.fonts`);
  // Left unloaded: document.fonts.load, in measureInPage and in the bundle's exports, fetches a face only once a text
  // has a code point in its range. The emoji face's range takes in the digits, # and * that start a keycap, so a label
  // with any of those fetches it even though Excalifont draws them.
  for (const { url, unicodeRange } of pinned.faces) {
    document.fonts.add(new FontFace(pinned.family, `url(${url})`, { unicodeRange }));
  }
}

async function measureInPage({
  texts,
  font,
  fontSize,
  lineHeight,
}: {
  texts: string[];
  font: string;
  fontSize: number;
  lineHeight: number;
}): Promise<TextSize[]> {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("canvas 2d context unavailable");
  await Promise.all(texts.map((text) => document.fonts.load(font, text)));
  context.font = font;
  return texts.map((text) => {
    const lines = text
      .replace(/\r?\n|\r/g, "\n")
      .replace(/\t/g, "        ")
      .split("\n")
      .map((line) => line || " ");
    const width = Math.max(...lines.map((line) => context.measureText(line).width));
    return { width, height: lines.length * fontSize * lineHeight };
  });
}

async function svgInPage({
  data,
  padding,
  fontFaces,
  darkImageFilter,
  animation,
}: {
  data: ExportData;
  padding: number;
  fontFaces: string[];
  darkImageFilter: typeof DARK_IMAGE_FILTER;
  animation?: AnimationPlan;
}): Promise<string> {
  const { utils } = (window as unknown as ExcalixWindow).excalix;
  const svg = await utils.exportToSvg({ data, config: { padding } });
  if (fontFaces.length > 0) {
    const style = svg.querySelector("style.style-fonts");
    if (!style) throw new Error("the exported SVG has no style-fonts element for the pinned faces");
    style.append(fontFaces.map((face) => `\n      ${face}`).join(""));
  }
  const defs = svg.querySelector("defs");
  const filtered = svg.querySelectorAll(`g[filter="${darkImageFilter.from}"]`);
  if (filtered.length > 0) {
    if (!defs) throw new Error("the exported SVG has no defs element for the dark image filter");
    for (const g of filtered) g.setAttribute("filter", darkImageFilter.url);
    defs.insertAdjacentHTML("beforeend", darkImageFilter.markup);
  }
  if (animation === undefined) return svg.outerHTML;

  // The export draws each element as one top-level <g>, in element order, and marks none of them, so the position is
  // the only way back to the element. An image's <g> holds its <use>, and in dark mode also the filter that lightens it.
  // Anything else at the top is not a <g>: the <defs>, which holds each image's <symbol>, and a <mask> beside an arrow.
  const groups = [...svg.children].filter((child) => child.tagName === "g");
  if (groups.length !== data.elements.length) {
    throw new Error(`the exported SVG has ${groups.length} element groups for ${data.elements.length} elements`);
  }
  if (!defs) throw new Error("the exported SVG has no defs for the animation");
  groups.forEach((group, index) => {
    const { className, draw, march } = animation.elements[index]!;
    if (className !== undefined) group.setAttribute("class", className);
    if (draw === undefined && march === undefined) return;
    // An arrow is its line's group, then one group per arrowhead stroke.
    const [lineGroup, ...heads] = [...group.children];
    const line = lineGroup?.querySelector("path");
    if (!line) throw new Error(`the exported SVG has no line path for element ${index}`);
    if (march !== undefined) line.setAttribute("class", march);
    if (draw !== undefined) {
      const { id, d, strokeWidth, x, y, width, height, className: drawOn } = draw.mask;
      const mask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
      const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const attributes: [Element, Record<string, string | number>][] = [
        [mask, { id, maskUnits: "userSpaceOnUse", x, y, width, height }],
        [
          stroke,
          {
            d,
            fill: "none",
            stroke: "#fff",
            "stroke-width": strokeWidth,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            pathLength: 1,
            class: drawOn,
          },
        ],
      ];
      for (const [element, values] of attributes) {
        for (const [name, value] of Object.entries(values)) element.setAttribute(name, String(value));
      }
      mask.append(stroke);
      defs.append(mask);
      line.setAttribute("mask", `url(#${id})`);
      for (const head of heads) head.setAttribute("class", draw.heads);
    }
  });
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.setAttribute("class", "excalix-animation");
  style.textContent = animation.css;
  defs.append(style);
  return svg.outerHTML;
}

async function pngInPage({
  data,
  padding,
  scale,
  theme,
}: {
  data: ExportData;
  padding: number;
  scale: number;
  theme: "light" | "dark";
}): Promise<string> {
  const { utils } = (window as unknown as ExcalixWindow).excalix;
  const blob = await utils.exportToBlob({ data, config: { padding, scale, mimeType: "image/png", theme } });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
