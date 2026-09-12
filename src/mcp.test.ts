import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./mcp.js";
import type { SketchDeps } from "./mcp.js";
import { SpecError } from "./spec.js";
import type { Renderer } from "./types.js";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

function choices(schema: unknown): unknown[] {
  const node = schema as { enum?: unknown[]; anyOf?: { const?: unknown }[] };
  return node.enum ?? (node.anyOf ?? []).map((member) => member.const);
}

describe("sketch tool", () => {
  it("advertises a strict input schema carrying the spec", async () => {
    const { client } = await harness();

    const { tools } = await client.listTools();
    const sketch = tools.find((tool) => tool.name === "sketch");

    expect(sketch?.description).toContain("third-party system you don't run");
    const schema = sketch?.inputSchema as {
      additionalProperties?: unknown;
      required?: string[];
      properties: Record<string, { description?: string; items?: { properties?: Record<string, unknown> } }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.out?.description).toContain("<out>.excalidraw");
    expect(choices(schema.properties.nodes?.items?.properties?.kind)).toEqual([
      "client",
      "service",
      "datastore",
      "queue",
      "cache",
      "external",
    ]);
    expect(schema.required).toEqual(["nodes"]);
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

  it("rejects an unknown key", async () => {
    const { client, out, writeSketch } = await harness();

    const result = await client.callTool({ name: "sketch", arguments: { ...SPEC, out, colour: "blue" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unrecognized key: "colour"');
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
