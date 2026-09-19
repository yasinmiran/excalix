---
name: excalix
description: 'Use when someone asks to "draw the architecture", "sketch a diagram", "make an architecture diagram", "diagram this system", or to put a system into "excalidraw". Turns a topology spec into .excalidraw, .svg and .png.'
---

# excalix

Reach for this when the ask is a picture of a system: services and what calls
what, a request path, a deployment boundary. You write the topology, excalix
picks every shape, colour, size and route. There is nothing visual to configure,
so do not try; if the diagram reads wrong, the fix is in the spec.

Not for flowcharts, sequence diagrams, ER diagrams or state machines.

## The spec

JSON with `nodes` and `edges`, optional `title`, `direction` (`lr` default, or
`tb`), and `groups` for dashed boundaries that nest through `parent`.

```json
{
  "title": "order pipeline",
  "groups": [{ "id": "aws", "label": "AWS eu-north-1" }],
  "nodes": [
    { "id": "web", "label": "Web app", "kind": "client" },
    { "id": "api", "label": "Order API", "kind": "service", "group": "aws" }
  ],
  "edges": [{ "from": "web", "to": "api", "label": "POST /orders" }]
}
```

`kind` is one of `client` (browsers, apps, anything that initiates requests),
`service` (a component you run), `datastore` (database or durable storage),
`queue` (queue, topic or stream), `cache`, `external` (third-party you don't
run). `edge.style` is `sync` (solid, default) or `async` (dashed). `edge.arrows`
is `forward` (default), `both` or `none`. Run `excalix schema` for the whole
shape, and `excalix validate <spec.json>` to check one without rendering.

List the nodes in reading order, sources first. Siblings keep the order you
write them in as far as the routing allows, so a spec that reads like the flow
draws like it too.

Keep edge labels to a few words. A label sits on its arrow and reserves that
much width, so a sentence on one edge pushes the whole diagram wide. `\n`
anywhere in a label starts a new line, which is the way out when a node name is
genuinely long. An edge from a node back to itself is fine, and so are two edges
between the same pair; each one draws as its own arrow.

## Running it

```
pnpm exec excalix render docs/arch.json -o docs/arch
node /absolute/path/to/excalix/dist/cli.js render docs/arch.json -o docs/arch
```

First form inside a repo that has excalix installed, second form anywhere else.
Writes `<basename>.excalidraw`, `.svg` and `.png`. End `-o` with a slash and it
is a directory: `-o docs/diagrams/` writes `arch.excalidraw` and its siblings in
there.

## Then look at it

Read the PNG with the Read tool. Every time, before you report back. You are
checking for labels that collide with a box or another label, arrows that cross
more than the topology forces them to, and a flow that reads backwards, sources
on the right and sinks on the left. Fix those in the spec: flip `direction`,
group nodes that belong together, shorten a label, drop an edge that carries no
information. Re-render and look again.

Commit the spec JSON beside its outputs, so the next person regenerates the
diagram instead of redrawing it.

When the excalix MCP server is registered, the `sketch` tool does all of this in
one call and hands back the PNG inline, which saves the read. Its `out` is the
same basename, resolved against the directory the server was started in rather
than yours.
