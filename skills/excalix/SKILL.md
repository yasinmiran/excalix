---
name: excalix
description: 'Use when someone asks to "draw the architecture", "sketch a diagram", "make an architecture diagram", "diagram this system", or to put a system into "excalidraw". Turns a topology spec into .excalidraw, .svg and .png.'
---

# excalix

Reach for this when the ask is a picture of a system: services and what calls
what, a request path, a deployment boundary. You write the topology, excalix
picks every shape, colour, size and route. A node's `kind` and its optional
`icon` say what the node is, never how it looks, so there is nothing visual to
configure; do not try. If the diagram reads wrong, the fix is in the spec.

Not for flowcharts, sequence diagrams, ER diagrams or state machines.

## The spec

JSON with `nodes` and `edges`, optional `title`, `direction` (`lr` default, or
`tb`), and `groups` for boundaries that nest through `parent`.

```json
{
  "title": "order pipeline",
  "groups": [{ "id": "aws", "label": "AWS eu-north-1" }],
  "nodes": [
    { "id": "web", "label": "Web app", "kind": "client" },
    { "id": "api", "label": "Order API", "kind": "service", "icon": "server", "group": "aws" }
  ],
  "edges": [{ "from": "web", "to": "api", "label": "POST /orders" }]
}
```

`kind` is one of `client` (browsers, apps, anything that initiates requests),
`service`, `datastore` (database or durable storage), `queue` (queue, topic or
stream), `cache` and `external`. The choice between `service` and `external` comes down
to who operates the thing, not who wrote it. Anything inside your own boundary
that you configure is a `service`, load balancers, CDNs, API gateways and DNS
included.
`external` means another company runs it and you only call it: a payment API, a
hosted identity provider, an email sender.

`icon` is optional, one name per node from a fixed catalog, and excalix draws it
as a small line icon left of the label: `user`, `users`, `browser`, `phone`,
`desktop`, `terminal`, `bot`, `globe`, `cloud`, `gateway`, `server`,
`container`, `function`, `database`, `cache`, `queue`, `storage`, `search`,
`file`, `mail`, `chat`, `bell`, `webhook`, `payment`, `lock`, `key`, `shield`,
`chart`, `logs`, `clock`, `settings`, `git`. Give the one that names the thing:
`database` for Postgres, `gateway` for an API gateway or a load balancer, `lock`
for an auth service, `key` for a secrets store, `bell` for notifications. Leave
it out when nothing fits, since an icon widens its node and a near miss misleads
more than no icon does. A name that is not in the catalog is rejected, with the
closest one suggested when it is a letter or two off, `"email"` getting
`did you mean "mail"?`.

`edge.style` is `sync` (solid, default) or `async` (dashed). `edge.arrows` is
`forward` (default), `both` or `none`. Run `excalix schema` for the whole shape,
and `excalix validate <spec.json>` to check one without rendering.

A node carries one `group` at most, and it has to be a single id, so
`"group": ["frontend", "backend"]` comes back rejected. A component that really
does sit on two networks goes in the group it runs in, and an edge crossing the
boundary carries the other relationship.

List the nodes in reading order, sources first. Where edges form a loop, order
decides which arrow runs backwards: the one from a node listed later to one
listed earlier. Among siblings it is a preference and no more, and the layout
reorders some of them when that keeps arrows from crossing. It will not move an
arrow onto a different route. When a route is what you want changed, the levers
are the direction of the edge itself, which nodes share a group, and `direction`.

Keep edge labels to a few words. A label sits on its arrow and the layout makes
room for it; past about twenty characters it wraps onto more lines, so a
sentence on one edge becomes a block that pushes the nodes apart. `\n`
anywhere in a label starts a new line, which is the way out when a node name is
genuinely long. An edge from a node back to itself is fine, and so are two edges
between the same pair; each one draws as its own arrow. A label on a self edge
costs more than it looks: the node grows until the loop is long enough to carry
the text, so give that one a single word or leave it bare.

## How much fits

