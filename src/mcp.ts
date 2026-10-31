import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { altText, markdownSnippet } from "./markdown.js";
import { pngSize, sizeNote, writeSketch } from "./pipeline.js";
import type { SketchOptions, Written } from "./pipeline.js";
import { createBrowserRenderer } from "./render/browser.js";
import { expectedOneOf, parseSpecWith, SpecError, specSchemaWith, stringField } from "./spec.js";
import { PNG_SCALE } from "./style.js";
import type { Renderer } from "./types.js";
import { version } from "./version.js";

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

List nodes in reading order, sources first. Where edges form a loop, order decides which arrow runs backwards: the one from a node listed later to one listed earlier. Among siblings it is a preference and no more, and the layout reorders some of them when that keeps arrows from crossing. It never steers where an arrow is routed; what moves a layout is the direction of an edge, which nodes share a group, and direction itself.

Keep edge labels to a few words, because an edge label sits on its arrow and the layout makes room for it: past about twenty characters it wraps onto more lines, and a sentence becomes a block that pushes the nodes apart. A \\n in any label starts a new line. Keep one diagram to roughly twenty nodes, fewer if they run in a single chain: past that the image comes back large enough that the copy you see is scaled down below reading, and the answer is two diagrams, an overview and a detail. Long chains suit lr, deep hierarchies tb.

Look at the returned image, and act on the notes when the result has any; call again with an adjusted spec if labels overlap or the flow reads wrong. The image is scaled to fit 2000 pixels a side, and opening the png file whole usually shows you that same copy; to judge a detail, crop that region from the png file, scaling coordinates by pixels.width / preview.width.

The .svg and .png carry the editable scene, so either one dropped on excalidraw.com opens as the drawing. An image optimiser such as SVGO or a PNG crusher strips it, so the .excalidraw stays the source of truth.

The result's markdown shows the SVG in a README or doc. Its path is relative to the directory a relative out resolves against, usually the project root, or absolute when the file is outside it; rewrite it relative to the .md file it goes into.`;

// With tool search on, a client loads only tool names and these instructions at session start, so this is what
// decides whether an agent reaches for sketch at all.
const INSTRUCTIONS = `excalix draws architecture, system and topology diagrams in Excalidraw's hand-drawn style. Use its sketch tool whenever someone asks for one, or for an Excalidraw diagram of a system: you give the nodes, edges and groups, and it picks every shape, colour and route. It writes .excalidraw, .svg and .png files and returns their paths and the image, which you should look at before reporting back. Past about twenty nodes, draw an overview and a detail diagram instead of one. The .svg and .png carry the editable scene, and the result has markdown to put the diagram in a README.`;

const theme = z
  .union(
    [
      z.literal("light").describe("dark lines on white"),
      z.literal("dark").describe("Excalidraw's dark mode, light lines on #121212; <out>.svg and <out>.png come out dark"),
      z.literal("both").describe("the light files, plus <out>.dark.svg and <out>.dark.png, for a page that follows the reader's colour scheme"),
    ],
    { error: expectedOneOf(["light", "dark", "both"]) },
  )
  .default("light")
  .describe("which colour scheme the .svg and .png are drawn in; the .excalidraw is the same scene either way");

const inputSchema = specSchemaWith({
  out: stringField
    .optional()
    .describe(
      "output basename without extension; writes <out>.excalidraw, <out>.svg and <out>.png. Relative paths resolve against the first root the client declares, usually the project directory, or else the server's working directory. Defaults to diagrams/<title slug>.",
    ),
  theme,
});

const outputSchema = z.object({
  excalidraw: z.string().describe("the .excalidraw file, the one to open on excalidraw.com"),
  svg: z.string().describe("the .svg file"),
  png: z.string().describe("the .png file at full size; the image block in this result is a copy that fits 2000 pixels a side"),
  dark: z
    .object({ svg: z.string(), png: z.string() })
    .optional()
    .describe("the .dark.svg and .dark.png files, present when theme is both"),
  pixels: z
    .object({ width: z.number(), height: z.number() })
    .describe("size of the png file; a very wide one usually means a long node label stretched the layout"),
  preview: z
    .object({ width: z.number(), height: z.number() })
    .describe("size of the image block, the png scaled down to fit 2000 pixels a side, or the png itself when it fits"),
  markdown: z
    .string()
    .describe(
      "markdown that shows the svg, with its path relative to the directory a relative out resolves against; a <picture> that follows the reader's colour scheme when theme is both",
    ),
  notes: z
    .array(z.string())
    .optional()
    .describe("what to do about the diagram before showing it, such as splitting one too big to read; absent when there is nothing"),
});

// The whole agent-facing contract, served as is by tools/list. A sketch finishes inside the call, so no task.
const TOOL: Tool = {
  name: "sketch",
  description: DESCRIPTION,
  inputSchema: jsonSchema(inputSchema, "input"),
  outputSchema: jsonSchema(outputSchema, "output"),
  execution: { taskSupport: "forbidden" },
};

// roots/list is answered by the client itself, so anything slower than this is a client that will not answer.
const ROOTS_TIMEOUT_MS = 2000;


export interface SketchDeps {
  writeSketch: (input: unknown, basename: string, renderer: Renderer, options: SketchOptions) => Promise<Written>;
  createRenderer: () => Promise<Renderer>;
}

/** Builds the server with its dependencies injected. One renderer per server, opened on first call and released on close. */
export function createServer(deps: SketchDeps, onClose?: () => void): Server {
  const server = new Server({ name: "excalix", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
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
      const { out, theme, ...spec } = parseSpecWith(inputSchema, params.arguments);
      const target = out ?? defaultOut(spec.title);
      // Asked even for an absolute out, since the markdown path is written relative to the same directory.
      const base = await baseDirectory(server);
      const basename = isAbsolute(target) ? target : resolve(base, target);
      const { files, result } = await deps.writeSketch(spec, basename, await renderReady(), { theme, preview: true });
      const shown = result.preview ?? { png: result.png, scale: PNG_SCALE };
      const pixels = pngSize(result.png);
      const preview = pngSize(shown.png);
      const notes = [sizeNote(pixels, { ...preview, scale: shown.scale })].filter((note) => note !== undefined);
      const markdown = markdownSnippet(altText(spec.title, spec.nodes), files, base);
      const structuredContent = { ...files, pixels, preview, markdown, ...(notes.length > 0 && { notes }) };
      // Claude Code shows the model the image and structuredContent and drops text blocks, so the text block is
      // the same JSON, as the spec asks, and a client that reads only content loses nothing either.
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent) },
          { type: "image", data: Buffer.from(shown.png).toString("base64"), mimeType: "image/png" },
        ],
        structuredContent,
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

// Asked per call rather than cached, so a root the client changes needs no list_changed bookkeeping.
async function baseDirectory(server: Server): Promise<string> {
  if (server.getClientCapabilities()?.roots === undefined) return process.cwd();
  try {
    const [first] = (await server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS })).roots;
    return first === undefined ? process.cwd() : fileURLToPath(first.uri);
  } catch {
    return process.cwd();
  }
}

function defaultOut(title: string | undefined): string {
  const slug = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `diagrams/${slug || "diagram"}`;
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
