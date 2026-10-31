import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { FONT } from "../style.js";
import type { Renderer, TextSize } from "../types.js";
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

interface ExportData {
  elements: unknown[];
  appState: { exportBackground: boolean; viewBackgroundColor: string; exportEmbedScene: boolean };
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

// The scene goes into the SVG and the PNG too, so either opens in Excalidraw as an editable drawing.
function exportData(elements: unknown[]): ExportData {
  return { elements, appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportEmbedScene: true }, files: {} };
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
    probe: exportData([fontProbe()]),
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

/** Starts headless Chromium with @excalidraw/utils loaded. Call close() when done. */
export async function createBrowserRenderer(): Promise<Renderer> {
  const browser = await launchBrowser();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= browser.close());
  try {
    const page = await openRenderPage(browser);

    return {
      measurer: {
        measure: (texts, fontSize) =>
          page.evaluate(measureInPage, { texts, font: fontString(fontSize), fontSize, lineHeight: FONT.lineHeight }),
      },
      async svg(elements) {
        const fontFaces = await pinnedFontFaceRules(drawnTexts(elements));
        return page.evaluate(svgInPage, { data: exportData(elements), padding: PADDING, fontFaces });
      },
      async png(elements, { scale }) {
        const base64 = await page.evaluate(pngInPage, { data: exportData(elements), padding: PADDING, scale });
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
    // Platforms agree on a width to about the fifth decimal and no further, so the whole pixel above it is what
    // keeps the same spec byte-identical on macOS and Linux. The box is at most a pixel wider than the text.
    const width = Math.ceil(Math.max(...lines.map((line) => context.measureText(line).width)));
    return { width, height: lines.length * fontSize * lineHeight };
  });
}

async function svgInPage({ data, padding, fontFaces }: { data: ExportData; padding: number; fontFaces: string[] }): Promise<string> {
  const { utils } = (window as unknown as ExcalixWindow).excalix;
  const svg = await utils.exportToSvg({ data, config: { padding } });
  if (fontFaces.length > 0) {
    const style = svg.querySelector("style.style-fonts");
    if (!style) throw new Error("the exported SVG has no style-fonts element for the pinned faces");
    style.append(fontFaces.map((face) => `\n      ${face}`).join(""));
  }
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
