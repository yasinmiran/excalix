import { z } from "zod";
import type { Spec } from "./types.js";

/** Thrown by parseSpec with every problem found, not only the first. */
export class SpecError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "SpecError";
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Every problem reads "<path>: <what arrived>, <what is valid>". The halves live on the schema because
// issue.input, the only source for the first half, reaches an error function and is stripped afterwards.
function problem(expected: string) {
  return (issue: { input: unknown }) => `${arrived(issue.input)}, ${expected}`;
}

function arrived(input: unknown): string {
  if (input === undefined) return "missing";
  if (Array.isArray(input)) return input.length === 0 ? "got an empty array" : "got an array";
  if (input === null) return "got null";
  if (typeof input === "object") return "got an object";
  return `got ${JSON.stringify(input)}`;
}

function quote(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function oneOf(values: readonly string[]): string {
  return `expected one of ${quote(values)}`;
}

function strict<T extends z.ZodRawShape>(shape: T, description: string) {
  const allowed = oneOf(Object.keys(shape));
  return z
    .strictObject(shape, {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? `unknown ${issue.keys.length > 1 ? "keys" : "key"} ${quote(issue.keys)}, ${allowed}`
          : problem("expected an object")(issue),
    })
    .describe(description);
}

/** A string field, for the spec and for a caller's own keys, so both report a wrong type the same way. */
export const stringField = z.string({ error: problem("expected a string") });

function id(description: string) {
  return stringField.regex(ID_PATTERN, { error: problem('expected letters, digits, "_" and "-" only') }).describe(description);
}

function text(description: string) {
  return stringField.describe(description);
}

const kind = z
  .union(
    [
      z.literal("client").describe("people, browsers, mobile apps, anything that initiates requests"),
      z.literal("service").describe("an application component you run"),
      z.literal("datastore").describe("database or durable storage"),
      z.literal("queue").describe("message queue, topic, or stream"),
      z.literal("cache").describe("cache or in-memory store"),
      z.literal("external").describe("third-party system you don't run"),
    ],
    { error: problem(oneOf(["client", "service", "datastore", "queue", "cache", "external"])) },
  )
  .describe("what the node is; fixes its shape and colour");

const direction = z
  .union([z.literal("lr").describe("left to right"), z.literal("tb").describe("top to bottom")], {
    error: problem(oneOf(["lr", "tb"])),
  })
  .default("lr")
  .describe("which way the diagram flows");

const edgeStyle = z
  .union(
    [
      z.literal("sync").describe("request/response, solid arrow"),
      z.literal("async").describe("message or event, dashed arrow"),
    ],
    { error: problem(oneOf(["sync", "async"])) },
  )
  .default("sync")
  .describe("how the two ends talk");

const arrows = z
  .union(
    [
      z.literal("forward").describe("one arrowhead, at the target"),
      z.literal("both").describe("an arrowhead at each end, for a bidirectional link"),
      z.literal("none").describe("no arrowhead, a plain association"),
    ],
    { error: problem(oneOf(["forward", "both", "none"])) },
  )
  .default("forward")
  .describe("which ends of the arrow get an arrowhead");

const group = strict(
  {
    id: id("unique id, referenced by node.group and group.parent"),
    label: text("text drawn inside the top-left corner of the box"),
    parent: id("id of the group this one nests inside").optional(),
  },
  "a dashed boundary drawn around nodes, such as a VPC, cluster, or account",
);

const node = strict(
  {
    id: id("unique id, referenced by edge.from, edge.to and group membership"),
    label: text("text drawn inside the box; a \\n starts a new line"),
    kind,
    group: id("id of the group this node sits inside").optional(),
  },
  "one box in the diagram",
);

const edge = strict(
  {
    from: id("id of the node the arrow leaves"),
    to: id("id of the node the arrow points at"),
    label: text("text drawn on the arrow, a few words at most: the arrow reserves the width").optional(),
    style: edgeStyle,
    arrows,
  },
  "an arrow between two nodes; self edges and repeated pairs are allowed",
);

const SPEC_DESCRIPTION = "an architecture topology: what exists and what talks to what";

const shape = {
  title: text("heading drawn above the diagram").optional(),
  direction,
  groups: z
    .array(group, { error: problem("expected an array of groups") })
    .default([])
    .describe("boundaries, nestable through parent"),
  nodes: z
    .array(node, { error: problem("expected an array of nodes") })
    .min(1, { error: problem("expected at least one node") })
    .describe("every box in the diagram, in reading order"),
  edges: z
    .array(edge, { error: problem("expected an array of edges") })
    .default([])
    .describe("every arrow in the diagram"),
};

/** Zod schema of the spec as an agent writes it (before defaults). */
export const specSchema = strict(shape, SPEC_DESCRIPTION);

/** The spec schema plus keys of the caller's own, such as the MCP tool's `out`. */
export function specSchemaWith<T extends z.ZodRawShape>(extra: T) {
  return strict({ ...shape, ...extra }, SPEC_DESCRIPTION);
}

/** Validates raw JSON into a Spec with defaults applied. Throws SpecError. */
export function parseSpec(input: unknown): Spec {
  return parseSpecWith(specSchema, input);
}

/** The same for a schema from specSchemaWith, whose extra keys come back with the spec and share its problem list. */
export function parseSpecWith<T extends Spec>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    const problems = semanticProblems(parsed.data);
    if (problems.length > 0) throw new SpecError(problems);
    return parsed.data;
  }
  const prefixes = parsed.error.issues.flatMap((issue) => {
    const path = formatPath(issue.path);
    // An unknown key is a problem with that key alone. Any other rejection means the value never arrived,
    // so a problem about a field inside it would be the same mistake reported a second time.
    return issue.code === "unrecognized_keys" ? [`${path}:`] : [`${path}:`, `${path}.`];
  });
  const alreadyReported = (problem: string) => prefixes.some((prefix) => problem.startsWith(prefix));
  const semantic = semanticProblems(lenient(input)).filter((problem) => !alreadyReported(problem));
  throw new SpecError([...parsed.error.issues.map(formatIssue), ...semantic]);
}

