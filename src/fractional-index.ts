import type { FractionalIndex } from "excalidraw-types/element/src/types";

// Excalidraw validates an order key with the rocicorp fractional-indexing rules: every character a
// base62 digit, an integer part whose length its head letter encodes ("a" is two characters, "b"
// three, up to "z" at twenty-seven, and "A".."Z" count back down for keys below "a0"), and an
// optional fractional part that may not end in "0". The digits ascend in ASCII order, so a valid
// key sorts under plain string comparison, and restore only rewrites a key that is missing,
// malformed, or out of order with its neighbours.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HEADS = "abcdefghijklmnopqrstuvwxyz";

/** The order key for the element at this position in the scene, ascending with the position. */
export function fractionalIndex(position: number): FractionalIndex {
  let remaining = position;
  for (const [head, letter] of [...HEADS].entries()) {
    const width = head + 1;
    const capacity = DIGITS.length ** width;
    if (remaining < capacity) return (letter + base62(remaining, width)) as FractionalIndex;
    remaining -= capacity;
  }
  // Past the "z" head the format needs a fractional part, which no scene of real elements reaches.
  throw new Error(`no order key for position ${position}`);
}

function base62(value: number, width: number): string {
  let rest = value;
  let digits = "";
  for (let i = 0; i < width; i++) {
    digits = DIGITS[rest % DIGITS.length] + digits;
    rest = Math.floor(rest / DIGITS.length);
  }
  return digits;
}
