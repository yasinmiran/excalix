import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The stack slot the pinned faces join. Xiaolai comes before any system font in Excalidraw's stack, for measurement,
 * for the bundle's own drawing and in the exported SVG alike, and the pinned ranges are disjoint from the bundle's
 * Xiaolai faces.
 */
export const PINNED_FAMILY = "Xiaolai";

/**
 * A face excalix ships for glyphs Excalifont and Xiaolai lack, as fonts/faces.json lists it. The faces are declared in
 * list order, and where their ranges overlap the later one wins, as with `@font-face` rules.
 */
export interface PinnedFace {
  file: string;
  /** What the face draws, disjoint from every other pinned face and from the bundle's own faces. */
  unicodeRange: string;
  /**
   * Characters another face draws on their own, which this one draws when they share a cluster with a character of its
   * own range: a U+FE0F, U+20E3 or skin tone after them, or an emoji joined to them by U+200D. The rule matches what
   * the page draws for every RGI emoji sequence, with or without U+FE0F, and may differ on a join that is not one, such
   * as ™‍☁ or ☝⃣.
   */
  sequenceRange?: string;
  /**
   * Glyphs drawn from a COLR table. harfbuzzjs builds its subsetter without color support, so a subset would come out
   * black: such a face stays out of the SVG, whose viewer then draws those glyphs, as with Excalidraw's own export.
   */
  color?: boolean;
}

/** The slice of harfbuzz-subset.wasm's exports a subset needs, the same calls the bundle makes for Excalifont. */
interface HarfBuzz {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codePoint: number): void;
  hb_set_clear(set: number): void;
  hb_set_invert(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_set(input: number, setType: number): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_16 = 0xfe0f;
const COMBINING_KEYCAP = 0x20e3;
const SKIN_TONES: [number, number] = [0x1f3fb, 0x1f3ff];

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;

const require = createRequire(import.meta.url);

export const fontsDir = fileURLToPath(new URL("../../fonts", import.meta.url));

let harfbuzz: Promise<HarfBuzz> | undefined;

export async function pinnedFaces(): Promise<PinnedFace[]> {
  return JSON.parse(await readFile(join(fontsDir, "faces.json"), "utf8")) as PinnedFace[];
}

/** Inclusive code point ranges of a CSS unicode-range such as `U+a4,U+b2-b3`. */
export function codePointRanges(unicodeRange: string): [number, number][] {
  return unicodeRange.split(",").map((part) => {
    const [from, to = from] = part.trim().replace(/^U\+/i, "").split("-");
    return [Number.parseInt(from!, 16), Number.parseInt(to!, 16)];
  });
}

/**
 * `@font-face` rules for an exported SVG: one per pinned face the texts draw from, embedding a subset of that face
 * with only the glyphs the texts need, the way the bundle embeds Excalifont. Without them the SVG would draw those
 * glyphs from whatever fonts the viewer has.
 */
export async function pinnedFontFaceRules(texts: string[]): Promise<string[]> {
  const faces = (await pinnedFaces()).map((face) => ({
    ...face,
    ranges: codePointRanges(face.unicodeRange),
    sequenceRanges: face.sequenceRange ? codePointRanges(face.sequenceRange) : [],
    used: new Set<number>(),
  }));
  for (const cluster of texts.flatMap(clusters)) {
    // Chromium draws a cluster from one face when some face maps all of it, so ❤ joined to 🔥 comes from the face with 🔥.
    // U+200D draws nothing and pulls no face in by itself: ☁ joined to ☁ stays with the face that has ☁.
    const joined = faces.filter((face) => cluster.some((code) => code !== ZERO_WIDTH_JOINER && contains(face.ranges, code)));
    for (const code of cluster) {
      const face =
        joined.find((candidate) => contains(candidate.sequenceRanges, code)) ?? faces.find((candidate) => contains(candidate.ranges, code));
      face?.used.add(code);
    }
  }
  const rules: string[] = [];
  for (const face of faces) {
    if (face.color || face.used.size === 0) continue;
    const codePoints = [...face.used].sort((a, b) => a - b);
    const font = await subset(await readFile(join(fontsDir, face.file)), codePoints);
    const source = `data:font/ttf;base64,${Buffer.from(font).toString("base64")}`;
    rules.push(`@font-face { font-family: ${PINNED_FAMILY}; src: url(${source}); unicode-range: ${unicodeRange(codePoints)}; }`);
  }
  return rules;
}

/**
 * The code points of a text in the runs Chromium shapes as one cluster, as far as the pinned faces tell them apart: exact
 * for RGI emoji sequences, approximate for joins that are not one.
 */
function clusters(text: string): number[][] {
  const codes = Array.from(text, (char) => char.codePointAt(0)!);
  const runs: number[][] = [];
  codes.forEach((code, index) => {
    const attached =
      code === VARIATION_SELECTOR_16 ||
      code === COMBINING_KEYCAP ||
      code === ZERO_WIDTH_JOINER ||
      codes[index - 1] === ZERO_WIDTH_JOINER ||
      contains([SKIN_TONES], code);
    if (attached && runs.length > 0) runs.at(-1)!.push(code);
    else runs.push([code]);
  });
  return runs;
}

function contains(ranges: [number, number][], code: number): boolean {
  return ranges.some(([from, to]) => from <= code && code <= to);
}

function unicodeRange(sortedCodePoints: number[]): string {
  const ranges: [number, number][] = [];
  for (const code of sortedCodePoints) {
    const last = ranges.at(-1);
    if (last && last[1] === code - 1) last[1] = code;
    else ranges.push([code, code]);
  }
  return ranges.map(([from, to]) => (from === to ? `U+${from.toString(16)}` : `U+${from.toString(16)}-${to.toString(16)}`)).join(",");
}

function loadHarfBuzz(): Promise<HarfBuzz> {
  harfbuzz ??= (async () => {
    const wasm = await readFile(require.resolve("harfbuzzjs/dist/harfbuzz-subset.wasm"));
    const { instance } = await WebAssembly.instantiate(wasm);
    const exports = instance.exports as unknown as HarfBuzz;
    exports._initialize();
    return exports;
  })();
  return harfbuzz;
}

/** Every layout feature is kept, so an emoji sequence such as a flag or a skin tone still ligates inside the subset. */
async function subset(font: Uint8Array, codePoints: number[]): Promise<Uint8Array> {
  const hb = await loadHarfBuzz();
  const input = hb.hb_subset_input_create_or_fail();
  if (input === 0) throw new Error("harfbuzz could not create a subset input");
  const fontPointer = hb.malloc(font.byteLength);
  // Growing the wasm memory detaches earlier views of it, so every read and write takes a fresh one.
  new Uint8Array(hb.memory.buffer).set(font, fontPointer);
  const blob = hb.hb_blob_create(fontPointer, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  try {
    const features = hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
    hb.hb_set_clear(features);
    hb.hb_set_invert(features);
    const unicodes = hb.hb_subset_input_unicode_set(input);
    for (const code of codePoints) hb.hb_set_add(unicodes, code);
    const subsetFace = hb.hb_subset_or_fail(face, input);
    if (subsetFace === 0) throw new Error("harfbuzz could not subset the font");
    const result = hb.hb_face_reference_blob(subsetFace);
    const bytes = new Uint8Array(hb.memory.buffer, hb.hb_blob_get_data(result, 0), hb.hb_blob_get_length(result)).slice();
    hb.hb_blob_destroy(result);
    hb.hb_face_destroy(subsetFace);
    if (bytes.byteLength === 0) throw new Error("harfbuzz returned an empty subset");
    return bytes;
  } finally {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(fontPointer);
  }
}
