import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSpec } from "../test-support.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Block {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

// The in-memory tests fake the renderer and the transport. This one is the tool as a client meets it:
// a child process on stdio, real Chromium, real files.
describe("[browser] sketch over stdio", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let out: string;
  let stderr = "";

  beforeAll(async () => {
    out = join(await mkdtemp(join(tmpdir(), "excalix-stdio-")), "order-pipeline");
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(root, "src/cli.ts"), "mcp"],
      cwd: root,
      // The transport hands a child a minimal environment by default, which drops PLAYWRIGHT_BROWSERS_PATH
      // wherever the browsers are not under the home directory.
      env: process.env as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("offers one tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["sketch"]);
  });

  it("draws a spec, writes the three files and returns the picture", async () => {
    const result = await client.callTool({ name: "sketch", arguments: { ...(readSpec("examples/order-pipeline.json") as object), out } });

    const [text, image] = result.content as Block[];
    expect(result.isError, text?.text).toBeFalsy();
    expect(text?.text).toBe(`${out}.excalidraw\n${out}.svg\n${out}.png`);
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect([...Buffer.from(image!.data!, "base64").subarray(0, 8)]).toEqual(PNG_SIGNATURE);

    const onDisk = await readFile(`${out}.png`);
    expect(onDisk.equals(Buffer.from(image!.data!, "base64"))).toBe(true);
    expect((await stat(`${out}.svg`)).size).toBeGreaterThan(0);
    expect(await readFile(`${out}.excalidraw`, "utf8")).toBe(await readFile(join(root, "examples/order-pipeline.excalidraw"), "utf8"));
    expect(result.structuredContent).toMatchObject({ png: `${out}.png`, pixels: { width: expect.any(Number), height: expect.any(Number) } });
  });

  it("answers a bad spec with every problem and keeps serving", async () => {
    const bad = await client.callTool({
      name: "sketch",
      arguments: { nodes: [{ id: "api", label: "API", kind: "gateway" }], edges: [{ from: "api", to: "apy" }], out },
    });

    expect(bad.isError).toBe(true);
    expect((bad.content as Block[])[0]?.text).toBe(
      'nodes[0].kind: got "gateway", expected one of "client", "service", "datastore", "queue", "cache", "external"\n' +
        'edges[0].to: unknown node "apy", did you mean "api"?',
    );
    expect((await client.listTools()).tools).toHaveLength(1);
  });

  it("exits without a word on stderr when the client goes away", async () => {
    const exited = new Promise<void>((done) => (transport.onclose = () => done()));
    await client.close();
    await exited;
    expect(stderr).toBe("");
  });
});
