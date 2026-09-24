# excalix

[![ci](https://github.com/yasinmiran/excalix/actions/workflows/ci.yml/badge.svg)](https://github.com/yasinmiran/excalix/actions/workflows/ci.yml)

Architecture diagrams from a topology spec, drawn in Excalidraw's hand-drawn style. You say what exists and what talks to what, and excalix decides where everything goes.

![order pipeline](https://raw.githubusercontent.com/yasinmiran/excalix/main/examples/order-pipeline.png)

The spec that drew it, in full:

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

Three files come out: a real `.excalidraw`, an SVG and a PNG. Drop the first one on excalidraw.com and the labels and arrow bindings are all intact, so you can keep editing by hand from wherever the generator stopped.

## Why

An `.excalidraw` file is all geometry. Every box carries an x, a y, a width and a height, every label has to be measured in Excalifont before it can be centred, and an arrow only stays attached to its boxes if it is bound to them by element id and a fixed point on the border. Ask an agent to "sketch the architecture in Excalidraw" and it has to invent every one of those numbers. What comes back tends to have boxes sitting on top of each other and text that re-wraps the moment the file is opened, and the arrows are plain lines, so they stay behind when you drag a node.

People have a milder version of the same problem. The diagram in the design doc was laid out by hand a long time ago, nobody wants to move twelve boxes to fit one new queue, and so it slowly stops matching the system.

excalix splits the job. The caller owns topology: nodes with a `kind`, the edges between them, and any groups such as a VPC or a cluster that they sit in. Everything geometric belongs to the tool, which covers layout, the shape and colour for each kind, text measurement, arrow binding, and element ids and seeds. Nothing visual is configurable. Two diagrams made a year apart by different agents still look like one set, and because the same spec always produces a byte-identical `.excalidraw`, on a laptop and in CI alike, a diagram change shows up as a reviewable diff in a pull request. (Labels with emoji or CJK are the exception: those glyphs come from a system font, which measures differently per platform.)

## Install

Not on npm yet ([#8](https://github.com/yasinmiran/excalix/issues/8)), so clone it:

```
git clone https://github.com/yasinmiran/excalix
cd excalix
pnpm install
pnpm exec playwright install chromium
pnpm build
```

The Chromium download is required. Excalidraw's export code and the font measurement both run inside a headless browser.

## For agents

`excalix mcp` is an MCP server with one tool, `sketch`. Register it with Claude Code once and every project has it:

```
claude mcp add excalix --scope user -- node /absolute/path/to/excalix/dist/cli.js mcp
```

Its input is the spec plus an optional `out` basename (default `diagrams/<title slug>`, resolved against the server's working directory). It returns the three written paths and then the PNG inline, so the calling agent sees the diagram in the same turn it asked for it and can send back an adjusted spec. The same paths come back as structured content too, with the pixel size of that PNG next to them; a client that ignores structured content loses nothing.

The tool advertises the spec schema that `excalix schema` prints, with `out` added. Both are serialized from the same zod schema, and a test compares them so the two cannot drift apart. A spec it turns down comes back as the problem list `excalix validate` prints, every problem in the one call.

The repo's `.mcp.json` registers the same server at project scope through a relative path, which only resolves when the client starts inside this repo.

`skills/excalix/SKILL.md` is the guide written for the agent rather than for you. It says when to reach for excalix, how to write a spec that comes out readable, and then insists the agent look at the PNG before reporting back. Symlink it into `~/.claude/skills/` and Claude Code loads it whenever someone asks for an architecture diagram:

```
ln -s /absolute/path/to/excalix/skills/excalix ~/.claude/skills/excalix
```

## Command line

```
excalix render <spec.json> [-o <basename>]   write <basename>.excalidraw, .svg and .png
excalix validate <spec.json>                 check the spec, print its counts or every problem
excalix schema                               print the JSON Schema of the spec
excalix mcp                                  serve the sketch tool over stdio
```

`render` defaults the basename to the spec path without its extension. A trailing slash on `-o` means a directory. Inside a clone, `node dist/cli.js` stands in for `excalix`:

```
node dist/cli.js render examples/order-pipeline.json -o out/order-pipeline
```

## The spec

`nodes` and `edges`, an optional `title`, `direction` (`lr` by default, or `tb` for top to bottom), and `groups` for the boundaries nodes sit in. `node.kind` fixes a node's shape and colour:

| kind | what it is |
|---|---|
| `client` | people, browsers, mobile apps, anything that initiates requests |
| `service` | an application component you run, or managed infrastructure you configure inside your own boundary: load balancer, CDN, API gateway, DNS |
| `datastore` | database or durable storage |
| `queue` | message queue, topic, or stream |
| `cache` | cache or in-memory store |
| `external` | a system another company operates and you only call, such as a payment API or a hosted identity provider |

The line between `service` and `external` is who operates the thing. An ALB or a CloudFront distribution is configuration you own, so it draws as a `service`; Stripe sits on somebody else's side of the boundary and you only call it, so it is `external`.

`edge.style` says how the two ends talk, and `edge.arrows` says which ends get an arrowhead:

| value | meaning |
|---|---|
| `sync` (default) | request/response, solid arrow |
| `async` | message or event, dashed arrow |
| `forward` (default) | one arrowhead, at the target |
| `both` | an arrowhead at each end, for a bidirectional link |
| `none` | no arrowhead, a plain association |

Groups nest through `parent`, and a node names at most one of them: a component that spans two boundaries goes in the one it runs in, with an edge across the border for the other relationship. `examples/auth-flow.json` is a top-to-bottom spec without any groups:

<img src="https://raw.githubusercontent.com/yasinmiran/excalix/main/examples/auth-flow.png" width="560" alt="login flow">

### A spec that reads well

- List the nodes in reading order, sources first. Siblings keep that order as far as edge crossings allow, and that is the whole of what order does. Reshuffling `edges` to chase a route is wasted effort; what changes a layout is the direction of an edge, which nodes share a group, and `direction`.
- Keep edge labels to a few words. A label rides on its arrow and reserves that much width, so a sentence on one edge stretches the whole diagram to fit it. A `\n` in any label starts a new line.
- An edge may loop from a node back to itself, and two edges between the same pair stay two arrows.
- One diagram holds about twenty nodes before it stops being readable at a glance, and fewer when they run in a single chain. Beyond that the PNG gets big enough that anyone looking at it scaled down, an agent especially, starts losing thin lines and small labels. Split the system into an overview and a detail diagram instead; `render` and `sketch` both add a line saying so once the longest side of the PNG passes 6000 pixels.

The skill file has the longer version of each of these.

### When it says no

Unknown keys are rejected, and `excalix validate` reports every problem at once, so a typo costs one round trip instead of several. Each line names the path, shows what it found and says what would have been valid, and an id that is nearly right comes back with the id it is nearly:

```
edges[0].to: unknown node "apy", did you mean "api"?
nodes[2].kind: got "db", expected one of "client", "service", "datastore", "queue", "cache", "external"
```

A spec with nothing wrong prints `ok: 7 nodes, 6 edges, 2 groups` and exits 0. `excalix schema` prints the full JSON Schema.

## How it works

The spec is validated with zod. Labels are measured with canvas `measureText` against the real Excalifont in headless Chromium, because a label sized with the wrong metrics re-wraps when the file is opened in the editor. ELK lays out the graph in layers, with groups as compound nodes and orthogonal edges. The element builder derives every id and seed from a hash of the spec, and `@excalidraw/utils` exports the SVG and PNG inside the same browser page.

[DESIGN.md](DESIGN.md) is the full contract, module by module. `stress/` holds adversarial specs (dense nested groups in both directions, self loops and repeated pairs, long labels, groups nested three deep); render them and look at the PNGs before trusting a layout change.

## Development

```
pnpm test        vitest; the suites under src/render/ launch Chromium
pnpm typecheck   tsc --noEmit
pnpm build       compile to dist/
```

Every spec in `examples/` and `stress/` runs through the geometry invariants under both measurers, and the committed `order-pipeline.excalidraw` is compared byte for byte, so a layout change that forgets to regenerate the examples fails the suite. CI runs it all on Linux for every push, and open work is in the [issues](https://github.com/yasinmiran/excalix/issues).

## License

MIT. excalix is an independent project and is not affiliated with Excalidraw; it builds on [`@excalidraw/utils`](https://www.npmjs.com/package/@excalidraw/utils), which is MIT licensed too.
