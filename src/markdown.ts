import { isAbsolute, relative, sep } from "node:path";
import type { WrittenFiles } from "./pipeline.js";
import type { NodeSpec } from "./types.js";

/** What a reader who cannot see the diagram should hear: its title, or what it is, then every node in reading order. */
export function altText(title: string | undefined, nodes: Pick<NodeSpec, "label">[]): string {
  return `${title ?? "architecture diagram"}: ${nodes.map((node) => node.label).join(", ")}`.replace(/\r?\n|\r/g, " ");
}

const DARK = "(prefers-color-scheme: dark)";
const LIGHT = "(prefers-color-scheme: light)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * Markdown that shows the diagram's SVG, with paths relative to base, the directory relative outputs resolve against.
 * With a dark pair it is a picture that follows the reader's colour scheme, which GitHub renders. With an animated SVG
 * it is a picture of that, whose first sources are the still SVGs for a reader who asks for reduced motion: an SVG
 * shown as an image is not reliably told of that setting, so its own rule for it may never apply.
 */
export function markdownSnippet(alt: string, files: Pick<WrittenFiles, "svg" | "animatedSvg" | "dark">, base: string): string {
  const still = urlOf(files.svg, base);
  const shown = files.animatedSvg === undefined ? still : urlOf(files.animatedSvg, base);
  const sources: [media: string, url: string][] = [];
  if (files.animatedSvg !== undefined) {
    if (files.dark) sources.push([`${DARK} and ${REDUCED_MOTION}`, urlOf(files.dark.svg, base)]);
    sources.push([REDUCED_MOTION, still]);
  }
  if (files.dark) sources.push([DARK, urlOf(files.dark.animatedSvg ?? files.dark.svg, base)], [LIGHT, shown]);
  if (sources.length === 0) return `![${escapeMarkdown(alt)}](${shown})`;
  // The first source whose media matches wins, so the still ones go before the colour schemes.
  const listed = sources.map(([media, url]) => `<source media="${media}" srcset="${escapeAttribute(url)}">`).join("");
  return `<picture>${listed}<img alt="${escapeAttribute(alt)}" src="${escapeAttribute(shown)}"></picture>`;
}

// A path outside base would need climbing out of it, which only holds from one place, so it stays absolute.
// Percent-encoding keeps a space from ending the destination or splitting a srcset, and a bracket from closing it.
function urlOf(file: string, base: string): string {
  const fromBase = relative(base, file);
  const outside = fromBase === ".." || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase);
  const path = (outside ? file : fromBase).split(sep).join("/");
  return encodeURI(path).replace(/[()#?]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Image text is parsed as inline markdown: a bracket would end it early, a backslash escape what follows, a < open
// a tag, an & start an entity, and * _ ` ~ turn into emphasis or code and drop out of the alt text.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_~[\]<>&!]/g, "\\$&");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
