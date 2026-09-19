import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { pngSize, sizeNote, writeSketch } from "./pipeline.js";
import type { Written } from "./pipeline.js";
import { createBrowserRenderer } from "./render/browser.js";
import { parseSpecWith, SpecError, specSchemaWith, stringField } from "./spec.js";
import type { Renderer } from "./types.js";

const DESCRIPTION = `Draws an architecture diagram. You give the topology, what exists and what talks to what; excalix picks every shape, colour, size and route, so there is nothing visual to configure.

Node kinds:
client: people, browsers, mobile apps, anything that initiates requests.
service: an application component you run, or managed infrastructure you configure inside your own boundary: load balancer, CDN, API gateway, DNS.
datastore: database or durable storage.
queue: message queue, topic, or stream.
cache: cache or in-memory store.
external: a system another company operates and you only call, such as a payment API or a hosted identity provider.

Edge styles:
sync: request/response, solid arrow.
async: message or event, dashed arrow.

A node sits in exactly one group: name the group it runs in, and let an edge across the boundary carry any other relationship.

List nodes in reading order, sources first. That is all order does: place siblings beside each other. It never steers where an arrow is routed; what moves a layout is the direction of an edge, which nodes share a group, and direction itself.

Keep edge labels to a few words, because an edge label sits on its arrow and reserves that much width. A \\n in any label starts a new line. Keep one diagram to roughly twenty nodes, fewer if they run in a single chain: past that the image comes back large enough that the copy you see is scaled down below reading, and the answer is two diagrams, an overview and a detail. Long chains suit lr, deep hierarchies tb.

Look at the returned image and call again with an adjusted spec if labels overlap or the flow reads wrong.`;

const inputSchema = specSchemaWith({
  out: stringField
    .optional()
    .describe(
      "output basename without extension; writes <out>.excalidraw, <out>.svg and <out>.png. Relative paths resolve against the server's working directory, which is the project directory when Claude Code launches the server. Defaults to diagrams/<title slug>.",
    ),
});

const outputSchema = z.object({
  excalidraw: z.string().describe("the .excalidraw file, the one to open on excalidraw.com"),
  svg: z.string().describe("the .svg file"),
  png: z.string().describe("the .png file, the same image as the image block in this result"),
  pixels: z
    .object({ width: z.number(), height: z.number() })
    .describe("size of that png; a very wide one usually means a long label stretched the layout"),
});

// The whole agent-facing contract, served as is by tools/list. A sketch finishes inside the call, so no task.
const TOOL: Tool = {
  name: "sketch",
  description: DESCRIPTION,
  inputSchema: jsonSchema(inputSchema, "input"),
  outputSchema: jsonSchema(outputSchema, "output"),
  execution: { taskSupport: "forbidden" },
};

export interface SketchDeps {
  writeSketch: (input: unknown, basename: string, renderer: Renderer) => Promise<Written>;
  createRenderer: () => Promise<Renderer>;
}

/** Builds the server with its dependencies injected. One renderer per server, opened on first call and released on close. */
export function createServer(deps: SketchDeps, onClose?: () => void): Server {
  const server = new Server({ name: "excalix", version: "0.1.0" }, { capabilities: { tools: {} } });
  let renderer: Promise<Renderer> | undefined;

  const renderReady = (): Promise<Renderer> => {
    renderer ??= deps.createRenderer().catch((error: unknown) => {
      renderer = undefined;
      throw error;
    });
    return renderer;
  };

  const release = (): Promise<void> => {
    const opened = renderer;
    renderer = undefined;
    return opened?.then((it) => it.close()).catch(() => {}) ?? Promise.resolve();
  };

  server.onclose = () => {
    void release().then(() => onClose?.());
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== TOOL.name) throw new McpError(ErrorCode.InvalidParams, `unknown tool "${params.name}"`);
    try {
      const { out, ...spec } = parseSpecWith(inputSchema, params.arguments);
      const { files, result } = await deps.writeSketch(spec, resolve(out ?? defaultOut(spec.title)), await renderReady());
      const lines = [files.excalidraw, files.svg, files.png, sizeNote(result.png)];
      return {
        content: [
          { type: "text", text: lines.filter((line) => line !== undefined).join("\n") },
          { type: "image", data: Buffer.from(result.png).toString("base64"), mimeType: "image/png" },
        ],
        structuredContent: { ...files, pixels: pngSize(result.png) },
      };
    } catch (error) {
      if (error instanceof SpecError) return failure(error.problems.join("\n"));
      void release();
      return failure(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return server;
}

/** Serves the sketch tool over stdio. Resolves when the transport closes. */
export async function serveMcp(): Promise<void> {
  const transport = new StdioServerTransport();
  process.stdin.once("end", () => void transport.close());
  await new Promise<void>((done, fail) => {
    const server = createServer({ writeSketch, createRenderer: createBrowserRenderer }, done);
    server.connect(transport).catch(fail);
  });
}

// A tool pins its schemas to an object at the root; zod types what it serializes wider. Both of these are objects.
function jsonSchema(schema: z.ZodType, io: "input" | "output"): Tool["inputSchema"] {
  return z.toJSONSchema(schema, { target: "draft-7", io }) as Tool["inputSchema"];
}

function defaultOut(title: string | undefined): string {
  const slug = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `diagrams/${slug || "diagram"}`;
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
