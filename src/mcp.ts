import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeSketch } from "./pipeline.js";
import type { Written } from "./pipeline.js";
import { createBrowserRenderer } from "./render/browser.js";
import { SpecError, specSchema } from "./spec.js";
import type { Renderer } from "./types.js";

const DESCRIPTION = `Draws an architecture diagram. You give the topology, what exists and what talks to what; excalix picks every shape, colour, size and route, so there is nothing visual to configure. The same spec always draws the same picture. Alongside the PNG you get back, an .excalidraw file lands on disk that opens on excalidraw.com for hand editing.

Node kinds:
client: people, browsers, mobile apps, anything that initiates requests.
service: an application component you run.
datastore: database or durable storage.
queue: message queue, topic, or stream.
cache: cache or in-memory store.
external: third-party system you don't run.

Edge styles:
sync: request/response, solid arrow.
async: message or event, dashed arrow.

Look at the returned image and call again with an adjusted spec if labels overlap or the flow reads wrong.`;

const inputSchema = specSchema.extend({
  out: z
    .string()
    .optional()
    .describe(
      "output basename without extension, absolute or relative to the server's cwd; writes <out>.excalidraw, <out>.svg and <out>.png. Defaults to diagrams/<title slug>.",
    ),
});

export interface SketchDeps {
  writeSketch: (input: unknown, basename: string, renderer: Renderer) => Promise<Written>;
  createRenderer: () => Promise<Renderer>;
}

/** Builds the server with its dependencies injected. One renderer per server, opened on first call and released on close. */
export function createServer(deps: SketchDeps, onClose?: () => void): McpServer {
  const server = new McpServer({ name: "excalix", version: "0.1.0" });
  let renderer: Promise<Renderer> | undefined;

  const renderReady = (): Promise<Renderer> => {
    renderer ??= deps.createRenderer().catch((error: unknown) => {
      renderer = undefined;
      throw error;
    });
    return renderer;
  };

  server.server.onclose = () => {
    const opened = renderer;
    renderer = undefined;
    void opened?.then((it) => it.close()).catch(() => {});
    onClose?.();
  };

  server.registerTool("sketch", { description: DESCRIPTION, inputSchema }, async (args) => {
    const { out, ...spec } = args;
    try {
      const { files, result } = await deps.writeSketch(spec, resolve(out ?? defaultOut(spec.title)), await renderReady());
      return {
        content: [
          { type: "text", text: [files.excalidraw, files.svg, files.png].join("\n") },
          { type: "image", data: Buffer.from(result.png).toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (error) {
      if (error instanceof SpecError) return failure(error.problems.join("\n"));
      return failure(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return server;
}

/** Serves the sketch tool over stdio. Resolves when the transport closes. */
export async function serveMcp(): Promise<void> {
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((done) => {
    const server = createServer({ writeSketch, createRenderer: createBrowserRenderer }, done);
    void server.connect(transport);
  });
  process.stdin.once("end", () => void transport.close());
  await closed;
}

function defaultOut(title: string | undefined): string {
  const slug = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `diagrams/${slug || "diagram"}`;
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
