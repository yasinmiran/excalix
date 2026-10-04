import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const site = new URL("../site/", import.meta.url);
const BASE = "https://yasinmiran.github.io/excalix/";
const pages = readdirSync(site).filter((file) => file.endsWith(".html"));
const indexed = pages.filter((page) => page !== "404.html");
const read = (page: string) => readFileSync(new URL(page, site), "utf8");

// Pages serves the site under /excalix/, so a root-absolute link leaves it, and the publish step
// copies examples/ in beside the pages, so a render the site names has to exist there.
describe.each(pages)("site/%s", (page) => {
  const html = read(page);
  const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((match) => match[1]!);

  it("uses no long dashes", () => {
    expect(html).not.toMatch(/[–—]|&mdash;|&ndash;/);
  });

  it("links inside the site or by full URL", () => {
    expect(refs.filter((ref) => ref.startsWith("/") && !ref.startsWith("//"))).toEqual([]);
  });

  it("points only at files that will be there", () => {
    const local = refs.filter((ref) => !/^[a-z]+:/.test(ref) && !ref.startsWith("//"));
    const missing = local.filter((ref) => {
      const path = ref.split("?")[0]!;
      return path.startsWith("examples/") ? !existsSync(new URL(`../${path}`, import.meta.url)) : !existsSync(new URL(path, site));
    });
    expect(missing).toEqual([]);
  });
});

describe.each(indexed)("site/%s for search", (page) => {
  const html = read(page);
  const url = page === "index.html" ? BASE : BASE + page;

  it("has one h1, a canonical URL and a description", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="${url}">`);
    expect(html).toMatch(/<meta name="description" content="[^"]{50,170}">/);
  });

  it("is in the sitemap", () => {
    expect(read("sitemap.xml")).toContain(`<loc>${url}</loc>`);
  });

  it("carries structured data that parses", () => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, json] of blocks) expect(() => JSON.parse(json!)).not.toThrow();
  });
});

it("names the version the package is at", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(read("index.html")).toContain(`"softwareVersion": "${version}"`);
});
