import { describe, expect, it } from "vitest";
import { altText, markdownSnippet } from "./markdown.js";

const BASE = "/work/project";
const LIGHT = { svg: "/work/project/diagrams/arch.svg" };
const BOTH = { ...LIGHT, dark: { svg: "/work/project/diagrams/arch.dark.svg", png: "/work/project/diagrams/arch.dark.png" } };
const ANIMATED = { ...LIGHT, animatedSvg: "/work/project/diagrams/arch.animated.svg" };
const BOTH_ANIMATED = { ...ANIMATED, dark: { ...BOTH.dark, animatedSvg: "/work/project/diagrams/arch.dark.animated.svg" } };

describe("alt text", () => {
  it.each([
    ["the title and every node", "order pipeline", ["Web app", "Order API"], "order pipeline: Web app, Order API"],
    ["what it is when there is no title", undefined, ["Web app", "Order API"], "architecture diagram: Web app, Order API"],
    ["a space for each line break", "two\nlines", ["Orders\nAPI", "a\r\nb"], "two lines: Orders API, a b"],
  ])("names %s", (_case, title, labels, expected) => {
    expect(altText(title, labels.map((label) => ({ label })))).toBe(expected);
  });
});

describe("markdown snippet", () => {
  it.each([
    ["plain text as it is", "order pipeline: Web app", LIGHT, "![order pipeline: Web app](diagrams/arch.svg)"],
    ["quotes as they are", 'the "edge": Web app', LIGHT, '![the "edge": Web app](diagrams/arch.svg)'],
    ["brackets escaped, so they cannot end the text", "a [b] c", LIGHT, "![a \\[b\\] c](diagrams/arch.svg)"],
    ["a backslash escaped", "C:\\temp", LIGHT, "![C:\\\\temp](diagrams/arch.svg)"],
    ["angle brackets escaped, so they cannot open a tag", "queue <orders>", LIGHT, "![queue \\<orders\\>](diagrams/arch.svg)"],
    ["an asterisk and underscore pair escaped, so neither turns into emphasis", "A*b* _c_", LIGHT, "![A\\*b\\* \\_c\\_](diagrams/arch.svg)"],
    ["a backtick pair escaped, so it cannot become a code span", "`code` ~~old~~", LIGHT, "![\\`code\\` \\~\\~old\\~\\~](diagrams/arch.svg)"],
    ["an ampersand escaped, so &name; stays as written", "AT&T &copy; !", LIGHT, "![AT\\&T \\&copy; \\!](diagrams/arch.svg)"],
    [
      "a picture with the dark SVG for a dark scheme, its alt escaped for the attribute",
      'R&D "edge" <api>',
      BOTH,
      '<picture><source media="(prefers-color-scheme: dark)" srcset="diagrams/arch.dark.svg">' +
        '<source media="(prefers-color-scheme: light)" srcset="diagrams/arch.svg">' +
        '<img alt="R&amp;D &quot;edge&quot; &lt;api&gt;" src="diagrams/arch.svg"></picture>',
    ],
    [
      "a picture whose alt keeps markdown punctuation as it is, since HTML does not parse it",
      "A*b* `c` [d]",
      BOTH,
      '<picture><source media="(prefers-color-scheme: dark)" srcset="diagrams/arch.dark.svg">' +
        '<source media="(prefers-color-scheme: light)" srcset="diagrams/arch.svg">' +
        '<img alt="A*b* `c` [d]" src="diagrams/arch.svg"></picture>',
    ],
    [
      "a picture of the animated SVG when there is one, the still one first for a reader who asks for reduced motion",
      "a",
      ANIMATED,
      '<picture><source media="(prefers-reduced-motion: reduce)" srcset="diagrams/arch.svg">' +
        '<img alt="a" src="diagrams/arch.animated.svg"></picture>',
    ],
    [
      "a picture of the animated pair when there is one, the still pair first for a reader who asks for reduced motion",
      "a",
      BOTH_ANIMATED,
      '<picture><source media="(prefers-color-scheme: dark) and (prefers-reduced-motion: reduce)" srcset="diagrams/arch.dark.svg">' +
        '<source media="(prefers-reduced-motion: reduce)" srcset="diagrams/arch.svg">' +
        '<source media="(prefers-color-scheme: dark)" srcset="diagrams/arch.dark.animated.svg">' +
        '<source media="(prefers-color-scheme: light)" srcset="diagrams/arch.animated.svg">' +
        '<img alt="a" src="diagrams/arch.animated.svg"></picture>',
    ],
  ])("writes %s", (_case, alt, files, expected) => {
    expect(markdownSnippet(alt, files, BASE)).toBe(expected);
  });

  it.each([
    ["relative to the base, with no leading slash", "/work/project/docs/arch.svg", "docs/arch.svg"],
    ["absolute when the file is outside the base", "/tmp/arch.svg", "/tmp/arch.svg"],
    ["absolute for a sibling of the base that shares its prefix", "/work/project-two/arch.svg", "/work/project-two/arch.svg"],
    ["percent-encoded where a character would end or split the path", "/work/project/my docs/a (v2)#1.svg", "my%20docs/a%20%28v2%29%231.svg"],
  ])("points at the SVG %s", (_case, svg, path) => {
    expect(markdownSnippet("a", { svg }, BASE)).toBe(`![a](${path})`);
  });
});
