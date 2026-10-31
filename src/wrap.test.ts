import { describe, expect, it } from "vitest";
import { estimateMeasurer } from "./render/estimate.js";
import { EDGE_LABEL_WIDTH, FONT } from "./style.js";
import type { TextMeasurer } from "./types.js";
import { breakTokens, wrapTexts } from "./wrap.js";

// The estimate gives every UTF-16 code unit 0.6 of the font size, so at size 10 a line of n units is 6n wide.
const SIZE = 10;
const wrap = async (text: string, maxWidth: number, measurer = estimateMeasurer) =>
  (await wrapTexts([text], SIZE, maxWidth, measurer))[0]!;

describe("wrapTexts", () => {
  it("keeps a line that fits as written", async () => {
    expect(await wrap("POST  /orders", 78)).toBe("POST  /orders");
  });

  it("breaks between words, each line as long as fits", async () => {
    expect(await wrap("an edge label that is really quite long indeed", 120)).toBe("an edge label that\nis really quite long\nindeed");
  });

  it("keeps the author's line breaks and wraps each line on its own", async () => {
    expect(await wrap("reads\nan edge label that is long", 60)).toBe("reads\nan edge\nlabel that\nis long");
  });

  it("keeps the spaces inside a line and drops them at a break", async () => {
    expect(await wrap("POST  /orders   with   spaces", 108)).toBe("POST  /orders\nwith   spaces");
  });

  it("drops trailing whitespace that no longer fits", async () => {
    expect(await wrap("ab cd   ", 30)).toBe("ab cd");
  });

  it("keeps as much trailing whitespace as still fits", async () => {
    expect(await wrap("ab cd  ", 36)).toBe("ab cd ");
  });

  it("breaks after a hyphen", async () => {
    expect(await wrap("fan-out to the order-service workers", 126)).toBe("fan-out to the order-\nservice workers");
  });

  it("breaks between a closing and an opening bracket", async () => {
    expect(await wrap("GET /orders/{id}/items", 60)).toBe("GET\n/orders/\n{id}/items");
  });

  it("breaks inside a word only when the word alone is wider, and fills its last line on", async () => {
    expect(await wrap("emits com.example.OrderCreated now", 60)).toBe("emits\ncom.exampl\ne.OrderCre\nated now");
  });

  it("breaks between CJK characters but never ahead of their closing punctuation", async () => {
    expect(await wrap("注文を作成。在庫を予約", 30)).toBe("注文を作\n成。在庫を\n予約");
  });

  it("keeps an emoji whole, however many code points make it", async () => {
    const family = "👨‍👩‍👧";
    expect((await wrap(`${family}${family}`, 6)).split("\n")).toEqual([family, family]);
    expect((await wrap("🇳🇴🇸🇪👍🏽", 30)).split("\n")).toEqual(["🇳🇴", "🇸🇪", "👍🏽"]);
    // One emoji to the editor, whose pattern lets a joiner take a digit, and two graphemes to Intl.Segmenter.
    expect(await wrap("👍\u200d1", 6)).toBe("👍\u200d1");
  });

  it("breaks a word between graphemes, never between the code points of one", async () => {
    expect(await wrap("g̈g̈g̈", 18)).toBe("g̈\ng̈\ng̈");
  });

  it("composes the characters of a line it wraps, as the editor does", async () => {
    expect((await wrap("e\u0301".repeat(10), 12)).split("\n")).toEqual(Array(5).fill("\u00e9\u00e9"));
  });

  it("ends a line at the first length that misses, even where a longer one fits again", async () => {
    // Twenty pairs measure 160, a lam more 169, and the alef after it shapes the line back to 168.
    expect((await wrap("\u0644\u0627".repeat(30), 168, shapingMeasurer)).split("\n")).toEqual([
      "\u0644\u0627".repeat(20),
      "\u0644\u0627".repeat(10),
    ]);
    // 66 x measure 396, a lam more 405, and the alef after it shapes back to 404, at a length the third window would
    // only sample were it not dense.
    expect((await wrap("x".repeat(66) + "\u0644\u0627" + "x".repeat(100), 404, shapingMeasurer)).split("\n")[0]).toBe(
      "x".repeat(66),
    );
  });

  it("wraps every text of a batch in its own order", async () => {
    expect(await wrapTexts(["a b c", "abc", "a"], SIZE, 18, estimateMeasurer)).toEqual(["a b\nc", "abc", "a"]);
  });

  it("wraps generated labels as a plain wrap that measures one token at a time does", async () => {
    const random = seeded(7);
    const labels = Array.from({ length: 300 }, () => generatedLabel(random));
    for (const measurer of [estimateMeasurer, shapingMeasurer]) {
      for (const maxWidth of [3, 30, 60, 100, 160, 400]) {
        const plain = await Promise.all(labels.map((label) => wrapPlainly(label, maxWidth, measurer)));
        expect(await wrapTexts(labels, SIZE, maxWidth, measurer)).toEqual(plain);
      }
    }
  });

  // Labels have no length limit and an agent can send any, so a long one has to cost in proportion to its length. One
  // round trip measures the label's own lines whole before any of them wraps.
  it("measures a long label in one or two round trips per line and in proportion to its length", async () => {
    const sentence = Array.from({ length: 600 }, (_, i) => WORDS[i % WORDS.length]).join(" ");
    const words = await wrapCounting(sentence);
    expect(words.roundTrips).toBeLessThanOrEqual(words.lines + 1);
    expect(words.characters).toBeLessThanOrEqual(100 * sentence.length);
    // A line of a long token fills the first window of 16 graphemes, so the length that misses is in the second.
    const token = "x".repeat(2000);
    const pieces = await wrapCounting(token);
    expect(pieces.roundTrips).toBeLessThanOrEqual(2 * pieces.lines + 1);
    expect(pieces.characters).toBeLessThanOrEqual(100 * token.length);
  });

  it("samples a line of characters with no width, so it too costs in proportion to its length", async () => {
    const label = `${"\u200b".repeat(2000)}${"x".repeat(40)}`;
    const { characters } = await wrapCounting(label, zeroWidthSpaceMeasurer);
    expect(characters).toBeLessThanOrEqual(200 * label.length);
  });
});

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The same wrap the plain way, one token at a time with each candidate line measured on its own. */
async function wrapPlainly(text: string, maxWidth: number, measurer: TextMeasurer): Promise<string> {
  const fits = async (line: string) => (await measurer.measure([line], SIZE))[0]!.width <= maxWidth;
  const out: string[] = [];
  for (const own of text.split("\n")) {
    if (await fits(own)) {
      out.push(own);
      continue;
    }
    const tokens = breakTokens(own);
    let current = "";
    for (let i = 0; i < tokens.length; ) {
      const token = tokens[i]!;
      if (/\s/.test(token) || (await fits(current + token))) {
        current += token;
        i += 1;
      } else if (current) {
        out.push(current.trimEnd());
        current = "";
      } else {
        for (const { segment } of graphemes.segment(token)) {
          if (current && !(await fits(current + segment))) {
            out.push(current);
            current = "";
          }
          current += segment;
        }
        i += 1;
      }
    }
    let kept = current.trimEnd();
    for (const space of current.slice(kept.length)) {
      if (!(await fits(kept + space))) break;
      kept += space;
    }
    if (current) out.push(kept);
  }
  return out.join("\n");
}

