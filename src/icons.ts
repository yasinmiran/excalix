import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ICON, ICON_GLYPHS } from "./style.js";
import type { IconName } from "./types.js";

/** The vendored glyphs, beside src/ and dist/ alike. */
export const iconsDir = fileURLToPath(new URL("../icons/", import.meta.url));

const drawn = new Map<IconName, string>();

/**
 * The SVG an icon is drawn from, in ICON.color where Lucide leaves currentColor, on its stroke and on the odd filled
 * dot. The vendored file is the editor's normalizeSVG output, and a colour in place of currentColor keeps it one: the
 * editor rewrites any other SVG it opens.
 */
export function iconSvg(name: IconName): string {
  let svg = drawn.get(name);
  if (svg === undefined) {
    const file = readFileSync(`${iconsDir}${ICON_GLYPHS[name]}.svg`, "utf8");
    if (!file.includes(' stroke="currentColor"')) throw new Error(`icons/${ICON_GLYPHS[name]}.svg has no stroke="currentColor" to colour`);
    svg = file.replaceAll("currentColor", ICON.color);
    drawn.set(name, svg);
  }
  return svg;
}
