import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildElements, toDocument } from "./elements.js";
import { edgeKey } from "./ids.js";
import { layout } from "./layout.js";
import { parseSpec } from "./spec.js";
import { EDGE_LABEL_WIDTH, FONT, nodeSize, outlineOf, PNG_SCALE } from "./style.js";
import type { LayoutInput, Measured, Preview, Renderer, SketchResult, Spec, TextMeasurer, TextSize } from "./types.js";
import { wrapTexts } from "./wrap.js";

export interface SketchOptions {
  /** Also export the copy an agent is handed, which fits PREVIEW_EDGE pixels a side. */
  preview?: boolean;
}

/** Validates, measures, lays out, builds and renders. The one entry point. */
export async function sketch(input: unknown, renderer: Renderer, options: SketchOptions = {}): Promise<SketchResult> {
  const spec = parseSpec(input);
  const measured = await measureLabels(spec, renderer.measurer);
  const laidOut = await layout(toLayoutInput(spec, measured));
  const elements = buildElements(spec, laidOut, measured);
  const svg = await renderer.svg(elements);
  const png = await renderer.png(elements, { scale: PNG_SCALE });
  const result: SketchResult = { excalidraw: toDocument(elements), svg, png };
  if (options.preview) result.preview = await previewOf(elements, png, renderer);
  return result;
}

// The longest side Claude Code passes to a model whole. Exporting at that size, rather than letting the client
// shrink the full PNG, keeps the result small and what the model sees exactly what the size note judges.
const PREVIEW_EDGE = 2000;

/**
 * The PNG again at the largest scale up to PNG_SCALE that fits PREVIEW_EDGE a side, or the full one when it already
 * fits. The canvas truncates to whole pixels, so the full PNG's long edge L can be a pixel short of the scene's at
 * PNG_SCALE; the preview then comes out under PREVIEW_EDGE + PREVIEW_EDGE / L, which truncates to PREVIEW_EDGE.
 */
async function previewOf(elements: unknown[], png: Uint8Array, renderer: Renderer): Promise<Preview> {
  const { width, height } = pngSize(png);
  const scale = Math.min(PNG_SCALE, (PREVIEW_EDGE * PNG_SCALE) / Math.max(width, height));
  return scale === PNG_SCALE ? { png, scale } : { png: await renderer.png(elements, { scale }), scale };
}

export interface WrittenFiles {
  excalidraw: string;
  svg: string;
  png: string;
}

export interface Written {
  files: WrittenFiles;
  result: SketchResult;
}

/** Runs sketch and writes <basename>.excalidraw, .svg and .png. */
export async function writeSketch(input: unknown, basename: string, renderer: Renderer, options: SketchOptions = {}): Promise<Written> {
  const result = await sketch(input, renderer, options);
  return { files: await writeFiles(result, basename), result };
}

/** Writes a result to <basename>.excalidraw, .svg and .png. Returns the absolute paths. */
export async function writeFiles(result: SketchResult, basename: string): Promise<WrittenFiles> {
  const base = resolve(basename);
  await mkdir(dirname(base), { recursive: true });
  const paths = { excalidraw: `${base}.excalidraw`, svg: `${base}.svg`, png: `${base}.png` };
  await Promise.all([
    writeFile(paths.excalidraw, result.excalidraw),
    writeFile(paths.svg, result.svg),
    writeFile(paths.png, result.png),
  ]);
  return paths;
}

export interface Size {
  width: number;
  height: number;
}

/** An image as an agent is handed it: its size, and how many of its pixels one scene pixel became. */
export interface Shown extends Size {
  scale: number;
}

/** The PNG's own size, from the two big-endian uint32s in its IHDR chunk at byte 16 and 20. */
export function pngSize(png: Uint8Array): Size {
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: header.getUint32(16), height: header.getUint32(20) };
}

// Claude Code fits an image into 2000px a side before the model sees it, and the API's high-res tier then fits it
// into 4784 tiles of 28x28px. Either can shrink it, a long strip by its edge and a dense square by its area.
const CLIENT_EDGE = 2000;
const MAX_TILES = 4784;
const TILE = 28;
// Below this an edge label, the smallest text in a diagram, stops reading reliably in the copy a model sees.
const LEGIBLE_LABEL = 11;

/** How much a model's copy of an image this size is scaled down: 1 when it arrives whole. */
export function viewScale({ width, height }: Size): number {
  return Math.min(1, CLIENT_EDGE / Math.max(width, height), Math.sqrt((MAX_TILES * TILE * TILE) / (width * height)));
}

/**
 * One line about a diagram whose edge labels come out too small to read in the copy a model sees, or undefined
 * while they still read. full is the PNG on disk; shown is the image the model is handed, the same one by default.
 */
export function sizeNote(full: Size, shown: Shown = { ...full, scale: PNG_SCALE }): string | undefined {
  const scale = viewScale(shown);
  const label = FONT.edge * shown.scale * scale;
  if (label >= LEGIBLE_LABEL) return undefined;
  const seen = `${Math.round(shown.width * scale)}x${Math.round(shown.height * scale)}`;
  return `note: a model reads this diagram at ${seen} px, where its edge labels are about ${Math.floor(label)}px tall, too small to read. Split it into an overview and a detail diagram, or shorten the longest labels; the PNG on disk keeps the full ${full.width}x${full.height}.`;
}

async function measureLabels(spec: Spec, measurer: TextMeasurer): Promise<Measured> {
  const nodeLabels = await measureKeyed(measurer, spec.nodes.map((n) => [n.id, n.label]), FONT.node);
  const groupLabels = await measureKeyed(measurer, spec.groups.map((g) => [g.id, g.label]), FONT.group);
  const labelled = spec.edges.flatMap((e, i): [string, string][] => (e.label ? [[edgeKey(i), e.label]] : []));
  const texts = await wrapTexts(labelled.map(([, text]) => text), FONT.edge, EDGE_LABEL_WIDTH, measurer);
  const sizes = await measureKeyed(measurer, labelled.map(([key], i) => [key, texts[i]!]), FONT.edge);
  const edgeLabels = Object.fromEntries(labelled.map(([key], i) => [key, { text: texts[i]!, ...sizes[key]! }]));
  const measured: Measured = { nodeLabels, groupLabels, edgeLabels };
  if (spec.title) {
    [measured.title] = await measurer.measure([spec.title], FONT.title);
  }
  return measured;
}

async function measureKeyed(
  measurer: TextMeasurer,
  entries: [string, string][],
  fontSize: number,
): Promise<Record<string, TextSize>> {
  if (entries.length === 0) return {};
  const sizes = await measurer.measure(entries.map(([, text]) => text), fontSize);
  return Object.fromEntries(entries.map(([key], i) => [key, sizes[i]!]));
}

function toLayoutInput(spec: Spec, measured: Measured): LayoutInput {
  return {
    direction: spec.direction,
    groups: spec.groups.map((g) => ({ id: g.id, parent: g.parent, label: measured.groupLabels[g.id]! })),
    nodes: spec.nodes.map((n) => ({
      id: n.id,
      group: n.group,
      outline: outlineOf(n.kind),
      ...nodeSize(n.kind, measured.nodeLabels[n.id]!),
    })),
    edges: spec.edges.map((e, i) => ({
      id: edgeKey(i),
      from: e.from,
      to: e.to,
      label: measured.edgeLabels[edgeKey(i)],
    })),
  };
}
