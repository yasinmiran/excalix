import { estimateMeasurer } from "./render/estimate.js";
import { describeGeometry, type KnownDefects } from "./test-support.js";

// Layout defects the pipeline still has. Fixing one makes its it.fails pass, which fails the suite
// until the entry is deleted, so this table can never drift ahead of the code.
const KNOWN: KnownDefects = {};

describeGeometry("geometry of", () => estimateMeasurer, KNOWN);
