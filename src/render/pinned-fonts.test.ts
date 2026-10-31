import { describe, expect, it } from "vitest";
import { pinnedFontFaceRules } from "./pinned-fonts.js";

const RULE = /^@font-face \{ font-family: Xiaolai; src: url\(data:font\/ttf;base64,([\w+/=]+)\); unicode-range: ([^;]+); \}$/;

function parse(rule: string): { font: Buffer; range: string } {
  const [, base64, range] = RULE.exec(rule) ?? [];
  expect(base64, rule.slice(0, 120)).toBeDefined();
  return { font: Buffer.from(base64!, "base64"), range: range! };
}

describe("pinnedFontFaceRules", () => {
  it("embeds nothing for text the bundle's own faces draw", async () => {
    expect(await pinnedFontFaceRules(["Order API", "Ünïcödé Ελληνικά 日本語"])).toEqual([]);
  });

  it("embeds one TrueType subset holding just the characters drawn from the pinned text face", async () => {
    const rules = await pinnedFontFaceRules(["a → b", "✓ done", "→ again"]);

    expect(rules).toHaveLength(1);
    const { font, range } = parse(rules[0]!);
    expect(range).toBe("U+2192,U+2713");
    expect(font.readUInt32BE(0)).toBe(0x0001_0000);
    expect(font.byteLength).toBeLessThan(4_000);
  });

  // A text-default symbol is drawn as emoji, and left to the viewer, only where its cluster holds a character only the
  // emoji face has. The browser tests check each case against what the page draws.
  it.each([
    ["color emoji", ["deploy 🚀 ✅"], ""],
    ["a symbol before U+FE0F or U+20E3", ["☁️ 1️⃣ ☁⃣"], ""],
    ["a symbol with a skin tone", ["☝🏽 ✌🏽 ✍🏽"], ""],
    ["a symbol joined to an emoji by U+200D, without U+FE0F", ["❤‍🔥", "🏃‍♂", "🧑‍⚕", "👨‍✈", "🏴‍☠", "🏳‍⚧"], ""],
    ["a symbol on its own", ["☁ and ☁️"], "U+2601"],
    ["symbols joined only to each other or to text", ["☁‍☁ ♂‍♀ ✔‍x"], "U+2601,U+2640,U+2642,U+2714"],
    ["a symbol the emoji face lacks, joined to an emoji", ["→‍🔥"], "U+2192"],
  ])("treats %s as the page does", async (_, texts, range) => {
    expect((await pinnedFontFaceRules(texts)).map((rule) => parse(rule).range)).toEqual(range ? [range] : []);
  });

  it("gives the same bytes every time", async () => {
    const texts = ["→ ⇒ ✓ ┌─┐", "שלום مرحبا"];
    expect(await pinnedFontFaceRules(texts)).toEqual(await pinnedFontFaceRules(texts));
  });
});
