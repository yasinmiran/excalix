import type { TextMeasurer } from "../types.js";
import { FONT } from "../style.js";

/** Rough Excalifont metrics for tests that must not launch a browser. */
export const estimateMeasurer: TextMeasurer = {
  async measure(texts, fontSize) {
    return texts.map((text) => {
      const lines = text.split("\n");
      const widest = Math.max(...lines.map((line) => line.length));
      return { width: widest * fontSize * 0.6, height: lines.length * fontSize * FONT.lineHeight };
    });
  },
};
