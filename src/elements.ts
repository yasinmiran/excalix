import type { ExcalidrawElement } from "excalidraw-types/element/src/types";
import type { LayoutResult, Measured, Spec } from "./types.js";

export const EXCALIX_EPOCH = 1_700_000_000_000;

/** Turns a laid-out spec into Excalidraw elements. Pure and deterministic. */
export function buildElements(_spec: Spec, _layout: LayoutResult, _measured: Measured): ExcalidrawElement[] {
  throw new Error("not implemented");
}

/** Wraps elements in a .excalidraw document. */
export function toDocument(elements: ExcalidrawElement[]): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "excalix",
      elements,
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
      files: {},
    },
    null,
    2,
  );
}