// Enough of a malformed spec to run the reference checks, so an agent sees every problem in one round trip.
function lenient(input: unknown): Spec {
  const raw = isRecord(input) ? input : {};
  const string = (value: unknown) => (typeof value === "string" ? value : "");
  const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
  const records = (value: unknown) => (Array.isArray(value) ? value.map((entry) => (isRecord(entry) ? entry : {})) : []);
  return {
    title: optional(raw.title),
    direction: "lr",
    groups: records(raw.groups).map((g) => ({ id: string(g.id), label: string(g.label), parent: optional(g.parent) })),
    nodes: records(raw.nodes).map((n) => ({ id: string(n.id), label: string(n.label), kind: "service", group: optional(n.group) })),
    edges: records(raw.edges).map((e) => ({ from: string(e.from), to: string(e.to), label: optional(e.label), style: "sync", arrows: "forward" })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssue(issue: z.core.$ZodIssue): string {
  return `${formatPath(issue.path)}: ${issue.message}`;
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "spec";
  return path.reduce<string>((acc, key) => {
    if (typeof key === "number") return `${acc}[${key}]`;
    return acc === "" ? String(key) : `${acc}.${String(key)}`;
  }, "");
}

function semanticProblems(spec: Spec): string[] {
  const problems: string[] = [];
  const groupIndex = new Map<string, number>();
  const nodeIds = new Set<string>();

  spec.groups.forEach((group, index) => {
    if (groupIndex.has(group.id)) problems.push(`groups[${index}].id: duplicate id "${group.id}", ${UNIQUE}`);
    else groupIndex.set(group.id, index);
    problems.push(...blank(`groups[${index}].label`, group.label));
  });

  spec.nodes.forEach((node, index) => {
    if (groupIndex.has(node.id) || nodeIds.has(node.id)) problems.push(`nodes[${index}].id: duplicate id "${node.id}", ${UNIQUE}`);
    else nodeIds.add(node.id);
    problems.push(...blank(`nodes[${index}].label`, node.label));
  });

  if (spec.title !== undefined) problems.push(...blank("title", spec.title));

  spec.groups.forEach((group, index) => {
    if (group.parent === undefined) return;
    problems.push(...reference(`groups[${index}].parent`, group.parent, "group", groupIndex, nodeIds));
  });

  spec.nodes.forEach((node, index) => {
    if (node.group === undefined) return;
    problems.push(...reference(`nodes[${index}].group`, node.group, "group", groupIndex, nodeIds));
  });

  spec.edges.forEach((edge, index) => {
    problems.push(...reference(`edges[${index}].from`, edge.from, "node", groupIndex, nodeIds));
    problems.push(...reference(`edges[${index}].to`, edge.to, "node", groupIndex, nodeIds));
    if (edge.label !== undefined) problems.push(...blank(`edges[${index}].label`, edge.label));
  });

  problems.push(...cycles(spec, groupIndex));
  return problems;
}

const UNIQUE = "expected an id no other node or group uses";

function blank(path: string, value: string): string[] {
  return value.trim() === "" ? [`${path}: got ${JSON.stringify(value)}, expected text`] : [];
}

function reference(
  path: string,
  target: string,
  expected: "group" | "node",
  groupIndex: Map<string, number>,
  nodeIds: Set<string>,
): string[] {
  const isGroup = groupIndex.has(target);
  const isNode = nodeIds.has(target);
  if (expected === "group" ? isGroup : isNode) return [];
  if (isGroup || isNode) return [`${path}: "${target}" is a ${isGroup ? "group" : "node"}, expected a ${expected}`];
  const near = nearest(target, expected === "group" ? [...groupIndex.keys()] : [...nodeIds]);
  return [`${path}: unknown ${expected} "${target}"${near === undefined ? "" : `, did you mean "${near}"?`}`];
}

// A typo comes back with the id the caller probably meant. One edit for a short id, two for a longer one.
function nearest(target: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let shortest = target.length <= 4 ? 2 : 3;
  for (const candidate of candidates) {
    const distance = editDistance(target.toLowerCase(), candidate.toLowerCase());
    if (distance < shortest) {
      best = candidate;
      shortest = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function cycles(spec: Spec, groupIndex: Map<string, number>): string[] {
  const parentOf = new Map<string, string>();
  for (const group of spec.groups) {
    if (group.parent !== undefined && groupIndex.has(group.parent)) parentOf.set(group.id, group.parent);
  }

  const problems: string[] = [];
  const reported = new Set<string>();
  for (const group of spec.groups) {
    const walked: string[] = [];
    let current: string | undefined = group.id;
    while (current !== undefined) {
      const at = walked.indexOf(current);
      if (at >= 0) {
        const cycle = walked.slice(at);
        const key = [...cycle].sort().join(" ");
        if (!reported.has(key)) {
          reported.add(key);
          const chain = [...cycle, current].join(" -> ");
          problems.push(`groups[${groupIndex.get(current) ?? 0}].parent: "${cycle[1] ?? current}" closes the cycle ${chain}`);
        }
        break;
      }
      walked.push(current);
      current = parentOf.get(current);
    }
  }
  return problems;
}
