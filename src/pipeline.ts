import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildElements, toDocument } from "./elements.js";
import { edgeKey } from "./ids.js";
import { layout } from "./layout.js";
import { parseSpec } from "./spec.js";
import { FONT, nodeSize } from "./style.js";
import type { LayoutInput, Measured, Renderer, SketchResult, Spec, TextMeasurer, TextSize } from "./types.js";

/** Validates, measures, lays out, builds and renders. The one entry point. */
export async function sketch(input: unknown, renderer: Renderer): Promise<SketchResult> {
  const spec = parseSpec(input);
  const measured = await measureLabels(spec, renderer.measurer);
  const laidOut = await layout(toLayoutInput(spec, measured));
  const elements = buildElements(spec, laidOut, measured);
  const svg = await renderer.svg(elements);
  const png = await renderer.png(elements);
  return { excalidraw: toDocument(elements), svg, png };
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
export async function writeSketch(input: unknown, basename: string, renderer: Renderer): Promise<Written> {
  const result = await sketch(input, renderer);
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

async function measureLabels(spec: Spec, measurer: TextMeasurer): Promise<Measured> {
  const nodeLabels = await measureKeyed(measurer, spec.nodes.map((n) => [n.id, n.label]), FONT.node);
  const groupLabels = await measureKeyed(measurer, spec.groups.map((g) => [g.id, g.label]), FONT.group);
  const labelled = spec.edges.flatMap((e, i): [string, string][] => (e.label ? [[edgeKey(i), e.label]] : []));
  const edgeLabels = await measureKeyed(measurer, labelled, FONT.edge);
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
    nodes: spec.nodes.map((n) => ({ id: n.id, group: n.group, ...nodeSize(n.kind, measured.nodeLabels[n.id]!) })),
    edges: spec.edges.map((e, i) => ({
      id: edgeKey(i),
      from: e.from,
      to: e.to,
      label: measured.edgeLabels[edgeKey(i)],
    })),
  };
}
