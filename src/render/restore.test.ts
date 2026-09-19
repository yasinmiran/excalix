import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExcalidrawElement } from "excalidraw-types/element/src/types";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sketch } from "../pipeline.js";
import type { Renderer } from "../types.js";
import { createBrowserRenderer, openBundlePage } from "./browser.js";

// Restore assigns a fractional index to every element that ships with index: null, and that
// assignment mutates the element, which bumps the other three.
const REGENERATED = new Set(["index", "version", "versionNonce", "updated"]);

const root = fileURLToPath(new URL("../..", import.meta.url));

const specFiles = ["examples", "stress"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${dir}/${name}`),
);

interface ClipboardUtils {
  exportToClipboard(args: { type: "json"; data: { elements: unknown[]; appState: object; files: object } }): Promise<void>;
}

interface BundleWindow {
  excalix: { utils: ClipboardUtils };
}

/**
 * The bundle exports no restore, but exportToClipboard serialises what restoreElements returned,
 * so the JSON it copies is the restored scene. The page origin is insecure, so navigator.clipboard
 * is absent and the bundle falls back to execCommand("copy") over a textarea it selects.
 */
async function restoreInPage(elements: unknown[]): Promise<unknown[]> {
  const { utils } = (window as unknown as BundleWindow).excalix;
  const execCommand = document.execCommand.bind(document);
  let copied: string | undefined;
  document.execCommand = (command: string): boolean => {
    if (command !== "copy") return execCommand(command);
    copied = (document.activeElement as HTMLTextAreaElement | null)?.value;
    return true;
  };
  try {
    await utils.exportToClipboard({ type: "json", data: { elements, appState: {}, files: {} } });
  } finally {
    document.execCommand = execCommand;
  }
  if (copied === undefined) throw new Error("the bundle copied the restored scene somewhere else");
  return (JSON.parse(copied) as { elements: unknown[] }).elements;
}

function comparable(element: ExcalidrawElement): Record<string, unknown> {
  return Object.fromEntries(Object.entries(element).filter(([field]) => !REGENERATED.has(field)));
}

describe("[browser] Excalidraw restore", () => {
  let renderer: Renderer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    renderer = await createBrowserRenderer();
    browser = await chromium.launch();
    page = await openBundlePage(browser);
  });

  afterAll(async () => {
    await browser?.close();
    await renderer?.close();
  });

  for (const file of specFiles) {
    it(`leaves the elements of ${file} untouched`, async () => {
      const input: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
      const measuring: Renderer = { ...renderer, svg: async () => "", png: async () => new Uint8Array() };
      const built = JSON.parse((await sketch(input, measuring)).excalidraw).elements as ExcalidrawElement[];

      const restored = (await page.evaluate(restoreInPage, built as unknown[])) as ExcalidrawElement[];

      expect(restored.map(comparable)).toEqual(built.map(comparable));
      expect(restored.map((element) => ({ indexed: typeof element.index === "string", version: element.version }))).toEqual(
        built.map((element) => ({ indexed: true, version: element.version + 1 })),
      );
    });
  }
});
