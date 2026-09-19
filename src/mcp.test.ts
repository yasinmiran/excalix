import { mkdtemp } from "node:fs/promises";
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

const SPEC = {
  title: "order pipeline",
  nodes: [
    { id: "web", label: "Web app", kind: "client" },
    { id: "api", label: "Order API", kind: "service" },
  ],
  edges: [{ from: "web", to: "api", label: "POST /orders" }],
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
    // Two serializers of one zod schema: the CLI's own, and zod mini's inside the MCP SDK, which targets draft 7.
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

  // The SDK checks the advertised schema before the handler runs, so these problems arrive in its wording.
  it("rejects a spec that breaks the schema before it reaches the pipeline", async () => {
    const { client, out, writeSketch } = await harness();

    const unknownKey = await client.callTool({ name: "sketch", arguments: { ...SPEC, out, colour: "blue" } });
    const badKind = await client.callTool({
      name: "sketch",
      arguments: { ...SPEC, out, nodes: [{ id: "a", label: "A", kind: "db" }] },
    });

    expect(unknownKey.isError).toBe(true);
    expect(textOf(unknownKey)).toBe(
      'MCP error -32602: Input validation error: Invalid arguments for tool sketch: unknown key "colour", ' +
        'expected one of "title", "direction", "groups", "nodes", "edges", "out"',
    );
    expect(textOf(badKind)).toBe(
      'MCP error -32602: Input validation error: Invalid arguments for tool sketch: got "db", expected one of ' +
        '"client", "service", "datastore", "queue", "cache", "external" at nodes[0].kind',
    );
    expect(writeSketch).not.toHaveBeenCalled();
  });

  it("reports every spec problem", async () => {
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
