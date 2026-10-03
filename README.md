# excalix

[![ci](https://github.com/yasinmiran/excalix/actions/workflows/ci.yml/badge.svg)](https://github.com/yasinmiran/excalix/actions/workflows/ci.yml)

Architecture diagrams from a topology spec, in Excalidraw's hand-drawn style. You write what exists and what talks to what; excalix does the layout, the shapes and colours, the text measurement and the arrow bindings, and the same spec always produces the same bytes.

![order pipeline](https://raw.githubusercontent.com/yasinmiran/excalix/main/examples/order-pipeline.png)

```json
{
  "title": "order pipeline",
  "direction": "lr",
  "groups": [
    { "id": "aws", "label": "AWS eu-north-1" },
    { "id": "k8s", "label": "EKS", "parent": "aws" }
  ],
  "nodes": [
    { "id": "web", "label": "Web app", "kind": "client" },
    { "id": "api", "label": "Order API", "kind": "service", "group": "k8s" },
    { "id": "worker", "label": "Fulfilment", "kind": "service", "group": "k8s" },
    { "id": "q", "label": "orders.created", "kind": "queue", "group": "aws" },
    { "id": "pg", "label": "Postgres", "kind": "datastore", "group": "aws" },
    { "id": "redis", "label": "Redis", "kind": "cache", "group": "aws" },
    { "id": "stripe", "label": "Stripe", "kind": "external" }
  ],
  "edges": [
    { "from": "web", "to": "api", "label": "POST /orders" },
    { "from": "api", "to": "pg" },
    { "from": "api", "to": "redis", "arrows": "both" },
    { "from": "api", "to": "q", "style": "async" },
    { "from": "q", "to": "worker", "style": "async" },
    { "from": "worker", "to": "stripe", "label": "charge" }
  ]
}
```

Out come an `.excalidraw`, an SVG and a PNG. The `.excalidraw` opens on excalidraw.com with every label and arrow binding intact, so you can keep editing by hand.

## Install

Node 22 or newer. Export and text measurement run in headless Chromium, which is a separate download:

```
npx -y playwright@1.63.0 install chromium
```

## Use

```
npx -y excalix render spec.json -o out/spec    writes out/spec.excalidraw, .svg and .png
npx -y excalix validate spec.json              every problem at once, or ok: 7 nodes, 6 edges, 2 groups
npx -y excalix schema                          JSON Schema of the spec
```

With an agent, register the MCP server once. Its `sketch` tool takes the spec, writes the three files and returns the PNG in the same turn:

```
claude mcp add excalix --scope user -- npx -y excalix mcp
```

The skill tells the agent when to reach for it and how to write a spec that lays out well:

```
mkdir -p ~/.claude/skills/excalix
curl -fsSL https://raw.githubusercontent.com/yasinmiran/excalix/main/skills/excalix/SKILL.md -o ~/.claude/skills/excalix/SKILL.md
```

## The spec

`nodes`, `edges`, an optional `title`, `direction` (`lr` or `tb`) and `groups`, which nest through `parent`. A node sits in at most one group.

| kind | draws as |
|---|---|
| `client` | whoever initiates requests: people, browsers, mobile apps |
| `service` | anything you run or configure yourself, an app or a load balancer alike |
| `datastore` | database or durable storage |
| `queue` | queue, topic or stream |
| `cache` | cache or in-memory store |
| `external` | a system another company operates and you only call |

`edge.style` is `sync` (solid, default) or `async` (dashed). `edge.arrows` is `forward` (default), `both` or `none`. A `\n` in any label starts a new line.

List nodes in reading order, keep edge labels to a few words, and split anything past about twenty nodes into an overview and a detail diagram. [skills/excalix/SKILL.md](skills/excalix/SKILL.md) has the rest. Validation names every problem in one go:

```
edges[0].to: unknown node "apy", did you mean "api"?
nodes[2].kind: got "db", expected one of "client", "service", "datastore", "queue", "cache", "external"
```

## Why

An `.excalidraw` file is nothing but coordinates, and an agent asked to draw one has to invent all of them. excalix takes the geometry away, so two diagrams made a year apart look like one set, and a change to the spec shows up as a reviewable diff.

`pnpm test` and `pnpm typecheck` run the checks. MIT, and not affiliated with Excalidraw.
