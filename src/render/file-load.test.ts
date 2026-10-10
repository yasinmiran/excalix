import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ExcalidrawElement } from "excalidraw-types/element/src/types";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sketch } from "../pipeline.js";
import { measuringOnly, readSpec, specFiles } from "../test-support.js";
import type { Renderer } from "../types.js";
import { createBrowserRenderer } from "./browser.js";

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
