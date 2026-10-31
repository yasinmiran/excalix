import type { TextMeasurer } from "./types.js";

/** Whether each line measures no wider than the limit, in one round trip to the measurer. */
type Fits = (lines: string[]) => Promise<boolean[]>;

// The break opportunities of the editor's wrapText (textWrapping.ts in @excalidraw/element), so a label breaks where
// the editor would break it: around whitespace, after a hyphen, around an emoji, between CJK characters but not next
// to their own punctuation, and between a closing and an opening bracket.
const OPENING = String.raw`<\(\[\{`;
const CLOSING = String.raw`>\)\]\}.,:;!\?…\/`;
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}｀＇＾〃〰〆＃＆＊＋－ー／＼＝｜￤〒￢￣`;
const CJK_OPENING = "（［｛〈《｟｢「『【〖〔〘〚＜〝";
const CJK_CLOSING = "）］｝〉》｠｣」』】〗〕〙〛＞。．，、〟‥？！：；・〜〞";
const CJK_CURRENCY = "￥￦￡￠＄";
const FLAG = String.raw`\p{RI}\p{RI}`;
const MODIFIER = String.raw`(?:\p{Emoji_Modifier}|️⃣?|[\u{E0020}-\u{E007E}]+\u{E007F})?`;
const EMOJI = String.raw`${FLAG}|[\p{Extended_Pictographic}\p{Emoji_Presentation}]${MODIFIER}(?:‍(?:${FLAG}|\p{Emoji}${MODIFIER}))*`;

const BREAKS = new RegExp(
  [
    `(${EMOJI})`,
    String.raw`(?=\s)`,
    String.raw`(?<=[\s-])`,
    `(?<![${OPENING}${CJK_OPENING}])(?=[${CJK}${CJK_CURRENCY}])`,
    `(?<=[${CJK}])(?![-${CLOSING}${CJK_CLOSING}])`,
    `(?<![${OPENING}${CJK_OPENING}])(?=[${CJK_OPENING}])`,
    `(?<=[${CJK_CLOSING}])(?![${CLOSING}${CJK_CLOSING}])`,
    `(?<=[${CLOSING}])(?![${CLOSING}])(?=[${OPENING}])`,
  ].join("|"),
  "u",
);
const WHOLE_EMOJI = new RegExp(`^(?:${EMOJI})$`, "u");
const WHITESPACE = /\s/u;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Breaks each text into lines that measure no wider than maxWidth, as the editor wraps a bound text: a line of the
 * text that fits stays as written, and one that does not breaks at the last opportunity that fits, inside a word only
 * when the word alone is wider. Inside such a word two things differ: it breaks between graphemes where the editor
 * breaks between code points, and it measures the run itself where the editor adds up each character's own width,
 * which leaves out kerning, so the editor's line can end a character sooner.
 */
export async function wrapTexts(texts: string[], fontSize: number, maxWidth: number, measurer: TextMeasurer): Promise<string[]> {
  const fits: Fits = async (lines) => (await measurer.measure(lines, fontSize)).map((size) => size.width <= maxWidth);
  const ownLines = texts.map((text) => text.split("\n"));
  const fitting = await fits(ownLines.flat());
  let at = 0;
  const wrapped: string[] = [];
  for (const lines of ownLines) {
    const out: string[] = [];
    for (const line of lines) out.push(...(fitting[at++] ? [line] : await wrapLine(line, fits)));
    wrapped.push(out.join("\n"));
  }
  return wrapped;
}

/** The pieces the editor's line break rules cut a line into, after composing its characters as the editor does. */
export function breakTokens(line: string): string[] {
  return line.normalize("NFC").split(BREAKS).filter(Boolean);
}

async function wrapLine(line: string, fits: Fits): Promise<string[]> {
  const tokens = breakTokens(line);
  // Whitespace joins a line whatever its width and a soft break trims it off again, so a line is only measured where
  // it ends in a word.
  const words = tokens.flatMap((token, i) => (WHITESPACE.test(token) ? [] : [i]));
  const lines: string[] = [];
  let current = "";
  let next = 0;
  let word = 0;
  while (next < tokens.length) {
    const upTo = (end: number) => current + tokens.slice(next, end).join("");
    const taken = await longestFit(words.length - word, (n) => upTo(words[word + n - 1]! + 1), fits);
    if (word + taken === words.length) {
      current = upTo(tokens.length);
      break;
    }
    const miss = words[word + taken]!;
    const before = upTo(miss);
    if (before) {
      lines.push(before.trimEnd());
      current = "";
      next = miss;
      word += taken;
    } else {
      const parts = await wrapWord(tokens[miss]!, fits);
      lines.push(...parts.slice(0, -1));
      current = parts[parts.length - 1]!;
      next = miss + 1;
      word += 1;
    }
  }
  if (current) lines.push(await trimLine(current, fits));
  return lines;
}

/** A token wider than a line of its own, broken into the longest runs of graphemes that fit. An emoji stays whole. */
async function wrapWord(word: string, fits: Fits): Promise<string[]> {
  if (WHOLE_EMOJI.test(word)) return [word];
  const pieces = Array.from(graphemes.segment(word), (s) => s.segment);
  const lines: string[] = [];
  for (let start = 0; start < pieces.length; ) {
    const run = (n: number) => pieces.slice(start, start + n).join("");
    // A grapheme wider than a line still takes one.
    const taken = Math.max(1, await longestFit(pieces.length - start, run, fits));
    lines.push(run(taken));
    start += taken;
  }
  return lines;
}

/** The last line of a wrapped line, with as much of its trailing whitespace as still fits. */
async function trimLine(line: string, fits: Fits): Promise<string> {
  const trimmed = line.trimEnd();
  const spaces = Array.from(line.slice(trimmed.length));
  const kept = (n: number) => trimmed + spaces.slice(0, n).join("");
  return kept(await longestFit(spaces.length, kept, fits));
}

// A line of a label rarely holds more than a dozen words or CJK characters, so the first window usually settles it.
const PROBES = 16;
// Shaping can make a longer prefix narrower: an Arabic lam then alef is narrower than the lam alone. So a window is
// measured at every length, and the first length that misses is found exactly when it is one of the first 2 * DENSE.
// Only characters of next to no width make a line that long, and a wider window is sampled at PROBES lengths so such a
// line still costs in proportion to its length.
const DENSE = 64;

/**
 * The length before the first whose candidate misses, or count when none does. Each round trip measures a window that
 * reaches past the longest known fit by as much again, so a line takes a few round trips and what they measure grows
 * with the line, not with the label. A window wider than DENSE is sampled: the length it returns still fits and the
 * next one still misses, but a shorter length that misses could go unseen.
 */
async function longestFit(count: number, candidate: (n: number) => string, fits: Fits): Promise<number> {
  let fit = 0;
  let miss = count + 1;
  while (miss - fit > 1) {
    const top = Math.min(miss - 1, fit + Math.max(PROBES, fit));
    const open = top - fit;
    const spread = open <= DENSE ? open : PROBES;
    const probes = Array.from({ length: spread }, (_, i) => fit + Math.floor(((i + 1) * open) / spread));
    const fitting = await fits(probes.map(candidate));
    const first = fitting.indexOf(false);
    if (first === -1) {
      fit = top;
    } else {
      miss = probes[first]!;
      fit = probes[first - 1] ?? fit;
    }
  }
  return fit;
}
