import { describe, expect, it } from "vitest";
import { createIdSource, hashSpec } from "./ids.js";

describe("hashSpec", () => {
  it("is sha256 hex of canonical JSON, independent of key order", () => {
    const a = hashSpec({ nodes: [{ id: "a", kind: "service", label: "A" }], title: "t", direction: "lr" });
    const b = hashSpec({ direction: "lr", title: "t", nodes: [{ label: "A", kind: "service", id: "a" }] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("ignores undefined values and keeps array order", () => {
    expect(hashSpec({ title: undefined, nodes: [] })).toBe(hashSpec({ nodes: [] }));
    expect(hashSpec({ nodes: [1, 2] })).not.toBe(hashSpec({ nodes: [2, 1] }));
  });

  it("sorts integer-like keys as strings", () => {
    expect(hashSpec({ "10": 1, "2": 2 })).toBe(hashSpec({ "2": 2, "10": 1 }));
  });
});

describe("createIdSource", () => {
  const source = createIdSource(hashSpec({ nodes: [] }));

  it("gives 20 char base62 ids", () => {
    expect(source.id("node:api")).toMatch(/^[0-9A-Za-z]{20}$/);
  });

  it("gives 31-bit positive seeds", () => {
    const seed = source.seed("node:api");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 31);
  });

  it("is deterministic per key and differs across keys and hashes", () => {
    expect(source.id("node:api")).toBe(createIdSource(hashSpec({ nodes: [] })).id("node:api"));
    expect(source.seed("node:api")).toBe(createIdSource(hashSpec({ nodes: [] })).seed("node:api"));
    expect(source.id("node:api")).not.toBe(source.id("node:api:label"));
    expect(source.id("node:api")).not.toBe(createIdSource(hashSpec({ nodes: [], title: "x" })).id("node:api"));
  });
});
