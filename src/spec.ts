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

function id(description: string) {
  return z.string().regex(ID_PATTERN, 'letters, digits, "_" and "-" only').describe(description);
}

function choice(values: readonly string[]) {
  const list = values.map((value) => `"${value}"`).join(", ");
  return (issue: { input: unknown }) => (issue.input === undefined ? "required" : `expected one of ${list}`);
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
    { error: choice(["client", "service", "datastore", "queue", "cache", "external"]) },
  )
  .describe("what the node is; fixes its shape and colour");

const direction = z
  .union(
    [z.literal("lr").describe("left to right"), z.literal("tb").describe("top to bottom")],
    { error: choice(["lr", "tb"]) },
  )
  .default("lr")
  .describe("which way the diagram flows");

const edgeStyle = z
  .union(
    [
      z.literal("sync").describe("request/response, solid arrow"),
      z.literal("async").describe("message or event, dashed arrow"),
    ],
    { error: choice(["sync", "async"]) },
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
    { error: choice(["forward", "both", "none"]) },
  )
  .default("forward")
  .describe("which ends of the arrow get an arrowhead");

const group = z
  .strictObject({
    id: id("unique id, referenced by node.group and group.parent"),
    label: z.string().describe("text drawn inside the top-left corner of the box"),
    parent: id("id of the group this one nests inside").optional(),
  })
  .describe("a dashed boundary drawn around nodes, such as a VPC, cluster, or account");

const node = z
  .strictObject({
    id: id("unique id, referenced by edge.from, edge.to and group membership"),
    label: z.string().describe("text drawn inside the box; a \\n starts a new line"),
    kind,
    group: id("id of the group this node sits inside").optional(),
  })
  .describe("one box in the diagram");

const edge = z
  .strictObject({
    from: id("id of the node the arrow leaves"),
    to: id("id of the node the arrow points at"),
    label: z.string().describe("text drawn on the arrow, such as the call it carries").optional(),
    style: edgeStyle,
    arrows,
  })
  .describe("an arrow between two nodes; self edges and repeated pairs are allowed");

/** Zod schema of the spec as an agent writes it (before defaults). */
export const specSchema = z
  .strictObject({
    title: z.string().describe("heading drawn above the diagram").optional(),
    direction,
    groups: z.array(group).default([]).describe("boundaries, nestable through parent"),
    nodes: z.array(node).min(1).describe("every box in the diagram"),
    edges: z.array(edge).default([]).describe("every arrow in the diagram"),
  })
  .describe("an architecture topology: what exists and what talks to what");

/** Validates raw JSON into a Spec with defaults applied. Throws SpecError. */
export function parseSpec(input: unknown): Spec {
  const parsed = specSchema.safeParse(input);
  if (parsed.success) {
    const problems = semanticProblems(parsed.data);
    if (problems.length > 0) throw new SpecError(problems);
    return parsed.data;
  }
  const issuePaths = parsed.error.issues.map((issue) => formatPath(issue.path));
  const alreadyReported = (problem: string) => issuePaths.some((path) => problem.startsWith(`${path}:`) || problem.startsWith(`${path}.`));
  const semantic = semanticProblems(lenient(input)).filter((problem) => !alreadyReported(problem));
  throw new SpecError([...parsed.error.issues.map(formatIssue), ...semantic]);
}

// Enough of a malformed spec to run the reference checks, so an agent sees every problem in one round trip.
function lenient(input: unknown): Spec {
  const raw = isRecord(input) ? input : {};
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
  const records = (value: unknown) => (Array.isArray(value) ? value.map((entry) => (isRecord(entry) ? entry : {})) : []);
  return {
    title: optional(raw.title),
    direction: "lr",
    groups: records(raw.groups).map((g) => ({ id: text(g.id), label: text(g.label), parent: optional(g.parent) })),
    nodes: records(raw.nodes).map((n) => ({ id: text(n.id), label: text(n.label), kind: "service", group: optional(n.group) })),
    edges: records(raw.edges).map((e) => ({ from: text(e.from), to: text(e.to), label: optional(e.label), style: "sync", arrows: "forward" })),
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
    if (groupIndex.has(group.id)) problems.push(`groups[${index}].id: duplicate id "${group.id}"`);
    else groupIndex.set(group.id, index);
    if (group.label.trim() === "") problems.push(`groups[${index}].label: empty label for group "${group.id}"`);
  });

  spec.nodes.forEach((node, index) => {
    if (groupIndex.has(node.id) || nodeIds.has(node.id)) problems.push(`nodes[${index}].id: duplicate id "${node.id}"`);
    else nodeIds.add(node.id);
    if (node.label.trim() === "") problems.push(`nodes[${index}].label: empty label for node "${node.id}"`);
  });

  if (spec.title !== undefined && spec.title.trim() === "") problems.push("title: empty title");

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
    if (edge.label !== undefined && edge.label.trim() === "") problems.push(`edges[${index}].label: empty label`);
  });

  problems.push(...cycles(spec, groupIndex));
  return problems;
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
  if (isGroup || isNode) return [`${path}: "${target}" is a ${isGroup ? "group" : "node"}, not a ${expected}`];
  return [`${path}: unknown ${expected} "${target}"`];
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
          problems.push(`groups[${groupIndex.get(current) ?? 0}].parent: cycle ${[...cycle, current].join(" -> ")}`);
        }
        break;
      }
      walked.push(current);
      current = parentOf.get(current);
    }
  }
  return problems;
}
