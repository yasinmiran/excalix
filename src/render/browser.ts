import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { FONT } from "../style.js";
import type { Renderer, TextSize } from "../types.js";

const ORIGIN = "http://excalix.local";
const VENDOR_PATH = "/vendor/";
const PADDING = 24;
const PNG_SCALE = 2;

/** Fallback order the bundle's getFontString produces for Excalifont. */
const EXCALIFONT_STACK = "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script>window.EXCALIDRAW_ASSET_PATH = "${VENDOR_PATH}assets/";</script>
<script type="module">
  try {
    window.excalix = { utils: await import("${VENDOR_PATH}index.js") };
  } catch (error) {
    window.excalix = { error: String(error) };
  }
</script>`;

interface ExportData {
  elements: unknown[];
  appState: { exportBackground: boolean; viewBackgroundColor: string };
  files: Record<string, never>;
}

/** The slice of @excalidraw/utils this renderer calls; it runs inside the page against the global the bundle assigns, not against an import. */
interface Utils {
  exportToCanvas(args: { data: ExportData }): Promise<HTMLCanvasElement>;
  exportToSvg(args: { data: ExportData; config: { padding: number } }): Promise<SVGSVGElement>;
  exportToBlob(args: { data: ExportData; config: { padding: number; scale: number; mimeType: string } }): Promise<Blob>;
}

interface ExcalixWindow {
  excalix: { utils: Utils; error?: string };
}

const vendorDir = dirname(createRequire(import.meta.url).resolve("@excalidraw/utils"));

function exportData(elements: unknown[]): ExportData {
  return { elements, appState: { exportBackground: true, viewBackgroundColor: "#ffffff" }, files: {} };
}

function fontString(fontSize: number): string {
  return `${fontSize}px ${EXCALIFONT_STACK}`;
}

async function serve(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) return route.abort();
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: PAGE });
  if (!url.pathname.startsWith(VENDOR_PATH)) return route.fulfill({ status: 404 });
  const file = resolve(vendorDir, decodeURIComponent(url.pathname.slice(VENDOR_PATH.length)));
  if (!file.startsWith(vendorDir + sep)) return route.fulfill({ status: 404 });
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

/** Starts headless Chromium with @excalidraw/utils loaded. Call close() when done. */
// Linux Chromium hints glyphs and snaps their advances to whole pixels unless told otherwise, which makes every label
// a pixel or two off what macOS and the Excalidraw editor measure. Both flags are no-ops where that is already the case.
const TEXT_METRIC_FLAGS = ["--font-render-hinting=none", "--enable-font-subpixel-positioning"];

export async function createBrowserRenderer(): Promise<Renderer> {
  const browser = await chromium.launch({ args: TEXT_METRIC_FLAGS });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= browser.close());
  try {
    const page = await openBundlePage(browser);
    await page.evaluate(registerFonts, { probe: exportData([fontProbe()]), family: "Excalifont" });

    return {
      measurer: {
        measure: (texts, fontSize) =>
          page.evaluate(measureInPage, { texts, font: fontString(fontSize), fontSize, lineHeight: FONT.lineHeight }),
      },
      svg: (elements) => page.evaluate(svgInPage, { data: exportData(elements), padding: PADDING }),
      async png(elements) {
        const base64 = await page.evaluate(pngInPage, { data: exportData(elements), padding: PADDING, scale: PNG_SCALE });
        return new Uint8Array(Buffer.from(base64, "base64"));
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
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

async function registerFonts({ probe, family }: { probe: ExportData; family: string }): Promise<void> {
  const { utils } = (window as unknown as ExcalixWindow).excalix;
  await utils.exportToCanvas({ data: probe });
  let registered = false;
  document.fonts.forEach((face) => {
    registered ||= face.family === family && face.status === "loaded";
  });
  if (!registered) throw new Error(`${family} did not register in document.fonts`);
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
    // Platforms agree on a width to about the fifth decimal and no further, so the whole pixel above it is what
    // keeps the same spec byte-identical on macOS and Linux. The box is at most a pixel wider than the text.
    const width = Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width)));
    return { width, height: lines.length * fontSize * lineHeight };
  });
}

async function svgInPage({ data, padding }: { data: ExportData; padding: number }): Promise<string> {
  const { utils } = (window as unknown as ExcalixWindow).excalix;
  const svg = await utils.exportToSvg({ data, config: { padding } });
  return svg.outerHTML;
}

async function pngInPage({ data, padding, scale }: { data: ExportData; padding: number; scale: number }): Promise<string> {
  const { utils } = (window as unknown as ExcalixWindow).excalix;
  const blob = await utils.exportToBlob({ data, config: { padding, scale, mimeType: "image/png" } });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
