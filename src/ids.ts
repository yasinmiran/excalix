/** Deterministic ids and seeds, all derived from the parsed spec. */
export interface IdSource {
  id(key: string): string;
  seed(key: string): number;
}

export function createIdSource(_specHash: string): IdSource {
  throw new Error("not implemented");
}

export function hashSpec(_spec: unknown): string {
  throw new Error("not implemented");
}
