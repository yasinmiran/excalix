import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const site = new URL("../site/", import.meta.url);
const BASE = "https://yasinmiran.github.io/excalix/";
// Search Console's ownership file is plain text that has to stay at the root, so it is not a page.
const pages = readdirSync(site).filter((file) => file.endsWith(".html") && !/^google[0-9a-f]+\.html$/.test(file));
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

// A layout change resizes the renders; a page that still reserves the old size jumps as the image loads, and
// its structured data describes a picture that is no longer there.
describe("sizes the site states for the example renders", () => {
  const examples = new URL("../examples/", import.meta.url);
  const svgSize = (name: string) => {
    const root = /<svg[^>]*>/.exec(readFileSync(new URL(name, examples), "utf8"))![0];
    return { width: /\swidth="([^"]+)"/.exec(root)![1], height: /\sheight="([^"]+)"/.exec(root)![1] };
  };
  const pngSize = (name: string) => {
    const header = readFileSync(new URL(name, examples));
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  };

  it.each(pages)("site/%s reserves each SVG at its own size", (page) => {
    for (const [, name, width, height] of read(page).matchAll(/<img src="examples\/([\w-]+\.svg)" width="([^"]+)" height="([^"]+)"/g)) {
      expect({ width, height }, `${page}: ${name}`).toEqual(svgSize(name!));
    }
  });

  it.each(pages)("site/%s gives each PNG its own size in structured data", (page) => {
    for (const [, name, width, height] of read(page).matchAll(/examples\/([\w-]+\.png)", "encodingFormat": "image\/png", "width": (\d+), "height": (\d+)/g)) {
      expect({ width: Number(width), height: Number(height) }, `${page}: ${name}`).toEqual(pngSize(name!));
    }
  });
});