const WORDS = ["places", "order", "payment", "tokens", "created", "shipment", "nightly", "exports", "service", "workers"];
// Every kind of break and of character the wrap handles on its own. Each emoji is one grapheme, so the plain wrap keeps
// it whole without the editor's emoji pattern.
const FRAGMENTS = [
  ...WORDS,
  "a",
  "OrderCreated",
  "fan-out",
  "order-service",
  "-",
  "--",
  "GET",
  "/orders/{orderId}/items",
  "(v2)",
  "[batch]",
  "com.example.orders",
  "s3://bucket/key/path.parquet",
  "注文を作成して",
  "「予約」",
  "、",
  "。",
  "下单后通知库存服务",
  "👨\u200d👩\u200d👧",
  "🇳🇴🇸🇪",
  "👍🏽",
  "📦",
  "cafe\u0301",
  "g\u0308",
  "\t",
  "\u00a0",
];
const SPACES = ["", " ", " ", " ", "  ", "   ", "      "];
const LONG = ["a", "b", "c", "x", "Q", "e\u0301", "g\u0308", ".", "/", "\u0644", "\u0644\u0627"];

/** Words, runs of spaces, hyphens, paths, CJK, emoji, long unbroken tokens with Arabic in them, the author's breaks. */
function generatedLabel(random: () => number): string {
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const parts = [pick(SPACES)];
  for (let n = 1 + Math.floor(random() * 30); n > 0; n--) {
    const roll = random();
    if (roll < 0.05) parts.push("\n");
    else if (roll < 0.15) parts.push(Array.from({ length: 20 + Math.floor(random() * 180) }, () => pick(LONG)).join(""));
    else parts.push(pick(FRAGMENTS));
    parts.push(pick(SPACES));
  }
  return parts.join("");
}

/** Numbers in [0, 1) drawn from a seed, so every run generates the same labels. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The estimate, except that a lam and the alef after it shape into a ligature narrower than the lam alone: a lam with
 * no alef after it measures 0.9 of the font size and the pair 0.8, so a line can narrow as it grows, as Arabic does.
 */
const shapingMeasurer: TextMeasurer = {
  async measure(texts, fontSize) {
    const count = (line: string, pattern: RegExp) => line.match(pattern)?.length ?? 0;
    const tenths = (line: string) =>
      6 * line.length + 3 * count(line, /\u0644(?!\u0627)/gu) - 4 * count(line, /\u0644\u0627/gu);
    const sizes = await estimateMeasurer.measure(texts, fontSize);
    const width = (text: string) => (fontSize * Math.max(...text.split("\n").map(tenths))) / 10;
    return texts.map((text, i) => ({ ...sizes[i]!, width: width(text) }));
  },
};

/** The estimate, except that a zero-width space has no width. */
const zeroWidthSpaceMeasurer: TextMeasurer = {
  measure: (texts, fontSize) => estimateMeasurer.measure(texts.map((text) => text.replaceAll("\u200b", "")), fontSize),
};

/** The label wrapped as an edge label is, with the round trips made to the measurer and the characters it measured. */
async function wrapCounting(
  label: string,
  inner: TextMeasurer = estimateMeasurer,
): Promise<{ lines: number; roundTrips: number; characters: number }> {
  let roundTrips = 0;
  let characters = 0;
  const measurer: TextMeasurer = {
    measure(texts, fontSize) {
      roundTrips += 1;
      characters += texts.reduce((sum, text) => sum + text.length, 0);
      return inner.measure(texts, fontSize);
    },
  };
  const [wrapped] = await wrapTexts([label], FONT.edge, EDGE_LABEL_WIDTH, measurer);
  return { lines: wrapped!.split("\n").length, roundTrips, characters };
}
