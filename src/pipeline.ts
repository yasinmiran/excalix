import type { Renderer, SketchResult } from "./types.js";

/** Validates, measures, lays out, builds and renders. The one entry point. */
export async function sketch(_input: unknown, _renderer: Renderer): Promise<SketchResult> {
  throw new Error("not implemented");
}

export interface WrittenFiles {
  excalidraw: string;
  svg: string;
  png: string;
}

/** Runs sketch and writes <basename>.excalidraw, .svg and .png. Returns the paths. */
export async function writeSketch(_input: unknown, _basename: string, _renderer: Renderer): Promise<WrittenFiles> {
  throw new Error("not implemented");
}
