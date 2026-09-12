import { createHash } from "node:crypto";

/** Stable key for the edge at a spec index, shared by layout, measurement and elements. */
export function edgeKey(index: number): string {
  return `edge:${index}`;
}

/** Deterministic ids and seeds, all derived from the parsed spec. */
export interface IdSource {
  id(key: string): string;
  seed(key: string): number;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 20;

/** sha256 hex of the canonical JSON (sorted keys, no whitespace) of a parsed spec. */
export function hashSpec(spec: unknown): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

/** Id and seed source keyed by `sha256(specHash + ":" + key)`. */
export function createIdSource(specHash: string): IdSource {
  const digest = (key: string) => createHash("sha256").update(`${specHash}:${key}`).digest();
  return {
    id: (key) => base62(digest(key)).slice(-ID_LENGTH),
    seed: (key) => digest(key).readUInt32BE(0) >>> 1,
  };
}

// Built by hand: JSON.stringify and Object.fromEntries both put integer-like keys first,
// which would break the sorted-key guarantee.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function base62(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(ID_LENGTH, "0");
}
