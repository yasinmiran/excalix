import { isAbsolute, relative, sep } from "node:path";
import type { WrittenFiles } from "./pipeline.js";
import type { NodeSpec } from "./types.js";

/** What a reader who cannot see the diagram should hear: its title, or what it is, then every node in reading order. */
export function altText(title: string | undefined, nodes: Pick<NodeSpec, "label">[]): string {
  return `${title ?? "architecture diagram"}: ${nodes.map((node) => node.label).join(", ")}`.replace(/\r?\n|\r/g, " ");
}

/**
 * Markdown that shows the diagram's SVG, with paths relative to base, the directory relative outputs resolve
 * against. With a dark pair it is a picture that follows the reader's colour scheme, which GitHub renders.
 */
export function markdownSnippet(alt: string, files: Pick<WrittenFiles, "svg" | "dark">, base: string): string {
  const light = urlOf(files.svg, base);
  if (!files.dark) return `![${escapeMarkdown(alt)}](${light})`;
  const dark = urlOf(files.dark.svg, base);
  return (
    `<picture><source media="(prefers-color-scheme: dark)" srcset="${escapeAttribute(dark)}">` +
    `<source media="(prefers-color-scheme: light)" srcset="${escapeAttribute(light)}">` +
    `<img alt="${escapeAttribute(alt)}" src="${escapeAttribute(light)}"></picture>`
  );
}

// A path outside base would need climbing out of it, which only holds from one place, so it stays absolute.
// Percent-encoding keeps a space from ending the destination or splitting a srcset, and a bracket from closing it.
function urlOf(file: string, base: string): string {
  const fromBase = relative(base, file);
  const outside = fromBase === ".." || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase);
  const path = (outside ? file : fromBase).split(sep).join("/");
  return encodeURI(path).replace(/[()#?]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

// A bracket would end the image text early, a backslash would escape what follows it, and a < could open an HTML tag.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\[\]<]/g, "\\$&");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
