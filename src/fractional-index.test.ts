import { describe, expect, it } from "vitest";
import { fractionalIndex } from "./fractional-index.js";

const keys = Array.from({ length: 5000 }, (_, position) => fractionalIndex(position));

describe("fractionalIndex", () => {
  it("rolls the integer part over at each head letter", () => {
    expect([fractionalIndex(0), fractionalIndex(61), fractionalIndex(62)]).toEqual(["a0", "az", "b00"]);
    expect([fractionalIndex(3905), fractionalIndex(3906)]).toEqual(["bzz", "c000"]);
    expect([fractionalIndex(242233), fractionalIndex(242234)]).toEqual(["czzz", "d0000"]);
  });

  it("uses base62 digits and the length its head letter promises", () => {
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][0-9A-Za-z]+$/);
      expect(key).toHaveLength(key.charCodeAt(0) - "a".charCodeAt(0) + 2);
    }
  });

  it("ascends strictly under plain string comparison", () => {
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is deterministic", () => {
    expect(keys.map((_, position) => fractionalIndex(position))).toEqual(keys);
  });
});
