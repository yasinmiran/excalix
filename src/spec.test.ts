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
});

describe("schema problems", () => {
  it("rejects unknown keys at the root and inside items", () => {
    expect(problems({ ...minimal, colour: "red" })).toContain('spec: Unrecognized key: "colour"');
    expect(problems({ nodes: [{ id: "a", label: "A", kind: "service", shape: "hex" }], edges: [] })).toContain(
      'nodes[0]: Unrecognized key: "shape"',
    );
    expect(problems({ ...minimal, edges: [{ from: "a", to: "a", colour: "red" }] })).toContain(
      'edges[0]: Unrecognized key: "colour"',
    );
  });

  it("names the allowed values of an enum", () => {
    expect(problems({ nodes: [{ id: "a", label: "A", kind: "db" }], edges: [] })).toContain(
      'nodes[0].kind: expected one of "client", "service", "datastore", "queue", "cache", "external"',
    );
    expect(problems({ ...minimal, direction: "up" })).toContain('direction: expected one of "lr", "tb"');
    expect(problems({ ...minimal, edges: [{ from: "a", to: "a", arrows: "back" }] })).toContain(
      'edges[0].arrows: expected one of "forward", "both", "none"',
    );
  });

  it("reports a missing kind as required", () => {
    expect(problems({ nodes: [{ id: "a", label: "A" }], edges: [] })).toContain("nodes[0].kind: required");
  });

  it("rejects ids outside the id pattern", () => {
    expect(problems({ nodes: [{ id: "a b", label: "A", kind: "service" }], edges: [] })).toContain(
      'nodes[0].id: letters, digits, "_" and "-" only',
    );
  });

  it("requires at least one node", () => {
    expect(problems({ nodes: [], edges: [] })).toEqual(["nodes: Too small: expected array to have >=1 items"]);
  });

  it("reports a non-object spec against the root path", () => {
    expect(problems("nope")).toEqual(["spec: Invalid input: expected object, received string"]);
  });
});

describe("semantic problems", () => {
  it("rejects ids duplicated across nodes and groups", () => {
    expect(
      problems({
        groups: [{ id: "aws", label: "AWS" }],
        nodes: [
          { id: "api", label: "API", kind: "service" },
          { id: "api", label: "API again", kind: "service" },
          { id: "aws", label: "Clash", kind: "cache" },
        ],
        edges: [],
      }),
    ).toEqual(['nodes[1].id: duplicate id "api"', 'nodes[2].id: duplicate id "aws"']);
    expect(
      problems(
        withGroups([
          { id: "aws", label: "AWS" },
          { id: "aws", label: "AWS twice" },
        ]),
      ),
    ).toEqual(['groups[1].id: duplicate id "aws"']);
  });

  it("rejects unknown references", () => {
    expect(problems({ ...minimal, nodes: [{ id: "a", label: "A", kind: "service", group: "k8s" }] })).toEqual([
      'nodes[0].group: unknown group "k8s"',
    ]);
    expect(problems(withGroups([{ id: "k8s", label: "EKS", parent: "aws" }]))).toEqual([
      'groups[0].parent: unknown group "aws"',
    ]);
    expect(
      problems({
        nodes: [{ id: "api", label: "API", kind: "service" }],
        edges: [
          { from: "api", to: "pgg" },
          { from: "web", to: "api" },
        ],
      }),
    ).toEqual(['edges[0].to: unknown node "pgg"', 'edges[1].from: unknown node "web"']);
  });

  it("rejects edges that reference a group", () => {
    expect(
      problems({
        groups: [{ id: "aws", label: "AWS" }],
        nodes: [{ id: "api", label: "API", kind: "service" }],
        edges: [{ from: "aws", to: "api" }],
      }),
    ).toEqual(['edges[0].from: "aws" is a group, not a node']);
  });

  it("rejects a group reference that names a node", () => {
    expect(
      problems({
        groups: [{ id: "aws", label: "AWS", parent: "api" }],
        nodes: [{ id: "api", label: "API", kind: "service", group: "api" }],
        edges: [],
      }),
    ).toEqual(['groups[0].parent: "api" is a node, not a group', 'nodes[0].group: "api" is a node, not a group']);
  });

  it("rejects group parent cycles", () => {
    expect(
      problems(
        withGroups([
          { id: "aws", label: "AWS", parent: "k8s" },
          { id: "k8s", label: "EKS", parent: "aws" },
        ]),
      ),
    ).toEqual(["groups[0].parent: cycle aws -> k8s -> aws"]);
    expect(problems(withGroups([{ id: "aws", label: "AWS", parent: "aws" }]))).toEqual([
      "groups[0].parent: cycle aws -> aws",
    ]);
  });

  it("reports a cycle once, whatever its length", () => {
    expect(
      problems(
        withGroups([
          { id: "one", label: "One", parent: "two" },
          { id: "two", label: "Two", parent: "three" },
          { id: "three", label: "Three", parent: "one" },
        ]),
      ),
    ).toEqual(["groups[0].parent: cycle one -> two -> three -> one"]);
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

  it("rejects labels that are empty after trimming", () => {
    expect(problems({ ...minimal, nodes: [{ id: "a", label: "  ", kind: "service" }] })).toEqual([
      'nodes[0].label: empty label for node "a"',
    ]);
    expect(problems(withGroups([{ id: "aws", label: "" }]))).toEqual(['groups[0].label: empty label for group "aws"']);
    expect(problems({ ...minimal, edges: [{ from: "a", to: "a", label: " " }] })).toEqual([
      "edges[0].label: empty label",
    ]);
    expect(problems({ ...minimal, title: "\t" })).toEqual(["title: empty title"]);
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
      'groups[1].label: empty label for group "k8s"',
      'nodes[1].id: duplicate id "api"',
      'nodes[1].label: empty label for node "api"',
      "title: empty title",
      'nodes[0].group: unknown group "gone"',
      'edges[0].to: unknown node "pgg"',
      "groups[0].parent: cycle aws -> k8s -> aws",
    ]);
  });

  it("reports every schema problem at once", () => {
    expect(problems({ nodes: [{ id: "a b", label: "A", kind: "db", extra: 1 }], edges: [], junk: 2 })).toEqual([
      'nodes[0].id: letters, digits, "_" and "-" only',
      'nodes[0].kind: expected one of "client", "service", "datastore", "queue", "cache", "external"',
      'nodes[0]: Unrecognized key: "extra"',
      'spec: Unrecognized key: "junk"',
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