Twenty nodes is roughly the ceiling for one picture, and a dozen boxes in a
single run reaches it sooner, since a chain stretches one way and stays thin the
other. Past the ceiling the image is scaled down before you read it, thin lines and
small labels start to go missing, and you end up reporting things the
coordinates do not say.

A long chain still reads better as `lr` and a deep hierarchy as `tb`, so try
`direction` first. When direction is not what is wrong, two diagrams is the
ordinary answer: an overview that collapses each region to one node, then a
detail diagram of the part under discussion. Rendering adds a note of its own
once the copy you would read shrinks edge labels below about 11 pixels: past
about 5800 pixels on the long side of a strip, sooner for a dense square.

## Running it

```
npx -y excalix render docs/arch.json -o docs/arch
```

Writes `<basename>.excalidraw`, `.svg` and `.png`. End `-o` with a slash and it
is a directory: `-o docs/diagrams/` writes `arch.excalidraw` and its siblings in
there. `--theme dark` draws the `.svg` and `.png` in Excalidraw's dark mode, and
`--theme both` adds `.dark.svg` and `.dark.png` beside the light pair; the MCP
tool takes the same as `theme`. A theme is how the picture is shown, never part
of the spec.

For a README or a web page, `--animate story` adds `.animated.svg` beside each
`.svg`: the same diagram building itself in a loop, title first, then every edge
in the order the spec lists it, after its two ends. List the edges in the order
you would walk someone through the system, then look at the PNG again, since
edge order also nudges the layout. `--animate layers` brings the layout in one
layer at a time instead, whatever order the edges are in. The MCP tool takes the
same as `animate`, and its `markdown` then shows the animated SVG, and the
still one to a reader who asks for reduced motion, while the image it hands
back stays the finished diagram.

## When it says no

Every problem comes back at once, each line naming the path, what arrived and
what would have been valid. This spec has two mistakes:

```json
{
  "nodes": [
    { "id": "cdn", "label": "CloudFront", "kind": "gateway" },
    { "id": "api", "label": "Order API", "kind": "service" }
  ],
  "edges": [{ "from": "cdn", "to": "apy" }]
}
```

`excalix validate` answers:

```text
nodes[0].kind: got "gateway", expected one of "client", "service", "datastore", "queue", "cache", "external"
edges[0].to: unknown node "apy", did you mean "api"?
```

There is no `gateway` kind. CloudFront is infrastructure you configure inside
your own boundary, so it is a `service`. The edge then points at an id nothing
defines, and the suggestion says which one was meant. With both fixed the
command prints `ok: 2 nodes, 1 edge, 0 groups` and exits 0.

## Then look at it

Read the PNG with the Read tool. Every time, before you report back. You are
checking for labels that collide with a box or another label, arrows that cross
more than the topology forces them to, and a flow that reads backwards, sources
on the right and sinks on the left. Fix those in the spec: flip `direction`,
group nodes that belong together, shorten a label, drop an edge that carries no
information. Re-render and look again.

Commit the spec JSON beside its outputs, so the next person regenerates the
diagram instead of redrawing it. The `.svg` and `.png` carry the scene too, so
either one dropped on excalidraw.com opens as the drawing, but an image
optimiser such as SVGO or a PNG crusher strips it: the `.excalidraw` stays the
source of truth.

When the excalix MCP server is registered, the `sketch` tool does all of this in
one call and hands back the picture inline, which saves the read. That copy fits
2000 pixels a side, and reading the `png` file whole usually shows you the same
copy; to judge a detail too small to see, crop that region from the `png` file,
scaling coordinates by `pixels.width / preview.width`. The tool's `out` is the
same basename as `-o`. A relative one resolves against the first root your
client declares, usually the project, or else against the directory the server
was started in. The result's `markdown` shows the SVG in a README, with paths
relative to that same directory, or absolute when a file is outside it; rewrite
them relative to the `.md` file they go into. With `theme` set to `both` it is a
`<picture>` that follows the reader's colour scheme.
