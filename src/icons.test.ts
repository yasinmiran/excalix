import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { iconsDir, iconSvg } from "./icons.js";
import { ICON_NAMES } from "./spec.js";
import { ICON, ICON_GLYPHS } from "./style.js";

const readme = readFileSync(`${iconsDir}README.md`, "utf8");

describe("icon catalog", () => {
  it.each(ICON_NAMES)("draws %s in the icon colour from a plain vendored SVG", (name) => {
    const svg = iconSvg(name);

    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24" /);
    expect(svg).toContain(`stroke="${ICON.color}"`);
    expect(svg).not.toContain("currentColor");
    // An image draws in Chromium's secure mode, which blocks these, so a glyph holding one would draw differently.
    expect(svg).not.toMatch(/<script|<text|<foreignObject|<image|href=|<style|<!--|<\?xml/);
  });

  it("ships exactly the files the catalog draws, beside the licence and the notice", () => {
    const shipped = readdirSync(iconsDir).sort();
    const drawn = Object.values(ICON_GLYPHS).map((glyph) => `${glyph}.svg`);

    expect(new Set(drawn).size).toBe(drawn.length);
    expect(shipped).toEqual([...drawn, "LICENSE-lucide.txt", "README.md"].sort());
  });

  it("records every name and the file it draws in the notice", () => {
    const rows = [...readme.matchAll(/^\| `([a-z]+)` \| `([a-z-]+)\.svg` \|$/gm)].map(([, name, glyph]) => [name, glyph]);

    expect(Object.fromEntries(rows)).toEqual(ICON_GLYPHS);
    expect(rows.map(([name]) => name)).toEqual([...ICON_NAMES]);
  });
});
