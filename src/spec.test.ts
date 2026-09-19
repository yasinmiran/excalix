import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseSpec, specSchema, SpecError } from "./spec.js";
import type { Spec } from "./types.js";

type Json = Record<string, any>;

const example = JSON.parse(
  readFileSync(new URL("../examples/order-pipeline.json", import.meta.url), "utf8"),
) as unknown;

function problems(input: unknown): string[] {
  try {
    parseSpec(input);
  } catch (error) {
    if (error instanceof SpecError) return error.problems;
    throw error;
  }
  throw new Error("expected parseSpec to throw");
}

const minimal = {
  nodes: [{ id: "a", label: "A", kind: "service" }],
  edges: [],
};

function withGroups(groups: unknown[]): unknown {
  return { ...minimal, groups };
}

function withNodes(nodes: unknown[]): unknown {
  return { ...minimal, nodes };
}

function withEdges(edges: unknown[]): unknown {
  return { ...minimal, edges };
}

describe("parseSpec", () => {
  it("accepts the example spec and applies defaults", () => {
    const spec = parseSpec(example);
    expect(spec.title).toBe("order pipeline");
    expect(spec.direction).toBe("lr");
    expect(spec.groups).toEqual([
      { id: "aws", label: "AWS eu-north-1" },
      { id: "k8s", label: "EKS", parent: "aws" },
    ]);
    expect(spec.nodes).toHaveLength(7);
    expect(spec.edges[0]).toEqual({ from: "web", to: "api", label: "POST /orders", style: "sync", arrows: "forward" });
    expect(spec.edges[3]).toEqual({ from: "api", to: "q", style: "async", arrows: "forward" });
    expect(spec.edges[2]).toEqual({ from: "api", to: "redis", style: "sync", arrows: "both" });
  });

  it("accepts the spec in the skill", () => {
    const skill = readFileSync(new URL("../skills/excalix/SKILL.md", import.meta.url), "utf8");
    const fenced = /```json\n([\s\S]*?)```/.exec(skill);
    expect(fenced, "SKILL.md has no json example").not.toBeNull();

    const spec = parseSpec(JSON.parse(fenced![1]!) as unknown);

    expect(spec.nodes.length).toBeGreaterThan(0);
  });

  it("defaults direction, groups, edge style and edge arrows", () => {
    const spec = parseSpec({ nodes: [{ id: "a", label: "A", kind: "client" }], edges: [{ from: "a", to: "a" }] });
    expect(spec).toEqual({
      direction: "lr",
      groups: [],
      nodes: [{ id: "a", label: "A", kind: "client" }],
      edges: [{ from: "a", to: "a", style: "sync", arrows: "forward" }],
    } satisfies Spec);
  });

  it("allows self edges and repeated edges", () => {
    const spec = parseSpec({
      nodes: [
        { id: "a", label: "A", kind: "service" },
        { id: "b", label: "B", kind: "queue" },
      ],
      edges: [
        { from: "a", to: "a" },
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    });
    expect(spec.edges).toHaveLength(3);
  });

  it("keeps every kind, direction, style and arrows value", () => {
    const kinds = ["client", "service", "datastore", "queue", "cache", "external"];
    const spec = parseSpec({
      direction: "tb",
      nodes: kinds.map((kind, index) => ({ id: `n${index}`, label: kind, kind })),
      edges: [{ from: "n0", to: "n1", style: "async", arrows: "none" }],
    });
    expect(spec.direction).toBe("tb");
    expect(spec.nodes.map((node) => node.kind)).toEqual(kinds);
    expect(spec.edges[0]).toMatchObject({ style: "async", arrows: "none" });
  });

  it("accepts a forest of groups", () => {
    const spec = parseSpec(
      withGroups([
        { id: "aws", label: "AWS" },
        { id: "k8s", label: "EKS", parent: "aws" },
        { id: "gcp", label: "GCP" },
      ]),
    );
    expect(spec.groups).toHaveLength(3);
  });
});

const KINDS = '"client", "service", "datastore", "queue", "cache", "external"';

// One row per way a spec can be wrong, with the text an agent gets back. Every line names the path,
// shows what arrived, and says what would be valid.
const failures: [name: string, input: unknown, problems: string[]][] = [
  ["the spec is not an object", "nope", ['spec: got "nope", expected an object']],
  ["the spec is null", null, ["spec: got null, expected an object"]],
  [
    "an unknown key at the root",
    { ...minimal, colour: "red" },
    ['spec: unknown key "colour", expected one of "title", "direction", "groups", "nodes", "edges"'],
  ],
  [
    "two unknown keys in one object",
    { ...minimal, colour: "red", font: "Comic Sans" },
    ['spec: unknown keys "colour", "font", expected one of "title", "direction", "groups", "nodes", "edges"'],
  ],
  [
    "an unknown key in a node",
    withNodes([{ id: "a", label: "A", kind: "service", shape: "hex" }]),
    ['nodes[0]: unknown key "shape", expected one of "id", "label", "kind", "group"'],
  ],
  [
    "an unknown key in an edge",
    withEdges([{ from: "a", to: "a", colour: "red" }]),
    ['edges[0]: unknown key "colour", expected one of "from", "to", "label", "style", "arrows"'],
  ],
  [
    "an unknown key in a group",
    withGroups([{ id: "aws", label: "AWS", fill: "blue" }]),
    ['groups[0]: unknown key "fill", expected one of "id", "label", "parent"'],
  ],
  [
    "an unknown key in a node next to a group that does not exist",
    {
      groups: [{ id: "aws", label: "AWS" }],
      nodes: [{ id: "a", label: "A", kind: "service", group: "awz", shape: "hex" }],
    },
    [
      'nodes[0]: unknown key "shape", expected one of "id", "label", "kind", "group"',
      'nodes[0].group: unknown group "awz", did you mean "aws"?',
    ],
  ],
  [
    "an unknown key in a node next to a blank label",
    withNodes([{ id: "a", label: " ", kind: "service", shape: "hex" }]),
    [
      'nodes[0]: unknown key "shape", expected one of "id", "label", "kind", "group"',
      'nodes[0].label: got " ", expected text',
    ],
  ],
  [
    "an unknown key in an edge that also points nowhere",
    withEdges([{ from: "a", to: "pg", colour: "red" }]),
    [
      'edges[0]: unknown key "colour", expected one of "from", "to", "label", "style", "arrows"',
      'edges[0].to: unknown node "pg"',
    ],
  ],
  ["no nodes key at all", {}, ["nodes: missing, expected an array of nodes"]],
  ["an empty node list", { nodes: [] }, ["nodes: got an empty array, expected at least one node"]],
  ["nodes that are not a list", { nodes: 5 }, ["nodes: got 5, expected an array of nodes"]],
  ["a node that is not an object", { nodes: ["a"] }, ['nodes[0]: got "a", expected an object']],
  [
    "several nodes that are not objects, without inventing their fields",
    { nodes: ["a", 5] },
    ['nodes[0]: got "a", expected an object', "nodes[1]: got 5, expected an object"],
  ],
  [
    "a node without a kind",
    withNodes([{ id: "a", label: "A" }]),
    [`nodes[0].kind: missing, expected one of ${KINDS}`],
  ],
  [
    "a kind that does not exist",
    withNodes([{ id: "a", label: "A", kind: "db" }]),
    [`nodes[0].kind: got "db", expected one of ${KINDS}`],
  ],
  [
    "a direction that does not exist",
    { ...minimal, direction: "up" },
    ['direction: got "up", expected one of "lr", "tb"'],
  ],
  [
    "an edge style that does not exist",
    withEdges([{ from: "a", to: "a", style: "rpc" }]),
    ['edges[0].style: got "rpc", expected one of "sync", "async"'],
  ],
  [
    "an arrows value that does not exist",
    withEdges([{ from: "a", to: "a", arrows: "back" }]),
    ['edges[0].arrows: got "back", expected one of "forward", "both", "none"'],
  ],
  [
    "a label that is not a string",
    withNodes([{ id: "a", label: 5, kind: "service" }]),
    ["nodes[0].label: got 5, expected a string"],
  ],
  [
    "a node without a label",
    withNodes([{ id: "a", kind: "service" }]),
    ["nodes[0].label: missing, expected a string"],
  ],
  [
    "an id outside the id pattern",
    withNodes([{ id: "a b", label: "A", kind: "service" }]),
    ['nodes[0].id: got "a b", expected letters, digits, "_" and "-" only'],
  ],
  [
    "a node label that is only spaces",
    withNodes([{ id: "a", label: "  ", kind: "service" }]),
    ['nodes[0].label: got "  ", expected text'],
  ],
  ["an empty group label", withGroups([{ id: "aws", label: "" }]), ['groups[0].label: got "", expected text']],
  [
    "an edge label that is only a space",
    withEdges([{ from: "a", to: "a", label: " " }]),
    ['edges[0].label: got " ", expected text'],
  ],
  ["a title that is only a tab", { ...minimal, title: "\t" }, ['title: got "\\t", expected text']],
  [
    "an id used by two nodes",
    withNodes([
      { id: "api", label: "API", kind: "service" },
      { id: "api", label: "API again", kind: "service" },
    ]),
    ['nodes[1].id: duplicate id "api", expected an id no other node or group uses'],
  ],
  [
    "an id shared by a node and a group",
    {
      groups: [{ id: "aws", label: "AWS" }],
      nodes: [{ id: "aws", label: "Clash", kind: "cache" }],
    },
    ['nodes[0].id: duplicate id "aws", expected an id no other node or group uses'],
  ],
  [
    "an id used by two groups",
    withGroups([
      { id: "aws", label: "AWS" },
      { id: "aws", label: "AWS twice" },
    ]),
    ['groups[1].id: duplicate id "aws", expected an id no other node or group uses'],
  ],
  [
    "an edge to a node id with a typo",
    {
      nodes: [
        { id: "api", label: "API", kind: "service" },
        { id: "web", label: "Web", kind: "client" },
      ],
      edges: [{ from: "web", to: "apy" }],
    },
    ['edges[0].to: unknown node "apy", did you mean "api"?'],
  ],
  [
    "an edge to a node id in the wrong case",
    { nodes: [{ id: "api", label: "API", kind: "service" }], edges: [{ from: "api", to: "API" }] },
    ['edges[0].to: unknown node "API", did you mean "api"?'],
  ],
  [
    "an edge to a node id nothing resembles",
    { nodes: [{ id: "api", label: "API", kind: "service" }], edges: [{ from: "api", to: "postgres" }] },
    ['edges[0].to: unknown node "postgres"'],
  ],
  [
    "an edge to an id two nodes are equally near",
    {
      nodes: [
        { id: "api", label: "API", kind: "service" },
        { id: "apx", label: "APX", kind: "service" },
      ],
      edges: [{ from: "api", to: "ap" }],
    },
    ['edges[0].to: unknown node "ap", did you mean "api"?'],
  ],
  [
    "a node in a group that does not exist",
    {
      groups: [{ id: "aws", label: "AWS" }],
      nodes: [{ id: "api", label: "API", kind: "service", group: "awz" }],
    },
    ['nodes[0].group: unknown group "awz", did you mean "aws"?'],
  ],
  [
    "a group inside a group that does not exist",
    withGroups([{ id: "k8s", label: "EKS", parent: "aws" }]),
    ['groups[0].parent: unknown group "aws"'],
  ],
  [
    "an edge that starts at a group",
    {
      groups: [{ id: "aws", label: "AWS" }],
      nodes: [{ id: "api", label: "API", kind: "service" }],
      edges: [{ from: "aws", to: "api" }],
    },
    ['edges[0].from: "aws" is a group, expected a node'],
  ],
  [
    "a group reference that names a node",
    {
      groups: [{ id: "aws", label: "AWS", parent: "api" }],
      nodes: [{ id: "api", label: "API", kind: "service", group: "api" }],
    },
    [
      'groups[0].parent: "api" is a node, expected a group',
      'nodes[0].group: "api" is a node, expected a group',
    ],
  ],
  [
    "two groups that nest inside each other",
    withGroups([
      { id: "aws", label: "AWS", parent: "k8s" },
      { id: "k8s", label: "EKS", parent: "aws" },
    ]),
    ['groups[0].parent: "k8s" closes the cycle aws -> k8s -> aws'],
  ],
  [
    "a group that is its own parent",
    withGroups([{ id: "aws", label: "AWS", parent: "aws" }]),
    ['groups[0].parent: "aws" closes the cycle aws -> aws'],
  ],
  [
    "a longer cycle, reported once",
    withGroups([
      { id: "one", label: "One", parent: "two" },
      { id: "two", label: "Two", parent: "three" },
      { id: "three", label: "Three", parent: "one" },
    ]),
    ['groups[0].parent: "two" closes the cycle one -> two -> three -> one'],
  ],
];

describe("problems", () => {
  it.each(failures)("reports %s", (_name, input, expected) => {
    expect(problems(input)).toEqual(expected);
  });

  it("reports every problem at once", () => {
    const found = problems({
      title: " ",
      groups: [
        { id: "aws", label: "AWS", parent: "k8s" },
        { id: "k8s", label: " ", parent: "aws" },
      ],
      nodes: [
        { id: "api", label: "API", kind: "service", group: "gone" },
        { id: "api", label: "", kind: "cache" },
      ],
      edges: [{ from: "api", to: "pgg" }],
    });
    expect(found).toEqual([
      'groups[1].label: got " ", expected text',
      'nodes[1].id: duplicate id "api", expected an id no other node or group uses',
      'nodes[1].label: got "", expected text',
      'title: got " ", expected text',
      'nodes[0].group: unknown group "gone"',
      'edges[0].to: unknown node "pgg"',
      'groups[0].parent: "k8s" closes the cycle aws -> k8s -> aws',
    ]);
  });

  // A path the schema already rejected is not repeated by the reference checks, so edges[0].from comes back once.
  it("reports schema and reference problems in the same round trip", () => {
    expect(
      problems({
        nodes: [{ id: "a b", label: "A", kind: "db", extra: 1 }],
        edges: [{ from: "a b", to: "pgg" }],
        junk: 2,
      }),
    ).toEqual([
      'nodes[0].id: got "a b", expected letters, digits, "_" and "-" only',
      `nodes[0].kind: got "db", expected one of ${KINDS}`,
      'nodes[0]: unknown key "extra", expected one of "id", "label", "kind", "group"',
      'edges[0].from: got "a b", expected letters, digits, "_" and "-" only',
      'spec: unknown key "junk", expected one of "title", "direction", "groups", "nodes", "edges"',
      'edges[0].to: unknown node "pgg"',
    ]);
  });

  it("carries the problems on the error message", () => {
    const error = new SpecError(["one", "two"]);
    expect(error.message).toBe("one\ntwo");
    expect(error.name).toBe("SpecError");
  });
});

describe("JSON Schema", () => {
  const schema = z.toJSONSchema(specSchema) as Json;
  const props = schema.properties as Json;
  const nodeProps = props.nodes.items.properties as Json;

  it("forbids unknown keys at every level", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(props.nodes.items.additionalProperties).toBe(false);
    expect(props.groups.items.additionalProperties).toBe(false);
    expect(props.edges.items.additionalProperties).toBe(false);
  });

  it("describes every field", () => {
    expect(schema.description).toBe("an architecture topology: what exists and what talks to what");
    for (const key of ["title", "direction", "groups", "nodes", "edges"]) {
      expect(props[key].description, key).toBeTruthy();
    }
    for (const key of ["id", "label", "kind", "group"]) {
      expect(nodeProps[key].description, key).toBeTruthy();
    }
    for (const key of ["from", "to", "label", "style", "arrows"]) {
      expect((props.edges.items.properties as Json)[key].description, key).toBeTruthy();
    }
    for (const key of ["id", "label", "parent"]) {
      expect((props.groups.items.properties as Json)[key].description, key).toBeTruthy();
    }
  });

  it("describes every enum value", () => {
    expect(nodeProps.kind.anyOf).toEqual([
      { type: "string", const: "client", description: "people, browsers, mobile apps, anything that initiates requests" },
      { type: "string", const: "service", description: "an application component you run" },
      { type: "string", const: "datastore", description: "database or durable storage" },
      { type: "string", const: "queue", description: "message queue, topic, or stream" },
      { type: "string", const: "cache", description: "cache or in-memory store" },
      { type: "string", const: "external", description: "third-party system you don't run" },
    ]);
    expect((props.edges.items.properties as Json).style.anyOf).toEqual([
      { type: "string", const: "sync", description: "request/response, solid arrow" },
      { type: "string", const: "async", description: "message or event, dashed arrow" },
    ]);
    expect(((props.edges.items.properties as Json).arrows.anyOf as Json[]).map((value) => value.const)).toEqual([
      "forward",
      "both",
      "none",
    ]);
    expect((props.direction.anyOf as Json[]).map((value) => value.const)).toEqual(["lr", "tb"]);
  });

  it("carries the id pattern and the one node minimum", () => {
    expect(nodeProps.id.pattern).toBe("^[A-Za-z0-9_-]+$");
    expect(props.nodes.minItems).toBe(1);
  });

  it("makes defaulted fields optional only under io input", () => {
    expect(schema.required).toEqual(["direction", "groups", "nodes", "edges"]);
    const input = z.toJSONSchema(specSchema, { io: "input" }) as Json;
    expect(input.required).toEqual(["nodes"]);
    expect(input.properties.edges.items.required).toEqual(["from", "to"]);
    expect(input.properties.direction.default).toBe("lr");
  });
});
