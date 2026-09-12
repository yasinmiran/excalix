#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { serveMcp } from "./mcp.js";
import { writeSketch } from "./pipeline.js";
import { createBrowserRenderer } from "./render/browser.js";
import { parseSpec, SpecError, specSchema } from "./spec.js";

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE = `excalix - architecture diagrams from a topology spec

usage:
  excalix render <spec.json> [-o <basename>]   write <basename>.excalidraw, .svg and .png
  excalix validate <spec.json>                 check the spec, print every problem
  excalix schema                               print the JSON Schema of the spec
  excalix mcp                                  serve the sketch tool over stdio
  excalix --help                               show this message

render defaults the basename to the spec path without its extension.`;

/** Runs one command and returns the process exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case "render":
        return await render(rest, io);
      case "validate":
        return await validate(rest, io);
      case "schema":
        io.stdout(JSON.stringify(z.toJSONSchema(specSchema, { io: "input" }), null, 2));
        return 0;
      case "mcp":
        await serveMcp();
        return 0;
      default:
        io.stderr(`unknown command: ${command}`);
        io.stderr(USAGE);
        return 1;
    }
  } catch (error) {
    report(error, io);
    return 1;
  }
}

async function render(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: "string", short: "o" } },
    allowPositionals: true,
  });
  const specPath = positionals[0];
  if (specPath === undefined) {
    io.stderr("render needs a spec file");
    return 1;
  }
  const spec = await readSpec(specPath);
  parseSpec(spec);
  const basename = resolve(values.out ?? withoutExtension(specPath));
  await mkdir(dirname(basename), { recursive: true });

  const renderer = await createBrowserRenderer();
  try {
    const { files } = await writeSketch(spec, basename, renderer);
    io.stdout(files.excalidraw);
    io.stdout(files.svg);
    io.stdout(files.png);
  } finally {
    await renderer.close();
  }
  return 0;
}

async function validate(argv: string[], io: Io): Promise<number> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true });
  const specPath = positionals[0];
  if (specPath === undefined) {
    io.stderr("validate needs a spec file");
    return 1;
  }
  parseSpec(await readSpec(specPath));
  return 0;
}

async function readSpec(specPath: string): Promise<unknown> {
  const path = resolve(specPath);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code ? `cannot read ${path} (${code})` : `cannot read ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

function withoutExtension(specPath: string): string {
  const ext = extname(specPath);
  return ext === "" ? specPath : specPath.slice(0, -ext.length);
}

function report(error: unknown, io: Io): void {
  if (error instanceof SpecError) {
    for (const problem of error.problems) io.stderr(problem);
    return;
  }
  io.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2), {
    stdout: (s) => void process.stdout.write(`${s}\n`),
    stderr: (s) => void process.stderr.write(`${s}\n`),
  });
  process.exit(code);
}
