import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { createServer } from "./mcp.js";
import type { SketchDeps } from "./mcp.js";
import { SpecError } from "./spec.js";
import type { Renderer } from "./types.js";

// Signature, chunk length, IHDR, then the size the tool reads back: 2404 x 811.
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 9, 100, 0, 0, 3, 43]);
const PIXELS = { width: 2404, height: 811 };

// The same header at 7929 x 1775, past the size the tool speaks up about.
const BIG_PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 30, 249, 0, 0, 6, 239]);

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

async function harness(overrides: Partial<SketchDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "excalix-mcp-"));
  const close = vi.fn(async () => {});
  const createRenderer = vi.fn(async () => ({ ...fakeRenderer(), close }));
  const writeSketch = vi.fn(async (_input: unknown, basename: string) => ({
    files: { excalidraw: `${basename}.excalidraw`, svg: `${basename}.svg`, png: `${basename}.png` },
    result: { excalidraw: "", svg: "", png: PNG },
  }));

  const server = createServer({ writeSketch, createRenderer, ...overrides });
  const client = new Client({ name: "test", version: "0" });
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

  it("advertises the same spec as excalix schema, plus out", async () => {
    const advertised = structuredClone(await sketchTool()).inputSchema as {
      $schema?: string;
      properties: Record<string, { description?: string }>;
    };
    const printed = await cliSchema();

    expect(advertised.properties.out?.description).toContain("<out>.excalidraw");
    delete advertised.properties.out;
    // One zod schema, serialized twice: the tool targets draft 7, the CLI the draft zod defaults to.
    delete advertised.$schema;
    expect(printed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    delete printed.$schema;
    expect(advertised).toEqual(printed);
  });

  it("returns the written paths and the png", async () => {
    const { client, out, writeSketch } = await harness();

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(result.isError).toBeFalsy();
    const [text, image] = blocks(result);
    expect(text).toMatchObject({ type: "text", text: `${out}.excalidraw\n${out}.svg\n${out}.png` });
    expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") });
    expect(writeSketch.mock.calls[0]?.[0]).toMatchObject({ nodes: SPEC.nodes, direction: "lr", groups: [] });
  });

  it("repeats the paths and the png size as structured content", async () => {
    const { client, out } = await harness();

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(result.structuredContent).toEqual({
      excalidraw: `${out}.excalidraw`,
      svg: `${out}.svg`,
      png: `${out}.png`,
      pixels: PIXELS,
    });
  });

  it("adds one line to the text block when the png is too big to read scaled down", async () => {
    const { client, out } = await harness({
      writeSketch: async (_input, basename) => ({
        files: { excalidraw: `${basename}.excalidraw`, svg: `${basename}.svg`, png: `${basename}.png` },
        result: { excalidraw: "", svg: "", png: BIG_PNG },
      }),
    });

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out } });

    expect(textOf(result)).toBe(
      [
        `${out}.excalidraw`,
        `${out}.svg`,
        `${out}.png`,
        "note: 7929x1775 px, too big to read once it is scaled down. Split it into an overview and a detail diagram, or shorten the longest labels.",
      ].join("\n"),
    );
    expect(result.structuredContent).toMatchObject({ pixels: { width: 7929, height: 1775 } });
  });

  it("defaults out to diagrams/<title slug>", async () => {
    const { client, writeSketch } = await harness();

    await client.callTool({ name: "sketch", arguments: { ...SPEC, title: "Order Pipeline v2" } });

    expect(writeSketch.mock.calls[0]?.[1]).toBe(resolve("diagrams/order-pipeline-v2"));
  });

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
