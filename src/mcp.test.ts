import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ListRootsResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { createServer } from "./mcp.js";
import type { SketchDeps } from "./mcp.js";
import type { SketchOptions } from "./pipeline.js";
import { SpecError } from "./spec.js";
import type { Renderer } from "./types.js";

// Signature, chunk length, IHDR, then the size the tool reads back: 2404 x 811.
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 9, 100, 0, 0, 3, 43]);
const PIXELS = { width: 2404, height: 811 };

// The same header at 7929 x 1775, past the size the tool speaks up about.
const BIG_PNG = header(7929, 1775);

function header(width: number, height: number): Uint8Array {
  const bytes = PNG.slice();
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const SPEC = {
  title: "order pipeline",
  nodes: [
    { id: "web", label: "Web app", kind: "client" },
    { id: "api", label: "Order API", kind: "service" },
  ],
  edges: [{ from: "web", to: "api", label: "POST /orders" }],
};

const KINDS = '"client", "service", "datastore", "queue", "cache", "external"';

// Wrong against the schema, twice over, and wrong about its own ids: one call has to answer all three.
const WRONG_BOTH_WAYS = {
  title: "order pipeline",
  nodes: [{ id: "web", label: "Web app", kind: "browser", colour: "blue" }],
  edges: [{ from: "web", to: "api" }],
};

const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function fakeRenderer(): Renderer {
  return {
    measurer: { measure: async (texts) => texts.map(() => ({ width: 10, height: 10 })) },
    svg: async () => "<svg/>",
    png: async () => PNG,
    close: async () => {},
  };
}

type Roots = () => ListRootsResult | Promise<ListRootsResult>;

// A client passed roots declares the capability, with change notices, and answers roots/list with it; without, it
// declares none.
async function harness(overrides: Partial<SketchDeps> = {}, roots?: Roots) {
  const dir = await mkdtemp(join(tmpdir(), "excalix-mcp-"));
  const close = vi.fn(async () => {});
  const createRenderer = vi.fn(async () => ({ ...fakeRenderer(), close }));
  const writeSketch = vi.fn(async (_input: unknown, basename: string, _renderer: Renderer, _options: SketchOptions) => ({
    files: { excalidraw: `${basename}.excalidraw`, svg: `${basename}.svg`, png: `${basename}.png` },
    result: { excalidraw: "", svg: "", png: PNG },
  }));

  const server = createServer({ writeSketch, createRenderer, ...overrides });
  const client = new Client({ name: "test", version: "0" }, { capabilities: roots === undefined ? {} : { roots: { listChanged: true } } });
  if (roots !== undefined) client.setRequestHandler(ListRootsRequestSchema, roots);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  disposers.push(async () => {
    await client.close();
  });

  return { client, close, createRenderer, writeSketch, out: join(dir, "diagram") };
}

async function sketchTool(): Promise<Record<string, unknown>> {
  const { client } = await harness();
  const { tools } = await client.listTools();
  const sketch = tools.find((tool) => tool.name === "sketch");
  if (sketch === undefined) throw new Error("the server advertises no sketch tool");
  return sketch as unknown as Record<string, unknown>;
}

// The contract an agent reads on every call, as one reviewable page: any wording or schema change is a diff.
function page(tool: Record<string, unknown>): string {
  const { name, description, ...rest } = tool;
  const sections = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `## ${key}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
  return `${[`# ${String(name)}`, String(description), ...sections].join("\n\n")}\n`;
}

async function cliSchema(): Promise<Record<string, unknown>> {
  const printed: string[] = [];
  const code = await main(["schema"], { stdout: (s) => printed.push(s), stderr: () => {} });
  expect(code).toBe(0);
  return JSON.parse(printed[0]!) as Record<string, unknown>;
}

async function cliProblems(spec: unknown): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "excalix-cli-")), "spec.json");
  await writeFile(path, JSON.stringify(spec));
  const printed: string[] = [];
  const code = await main(["validate", path], { stdout: () => {}, stderr: (s) => printed.push(s) });
  expect(code).toBe(1);
  return printed.join("\n");
}

describe("sketch tool", () => {
  it("advertises the contract in the snapshot", async () => {
    await expect(page(await sketchTool())).toMatchFileSnapshot("./__snapshots__/sketch-tool.md");
  });

  it("hands the client its instructions at initialize, as in the snapshot", async () => {
    const { client } = await harness();

    const instructions = client.getInstructions();

    expect(instructions).toBeDefined();
    await expect(`# excalix server instructions\n\n${instructions}\n`).toMatchFileSnapshot("./__snapshots__/server-instructions.md");
    // The MCP page quotes them whole, so a change here is a change there.
    expect(await readFile(new URL("../site/mcp.html", import.meta.url), "utf8")).toContain(`<p>${instructions}</p>`);
  });

  it("advertises the same spec as excalix schema, plus out and theme", async () => {
    const advertised = structuredClone(await sketchTool()).inputSchema as {
      $schema?: string;
      properties: Record<string, { description?: string }>;
    };
    const printed = await cliSchema();

    expect(advertised.properties.out?.description).toContain("<out>.excalidraw");
    expect(advertised.properties.theme?.description).toContain("colour scheme");
    delete advertised.properties.out;
    delete advertised.properties.theme;
    // One zod schema, serialized twice: the tool targets draft 7, the CLI the draft zod defaults to.
    delete advertised.$schema;
    expect(printed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    delete printed.$schema;
    expect(advertised).toEqual(printed);
  });

  it("returns the paths and the png size as structured content, and the png", async () => {
    const { client, out, writeSketch } = await harness();

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      excalidraw: `${out}.excalidraw`,
      svg: `${out}.svg`,
      png: `${out}.png`,
      pixels: PIXELS,
      preview: PIXELS,
      markdown: `![order pipeline: Web app, Order API](${out}.svg)`,
    });
    const [, image] = blocks(result);
    expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(writeSketch.mock.calls[0]?.[0]).toMatchObject({ nodes: SPEC.nodes, direction: "lr", groups: [] });
  });

  // Claude Code drops text blocks from a result with structured content, and other clients read only the content,
  // so each has to carry the whole answer.
  it("serializes the structured content as its text block", async () => {
    const { client, out } = await harness();

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    const [text] = blocks(result);
    expect(text?.type).toBe("text");
    expect(JSON.parse(text!.text!)).toEqual(result.structuredContent);
  });

  it("adds a note when the png is too big to read scaled down", async () => {
    const { client, out } = await harness({
      writeSketch: async (_input, basename) => ({
        files: { excalidraw: `${basename}.excalidraw`, svg: `${basename}.svg`, png: `${basename}.png` },
        result: { excalidraw: "", svg: "", png: BIG_PNG },
      }),
    });

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(result.structuredContent).toMatchObject({
      pixels: { width: 7929, height: 1775 },
      notes: [
        "note: a model reads this diagram at 2000x448 px, where its edge labels are about 8px tall, too small to read. Split it into an overview and a detail diagram, or shorten the longest labels; the PNG on disk keeps the full 7929x1775.",
      ],
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("hands back the preview as the image, and judges the note by it", async () => {
    const preview = header(2000, 448);
    const { client, out } = await harness({
      writeSketch: async (_input, basename) => ({
        files: { excalidraw: `${basename}.excalidraw`, svg: `${basename}.svg`, png: `${basename}.png` },
        result: { excalidraw: "", svg: "", png: BIG_PNG, preview: { png: preview, scale: 4000 / 7929 } },
      }),
    });

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(blocks(result)[1]).toMatchObject({ type: "image", data: Buffer.from(preview).toString("base64") });
    expect(result.structuredContent).toMatchObject({
      pixels: { width: 7929, height: 1775 },
      preview: { width: 2000, height: 448 },
      notes: [expect.stringContaining("reads this diagram at 2000x448 px, where its edge labels are about 8px tall")],
    });
  });

  it("asks the pipeline for a preview", async () => {
    const { client, out, writeSketch } = await harness();

    await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(writeSketch.mock.calls[0]?.[3]).toMatchObject({ preview: true });
  });

  it("defaults out to diagrams/<title slug>", async () => {
    const { client, writeSketch } = await harness();

    await client.callTool({ name: "sketch", arguments: { ...SPEC, title: "Order Pipeline v2" } });

    expect(writeSketch.mock.calls[0]?.[1]).toBe(resolve("diagrams/order-pipeline-v2"));
  });

  it("resolves a relative out against the first root the client declares", async () => {
    const project = await mkdtemp(join(tmpdir(), "excalix-root-"));
    const roots = [{ uri: pathToFileURL(project).href, name: "project" }, { uri: pathToFileURL(tmpdir()).href }];
    const { client, writeSketch } = await harness({}, () => ({ roots }));

    await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "docs/pipeline" } });
    await client.callTool({ name: "sketch", arguments: SPEC });

    expect(writeSketch.mock.calls.map((call) => call[1])).toEqual([
      join(project, "docs/pipeline"),
      join(project, "diagrams/order-pipeline"),
    ]);
  });

  it("resolves a relative out against the server's directory when the client declares no roots", async () => {
    const { client, writeSketch } = await harness();

    await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "docs/pipeline" } });

    expect(writeSketch.mock.calls[0]?.[1]).toBe(resolve("docs/pipeline"));
  });

  it("keeps an absolute out as given, and writes its markdown path relative to the first root", async () => {
    const project = await mkdtemp(join(tmpdir(), "excalix-root-"));
    const out = join(project, "docs/arch");
    const { client, writeSketch } = await harness({}, () => ({ roots: [{ uri: pathToFileURL(project).href }] }));

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(writeSketch.mock.calls[0]?.[1]).toBe(out);
    expect(result.structuredContent).toMatchObject({ markdown: "![order pipeline: Web app, Order API](docs/arch.svg)" });
  });

  it("asks for roots once per connection, and again after the client says they changed", async () => {
    const [first, second] = [await mkdtemp(join(tmpdir(), "excalix-root-")), await mkdtemp(join(tmpdir(), "excalix-root-"))];
    let current = first;
    const roots = vi.fn(() => ({ roots: [{ uri: pathToFileURL(current).href }] }));
    const { client, writeSketch } = await harness({}, roots);

    await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "a" } });
    await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "b" } });
    current = second;
    await client.sendRootsListChanged();
    await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "c" } });

    expect(roots).toHaveBeenCalledTimes(2);
    expect(writeSketch.mock.calls.map((call) => call[1])).toEqual([join(first, "a"), join(first, "b"), join(second, "c")]);
  });

  it("waits for a client that never answers roots/list only once", async () => {
    const roots = vi.fn(() => new Promise<ListRootsResult>(() => {}));
    const { client, writeSketch } = await harness({}, roots);

    await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "a" } });
    const started = performance.now();
    await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "b" } });

    expect(performance.now() - started).toBeLessThan(1000);
    expect(roots).toHaveBeenCalledOnce();
    expect(writeSketch.mock.calls.map((call) => call[1])).toEqual([resolve("a"), resolve("b")]);
  }, 5000);

  it("gives a picture that follows the colour scheme when there is a dark pair", async () => {
    const project = await mkdtemp(join(tmpdir(), "excalix-root-"));
    const { client } = await harness(
      {
        writeSketch: async (_input, basename) => ({
          files: {
            excalidraw: `${basename}.excalidraw`,
            svg: `${basename}.svg`,
            png: `${basename}.png`,
            dark: { svg: `${basename}.dark.svg`, png: `${basename}.dark.png` },
          },
          result: { excalidraw: "", svg: "", png: PNG, dark: { svg: "", png: PNG } },
        }),
      },
      () => ({ roots: [{ uri: pathToFileURL(project).href }] }),
    );

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, title: undefined, theme: "both" } });

    expect(result.structuredContent).toMatchObject({
      markdown:
        '<picture><source media="(prefers-color-scheme: dark)" srcset="diagrams/diagram.dark.svg">' +
        '<source media="(prefers-color-scheme: light)" srcset="diagrams/diagram.svg">' +
        '<img alt="architecture diagram: Web app, Order API" src="diagrams/diagram.svg"></picture>',
    });
  });

  // The SDK waits a minute for an answer by default; the test timeout is what proves a silent client costs less.
  it.each<[string, Roots]>([
    ["fails", () => Promise.reject(new Error("no workspace open"))],
    ["never answers", () => new Promise(() => {})],
    ["returns no roots", () => ({ roots: [] })],
    ["returns a root that is not a file URL", () => ({ roots: [{ uri: "https://example.com/repo" }] })],
  ])(
    "falls back to the server's directory when roots/list %s",
    async (_case, roots) => {
      const { client, writeSketch } = await harness({}, roots);

      const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out: "docs/pipeline" } });

      expect(result.isError).toBeFalsy();
      expect(writeSketch.mock.calls[0]?.[1]).toBe(resolve("docs/pipeline"));
    },
    5000,
  );

  it("reuses one renderer and closes it when the transport closes", async () => {
    const { client, close, createRenderer, out } = await harness();

    await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });
    await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });
    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    await client.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  // The promise the tool makes: one call, every problem, whichever half of the validation found it.
  it("reports the schema and the semantic problems of one spec together", async () => {
    const { client, createRenderer, out, writeSketch } = await harness();

    const result = await client.callTool({ name: "sketch", arguments: { ...WRONG_BOTH_WAYS, out } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      [
        `nodes[0].kind: got "browser", expected one of ${KINDS}`,
        'nodes[0]: unknown key "colour", expected one of "id", "label", "kind", "group"',
        'edges[0].to: unknown node "api"',
      ].join("\n"),
    );
    expect(textOf(result)).toBe(await cliProblems(WRONG_BOTH_WAYS));
    expect(writeSketch).not.toHaveBeenCalled();
    expect(createRenderer).not.toHaveBeenCalled();
  });

  it("reports an out that is not a string in the same list", async () => {
    const { client } = await harness();

    const result = await client.callTool({
      name: "sketch",
      arguments: { ...SPEC, edges: [{ from: "web", to: "apy" }], out: 5 },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('out: got 5, expected a string\nedges[0].to: unknown node "apy", did you mean "api"?');
  });

  it("reports a theme it does not draw in the same list", async () => {
    const { client } = await harness();

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out: 5, theme: "sepia" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('out: got 5, expected a string\ntheme: got "sepia", expected one of "light", "dark", "both"');
  });

  it.each(["light", "dark", "both"] as const)("passes theme %s to the pipeline, and light when there is none", async (theme) => {
    const { client, out, writeSketch } = await harness();

    await client.callTool({ name: "sketch", arguments: { ...SPEC, out, theme } });
    await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(writeSketch.mock.calls.map((call) => call[3].theme)).toEqual([theme, "light"]);
    expect(writeSketch.mock.calls[0]?.[0]).not.toHaveProperty("theme");
  });

  it("names the dark files when there are some", async () => {
    const { client, out } = await harness({
      writeSketch: async (_input, basename) => ({
        files: {
          excalidraw: `${basename}.excalidraw`,
          svg: `${basename}.svg`,
          png: `${basename}.png`,
          dark: { svg: `${basename}.dark.svg`, png: `${basename}.dark.png` },
        },
        result: { excalidraw: "", svg: "", png: PNG, dark: { svg: "", png: PNG } },
      }),
    });

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out, theme: "both" } });

    expect(result.structuredContent).toMatchObject({ dark: { svg: `${out}.dark.svg`, png: `${out}.dark.png` } });
    expect(Object.keys(result.structuredContent!).slice(0, 4)).toEqual(["excalidraw", "svg", "png", "dark"]);
  });

  it("reports a call with no arguments at all", async () => {
    const { client } = await harness();

    const result = await client.callTool({ name: "sketch" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("spec: missing, expected an object");
  });

  it("refuses a tool it does not serve", async () => {
    const { client } = await harness();

    await expect(client.callTool({ name: "draw", arguments: {} })).rejects.toThrow('MCP error -32602: unknown tool "draw"');
  });

  it("reports the problems of a spec the pipeline rejects", async () => {
    const problems = ['nodes[1].id: duplicate id "web"', 'edges[0].to: unknown node "apy"'];
    const { client, out } = await harness({
      writeSketch: async () => {
        throw new SpecError(problems);
      },
    });

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(problems.join("\n"));
  });

  it("survives a renderer that will not start", async () => {
    const { client, out } = await harness({
      createRenderer: async () => {
        throw new Error("chromium missing");
      },
    });

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("error: chromium missing");
    expect((await client.listTools()).tools).toHaveLength(1);
  });
});

interface Block {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

function blocks(result: unknown): Block[] {
  return (result as { content?: Block[] }).content ?? [];
}

function textOf(result: unknown): string {
  return blocks(result)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
