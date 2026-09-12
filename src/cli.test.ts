import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, type Io } from "./cli.js";

const mocks = vi.hoisted(() => ({
  writeSketch: vi.fn(),
  createBrowserRenderer: vi.fn(),
  serveMcp: vi.fn(),
  parseSpec: vi.fn(),
  close: vi.fn(),
}));

vi.mock("./pipeline.js", () => ({ writeSketch: mocks.writeSketch }));
vi.mock("./render/browser.js", () => ({ createBrowserRenderer: mocks.createBrowserRenderer }));
vi.mock("./mcp.js", () => ({ serveMcp: mocks.serveMcp }));
vi.mock("./spec.js", async () => {
  const { z } = await import("zod");
  class SpecError extends Error {
    constructor(readonly problems: string[]) {
      super(problems.join("\n"));
      this.name = "SpecError";
    }
  }
  return {
    SpecError,
    parseSpec: mocks.parseSpec,
    specSchema: z.object({ title: z.string().optional() }),
  };
});

function collect(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, out, err };
}

const renderer = { measurer: {}, svg: vi.fn(), png: vi.fn(), close: mocks.close };
const specJson = { nodes: [{ id: "a", label: "A", kind: "service" }] };

let dir: string;
let specPath: string;

beforeEach(async () => {
  vi.resetAllMocks();
  dir = await realpath(await mkdtemp(join(tmpdir(), "excalix-cli-")));
  specPath = join(dir, "topology.json");
  await writeFile(specPath, JSON.stringify(specJson), "utf8");
  mocks.createBrowserRenderer.mockResolvedValue(renderer);
  mocks.writeSketch.mockImplementation(async (_spec: unknown, basename: string) => ({
    excalidraw: `${basename}.excalidraw`,
    svg: `${basename}.svg`,
    png: `${basename}.png`,
  }));
});

describe("render", () => {
  it("sketches into the spec basename and prints the three paths", async () => {
    const { io, out, err } = collect();
    const code = await main(["render", specPath], io);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(mocks.writeSketch).toHaveBeenCalledWith(specJson, join(dir, "topology"), renderer);
    expect(out).toEqual([
      join(dir, "topology.excalidraw"),
      join(dir, "topology.svg"),
      join(dir, "topology.png"),
    ]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("resolves -o against cwd and creates its parent directories", async () => {
    const { io } = collect();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(["render", "topology.json", "-o", "out/nested/diagram"], io)).toBe(0);
    } finally {
      process.chdir(cwd);
    }

    expect(mocks.writeSketch).toHaveBeenCalledWith(specJson, join(dir, "out/nested/diagram"), renderer);
    expect((await stat(join(dir, "out/nested"))).isDirectory()).toBe(true);
  });

  it("closes the renderer when writeSketch throws", async () => {
    mocks.writeSketch.mockRejectedValue(new Error("boom"));
    const { io, err } = collect();

    expect(await main(["render", specPath], io)).toBe(1);
    expect(err).toEqual(["error: boom"]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("reports spec problems and closes the renderer", async () => {
    const { SpecError } = await import("./spec.js");
    mocks.writeSketch.mockRejectedValue(new SpecError(["nodes: at least one node", "edges[0].to: unknown id"]));
    const { io, err } = collect();

    expect(await main(["render", specPath], io)).toBe(1);
    expect(err).toEqual(["nodes: at least one node", "edges[0].to: unknown id"]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("reports a missing spec file by path", async () => {
    const missing = join(dir, "nope.json");
    const { io, err } = collect();

    expect(await main(["render", missing], io)).toBe(1);
    expect(err[0]).toContain(missing);
    expect(mocks.createBrowserRenderer).not.toHaveBeenCalled();
  });

  it("reports invalid JSON by path", async () => {
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ nodes: ", "utf8");
    const { io, err } = collect();

    expect(await main(["render", broken], io)).toBe(1);
    expect(err[0]).toContain("invalid JSON");
    expect(err[0]).toContain(broken);
  });

  it("needs a spec file", async () => {
    const { io, err } = collect();
    expect(await main(["render"], io)).toBe(1);
    expect(err).toEqual(["render needs a spec file"]);
  });
});

describe("validate", () => {
  it("is silent when the spec parses", async () => {
    const { io, out, err } = collect();

    expect(await main(["validate", specPath], io)).toBe(0);
    expect(mocks.parseSpec).toHaveBeenCalledWith(specJson);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it("prints every problem on its own line", async () => {
    const { SpecError } = await import("./spec.js");
    mocks.parseSpec.mockImplementation(() => {
      throw new SpecError(["nodes[0].id: invalid", "groups[1].parent: unknown id"]);
    });
    const { io, out, err } = collect();

    expect(await main(["validate", specPath], io)).toBe(1);
    expect(err).toEqual(["nodes[0].id: invalid", "groups[1].parent: unknown id"]);
    expect(out).toEqual([]);
  });
});

describe("schema", () => {
  it("prints the JSON Schema of the spec", async () => {
    const { io, out } = collect();

    expect(await main(["schema"], io)).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ type: "object" });
  });
});

describe("mcp", () => {
  it("serves until the transport closes", async () => {
    mocks.serveMcp.mockResolvedValue(undefined);
    const { io } = collect();

    expect(await main(["mcp"], io)).toBe(0);
    expect(mocks.serveMcp).toHaveBeenCalledOnce();
  });
});

describe("usage", () => {
  it("goes to stdout with no arguments and with --help", async () => {
    for (const argv of [[], ["--help"]]) {
      const { io, out, err } = collect();
      expect(await main(argv, io)).toBe(0);
      expect(out[0]).toContain("excalix render");
      expect(err).toEqual([]);
    }
  });

  it("goes to stderr for an unknown command", async () => {
    const { io, out, err } = collect();

    expect(await main(["sketch"], io)).toBe(1);
    expect(err[0]).toBe("unknown command: sketch");
    expect(err[1]).toContain("excalix render");
    expect(out).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
