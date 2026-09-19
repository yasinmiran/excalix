import type { ExcalidrawElement } from "excalidraw-types/element/src/types";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sketch } from "../pipeline.js";
import { measuringOnly, readSpec, specFiles } from "../test-support.js";
import type { Renderer } from "../types.js";
import { createBrowserRenderer, openBundlePage } from "./browser.js";

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
      const built = JSON.parse((await sketch(readSpec(file), measuringOnly(renderer.measurer))).excalidraw).elements as ExcalidrawElement[];

      const restored = (await page.evaluate(restoreInPage, built as unknown[])) as ExcalidrawElement[];

      expect(restored).toEqual(built);
    });
  }
});
