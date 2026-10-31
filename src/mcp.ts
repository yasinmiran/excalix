import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

const DESCRIPTION = `Draws an architecture diagram. You give the topology, what exists and what talks to what; excalix picks every shape, colour, size and route. A node's kind and its optional icon both name what the node is, and excalix decides how either is drawn, so there is nothing visual to configure.

Node kinds:
client: people, browsers, mobile apps, anything that initiates requests.
service: an application component you run, or managed infrastructure you configure inside your own boundary: load balancer, CDN, API gateway, DNS.
datastore: database or durable storage.
queue: message queue, topic, or stream.
cache: cache or in-memory store.
external: a system another company operates and you only call, such as a payment API or a hosted identity provider.

Icons, optional, one per node, drawn left of its label: user, users, browser, phone, desktop, terminal, bot (an AI agent or model), globe (the internet, DNS, a CDN), cloud, gateway (API gateway, load balancer, ingress), server, container, function (serverless), database, cache, queue, storage (object or block storage), search, file, mail, chat, bell (notifications), webhook, payment, lock (auth), key (secrets, API keys), shield (security, WAF), chart (metrics, analytics), logs, clock (scheduler, cron), settings (configuration), git (source control, CI). Give the one that says what the node is, or leave it out: an icon widens its node, and a near miss misleads more than no icon does.

Edge styles:
sync: request/response, solid arrow.
async: message or event, dashed arrow.

A node sits in exactly one group: name the group it runs in, and let an edge across the boundary carry any other relationship.

List nodes in reading order, sources first. Where edges form a loop, order decides which arrow runs backwards: the one from a node listed later to one listed earlier. Among siblings it is a preference and no more, and the layout reorders some of them when that keeps arrows from crossing. It never steers where an arrow is routed; what moves a layout is the direction of an edge, which nodes share a group, and direction itself.

Keep edge labels to a few words, because an edge label sits on its arrow and the layout makes room for it: past about twenty characters it wraps onto more lines, and a sentence becomes a block that pushes the nodes apart. A \\n in any label starts a new line. Keep one diagram to roughly twenty nodes, fewer if they run in a single chain: past that the image comes back large enough that the copy you see is scaled down below reading, and the answer is two diagrams, an overview and a detail. Long chains suit lr, deep hierarchies tb.

Look at the returned image, and act on the notes when the result has any; call again with an adjusted spec if labels overlap or the flow reads wrong. The image is scaled to fit 2000 pixels a side, and opening the png file whole usually shows you that same copy; to judge a detail, crop that region from the png file, scaling coordinates by pixels.width / preview.width.

For a README or a web page, animate draws the diagram again as <out>.animated.svg, building itself in a loop: story brings in each edge in the order you list them, after its two ends, and layers brings in the layout one layer at a time along the flow. The image you get back stays the finished diagram.

The .svg and .png carry the editable scene, so either one dropped on excalidraw.com opens as the drawing. An image optimiser such as SVGO or a PNG crusher strips it, so the .excalidraw stays the source of truth.

The result's markdown shows the SVG in a README or doc; with animate, the animated one, and the still one to a reader who asks for reduced motion. Its paths are relative to the directory a relative out resolves against, usually the project root, or absolute when the file is outside it; rewrite them relative to the .md file they go into.`;

// With tool search on, a client loads only tool names and these instructions at session start, so this is what
// decides whether an agent reaches for sketch at all.
const INSTRUCTIONS = `excalix draws architecture, system and topology diagrams in Excalidraw's hand-drawn style. Use its sketch tool whenever someone asks for one, or for an Excalidraw diagram of a system: you give the nodes, edges and groups, and it picks every shape, colour and route. It writes .excalidraw, .svg and .png files and returns their paths and the image, which you should look at before reporting back. Past about twenty nodes, draw an overview and a detail diagram instead of one. The .svg and .png carry the editable scene, and the result has markdown to put the diagram in a README; set animate for an SVG that draws itself.`;

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

const animate = z
  .union(
    [
      z
        .literal("story")
        .describe("the title, then each edge in the order listed: its source, its target, then the arrow; nodes no edge reaches come last"),
      z.literal("layers").describe("the layout's layers along the flow, each followed by the arrows whose ends are both in"),
    ],
    { error: expectedOneOf(["story", "layers"]) },
  )
  .optional()
  .describe(
    "also write <out>.animated.svg, and <out>.dark.animated.svg for theme both: the svg building itself in a loop, in this order. <out>.svg stays as it is",
  );

const inputSchema = specSchemaWith({
  out: stringField
    .optional()
    .describe(
      "output basename without extension; writes <out>.excalidraw, <out>.svg and <out>.png. Relative paths resolve against the first root the client declares, usually the project directory, or else the server's working directory. Defaults to diagrams/<title slug>.",
    ),
  theme,
  animate,
});

const outputSchema = z.object({
  excalidraw: z.string().describe("the .excalidraw file, the one to open on excalidraw.com"),
  svg: z.string().describe("the .svg file"),
  png: z.string().describe("the .png file at full size; the image block in this result is a copy that fits 2000 pixels a side"),
  animatedSvg: z.string().optional().describe("the .animated.svg file, present when animate is set"),
  dark: z
    .object({ svg: z.string(), png: z.string(), animatedSvg: z.string().optional() })
    .optional()
    .describe("the .dark.svg and .dark.png files, and .dark.animated.svg when animate is set, present when theme is both"),
  pixels: z
    .object({ width: z.number(), height: z.number() })
    .describe("size of the png file; a very wide one usually means a long node label stretched the layout"),
  preview: z
    .object({ width: z.number(), height: z.number() })
    .describe("size of the image block, the png scaled down to fit 2000 pixels a side, or the png itself when it fits"),
  markdown: z
    .string()
    .describe(
      "markdown that shows the svg, with its paths relative to the directory a relative out resolves against; a <picture> that follows the reader's colour scheme when theme is both, and when animate is set, one of the animated svg that shows the still one to a reader who asks for reduced motion",
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
  let base: Promise<string> | undefined;

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

  // The first answer holds until the client says its roots changed, so one that declares roots and never answers
  // costs the wait once per connection rather than on every call.
  const baseReady = (): Promise<string> => (base ??= baseDirectory(server));
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    base = undefined;
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== TOOL.name) throw new McpError(ErrorCode.InvalidParams, `unknown tool "${params.name}"`);
    try {
      const { out, theme, animate, ...spec } = parseSpecWith(inputSchema, params.arguments);
      const target = out ?? defaultOut(spec.title);
      // Asked even for an absolute out, since the markdown path is written relative to the same directory.
      const directory = await baseReady();
      const basename = isAbsolute(target) ? target : resolve(directory, target);
      const { files, result } = await deps.writeSketch(spec, basename, await renderReady(), { theme, animate, preview: true });
      const shown = result.preview ?? { png: result.png, scale: PNG_SCALE };
      const pixels = pngSize(result.png);
      const preview = pngSize(shown.png);
      const notes = [sizeNote(pixels, { ...preview, scale: shown.scale })].filter((note) => note !== undefined);
      const markdown = markdownSnippet(altText(spec.title, spec.nodes), files, directory);
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
