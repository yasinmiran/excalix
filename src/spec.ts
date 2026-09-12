import { z } from "zod";
import type { Spec } from "./types.js";

/** Thrown by parseSpec with every problem found, not only the first. */
export class SpecError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "SpecError";
  }
}

/** Zod schema of the spec as an agent writes it (before defaults). */
export const specSchema: z.ZodType<unknown> = z.unknown();

/** Validates raw JSON into a Spec with defaults applied. Throws SpecError. */
export function parseSpec(_input: unknown): Spec {
  throw new Error("not implemented");
}
