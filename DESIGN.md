# excalix design contract

One call, topology in, picture out. The caller (a human or an agent) states what
exists and what talks to what. excalix owns everything geometric: layout, shape
and colour per kind, text measurement, arrow binding, ids, seeds.

## Pipeline

```
parseSpec(json)            src/spec.ts        zod schema, semantic checks, defaults
  -> measure labels        src/render/*.ts    canvas measureText in headless Chromium (Excalifont)
  -> nodeSize per kind     src/style.ts       label + padding, min sizes, ellipse factor
  -> layout(LayoutInput)   src/layout.ts      ELK layered, compound groups, orthogonal edges
  -> buildElements(...)    src/elements.ts    Excalidraw elements, deterministic ids/seeds
  -> svg / png             src/render/*.ts    @excalidraw/utils exportToSvg / exportToBlob in-page
sketch()                   src/pipeline.ts    wires the above, returns SketchResult
CLI                        src/cli.ts         excalix render|validate|schema|mcp
MCP                        src/mcp.ts         stdio server, one tool: sketch
```

Shared types live in `src/types.ts`. Every module imports from there; nobody
redefines them.

## Spec (the agent-facing schema)

```jsonc
{
  "title": "order pipeline",                   // optional
  "direction": "lr",                           // "lr" (default) | "tb"
  "groups": [                                  // optional, nestable via parent
    { "id": "aws", "label": "AWS eu-north-1" },
    { "id": "k8s", "label": "EKS", "parent": "aws" }
  ],
  "nodes": [
    { "id": "web",  "label": "Web app",   "kind": "client" },
    { "id": "api",  "label": "Order API", "kind": "service", "group": "k8s" },
    { "id": "pg",   "label": "Postgres",  "kind": "datastore", "group": "aws" }
  ],
  "edges": [
    { "from": "web", "to": "api", "label": "POST /orders" },          // style defaults to "sync"
    { "from": "api", "to": "pg",  "style": "async", "arrows": "both" } // arrows: forward (default) | both | none
  ]
}
```

Validation (all problems reported at once, not first-fail):

- ids match `^[A-Za-z0-9_-]+$`, unique across nodes and groups together
- labels non-empty after trim; at least one node
- `node.group`, `group.parent`, `edge.from`, `edge.to` reference existing ids;
  edges reference nodes only, never groups
- group parents form a forest (no cycles)
- self-edges are allowed; duplicate edges are allowed (they're distinct arrows)

Defaults applied by parseSpec: `direction: "lr"`, `groups: []`, `edges: []`,
`edge.style: "sync"`, `edge.arrows: "forward"`. Unknown keys are rejected (zod
strict) so an agent's typo fails loudly instead of being ignored. When the
schema fails, the reference checks still run over whatever shape the input has,
so one round trip reports both the typo in a `kind` and the dangling edge.

## Visual vocabulary (src/style.ts)

Fixed per kind. No caller-facing colour, font, or shape options exist.

| kind      | shape                    | fill      | fillStyle | stroke  | notes                          |
|-----------|--------------------------|-----------|-----------|---------|--------------------------------|
| client    | ellipse                  | `#e9ecef` | solid     | `#1e1e1e` | people and browsers            |
| service   | rectangle, rounded       | `#a5d8ff` | solid     | `#1e1e1e` | the default "box"              |
| datastore | rectangle, sharp         | `#b2f2bb` | solid     | `#1e1e1e` |                                |
| queue     | rectangle, sharp         | `#ffec99` | hachure   | `#1e1e1e` | hatching reads as a stream     |
| cache     | rectangle, sharp         | `#ffd8a8` | solid     | `#1e1e1e` | sharp = stateful, rounded = compute |
| external  | rectangle, rounded       | transparent | solid   | `#1e1e1e` | strokeStyle `dashed`           |

- group: rectangle, sharp, fill `#f8f9fa`, stroke `#868e96` (grey so boundaries
  recede behind the flow), strokeStyle `dashed`, strokeWidth 1, label text
  top-left inside, fontSize 16, colour `#495057`
- edges: `sync` solid, `async` dashed; strokeColor `#1e1e1e`, strokeWidth 2;
  endArrowhead `"arrow"`; `arrows: "both"` also sets startArrowhead; `"none"`
  sets neither
- text: fontFamily Excalifont (`FONT_FAMILY.Excalifont`, numeric 5 in this
  build, confirm from `excalidraw-types/common/src/constants.d.ts`), node labels
  fontSize 20, edge labels 16, group labels 16, title 32, lineHeight 1.25
- roughness 1, strokeWidth 2 for nodes, opacity 100 everywhere
- node box = measured label + horizontal padding 24, vertical padding 16,
  minimum 120x56; an ellipse gets its label width scaled by sqrt(2) before
  padding so the text stays inside the curve (height keeps the plain padding,
  the minimum height already leaves room)
- multi-line labels (`\n` in label) are allowed; width is the widest line

## Layout (src/layout.ts)

ELK (`elkjs/lib/elk.bundled.js`, no worker) with:

- `elk.algorithm: layered`, `elk.direction: RIGHT | DOWN`
- `elk.hierarchyHandling: INCLUDE_CHILDREN` so edges may cross group borders
- `elk.edgeRouting: ORTHOGONAL`
- `elk.layered.considerModelOrder.strategy: NODES_AND_EDGES`: siblings keep the
  order the spec lists them in, as far as crossings allow
- group padding leaves room for the label: top = label.height + 16, others 16
- `elk.spacing.nodeNode: 48`, `elk.layered.spacing.nodeNodeBetweenLayers: 48`,
  `elk.spacing.edgeNode: 24`
- edge labels: `elk.edgeLabels.placement: CENTER`, `elk.edgeLabels.inline: true`,
  sizes passed through with a 12px margin on every side so the text never
  touches a neighbouring node (the returned label point is the text box, not
  the padded one)

Gotcha: ELK returns child coordinates relative to their parent node and edge
sections relative to the edge's containing node. Convert everything to absolute
before returning. Label positions likewise.

Output `LayoutResult`: absolute boxes for nodes and groups, a polyline per edge
whose first and last points lie on the source and target borders, label
top-left points, and overall bounds. Normalise so bounds start at (0, 0).

## Elements (src/elements.ts)

Produces `ExcalidrawElement[]` matching this exact build of Excalidraw. Type
against the vendored declarations via the tsconfig path alias
`excalidraw-types/*` -> `node_modules/@excalidraw/utils/dist/types/*` (type
imports only; e.g. `import type { ExcalidrawElement } from
"excalidraw-types/element/src/types"`). Read those declarations before writing
a field: the binding and text formats here are newer than most online examples.

Every element carries the full base: `id, x, y, width, height, angle: 0,
strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness,
opacity, roundness, seed, version: 1, versionNonce, index: null, isDeleted:
false, groupIds, frameId: null, boundElements, updated: EXCALIX_EPOCH,
created: null, link: null, locked: false`.

- Node label: a `text` element bound to its container. `containerId` set,
  container `boundElements: [{ type: "text", id }]`, `textAlign: "center"`,
  `verticalAlign: "middle"`, `autoResize: true`, `baseFontSize: null`,
  `originalText === text`, `lineHeight: 1.25`, measured width and height,
  x/y centred inside the container.
- Group: a `rectangle` plus a free `text` element (not bound) at the top-left
  inside the padding. Excalidraw grouping: every element inside a group
  (including nested group rects and their labels) lists the enclosing group ids
  in `groupIds`, deepest first. The group's own rect and label list their own
  group id first. This makes a group draggable as a unit on excalidraw.com.
- Arrow: `type: "arrow"`, `elbowed: false`, x/y = first polyline point, `points`
  relative to x/y starting at `[0, 0]`, `roundness: null` (orthogonal, sharp
  corners). Bindings use the fixed-point format: `startBinding: { elementId,
  fixedPoint: [fx, fy], mode: "inside" }` where fixedPoint is the endpoint
  normalised to the bound element's box (0..1 each axis; a coordinate within
  1e-4 of 0.5 is stored as 0.5001 because Excalidraw's restore nudges it, and
  storing the nudged value keeps a reload byte-identical). `inside` keeps the
  endpoint exactly where the layout put it; `orbit` would re-project it onto
  the outline plus a 6px gap on the first drag. Both bound elements also list
  the arrow in `boundElements: [{ type: "arrow", id }]`.
- Edge label: a `text` element bound to the arrow (`containerId` = arrow id,
  arrow `boundElements` includes it). Export and editor both ignore the stored
  x/y of arrow-bound text and place it from `labelPosition`, an arc-length
  parameter along the polyline, so the label is stored at the on-path point
  nearest ELK's label centre with x/y set to match. ELK's label point only
  reserves space.
- Title: free `text`, fontSize 28, top-left above the diagram bounds with 32px
  gap. Only when the spec has a title.
- Element order: Excalidraw needs the members of a group contiguous in the
  array, so each group emits one block (rect, label, its direct nodes, then its
  nested groups recursively), followed by ungrouped nodes, then arrows with
  their labels, then the title. Order is z-order.

Determinism: `ids.ts` derives every id, `seed`, and `versionNonce` from
`sha256(specHash + ":" + key)` where specHash is the sha256 of the canonical
JSON of the parsed spec and key is like `node:api`, `node:api:label`,
`edge:3`, `edge:3:label`, `group:aws`, `group:aws:label`, `title`. Ids are 20
chars of base62 from the hash. Seeds are 31-bit positive integers. Same spec
in, byte-identical `.excalidraw` and SVG out.

The `.excalidraw` document: `{ type: "excalidraw", version: 2, source:
"excalix", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: 20
}, files: {} }`.

## Render (src/render/)

`@excalidraw/utils` cannot run in Node (touches `devicePixelRatio`,
`document`, canvas). It runs inside headless Chromium via Playwright.

- `browser.ts` exports `createBrowserRenderer(): Promise<Renderer>` (see
  `Renderer` in types). One Chromium, one page, reused across calls; `close()`
  tears it down.
- The page is served from a fake origin (`http://excalix.local/`) through
  `page.route`, mapping `/vendor/*` to
  `node_modules/@excalidraw/utils/dist/prod/*` on disk. The bundle is a
  self-contained ES module (no bare imports).
- Fonts: this bundle never reads the vendored TTF. Excalifont ships inside the
  bundle as `data:font/woff2` faces split by unicode range, registered with
  `document.fonts.add` only during an export. The TTF measures up to 1px wider
  than those faces, so the renderer must not register its own `@font-face`.
- `measure(texts, fontSize)`: run one probe export at start-up so the faces
  are registered, then `document.fonts.load` and canvas `measureText` per line
  with Excalidraw's own font string (`"20px Excalifont, Xiaolai, sans-serif,
  Segoe UI Emoji"`), width = widest line, height = lines * fontSize * 1.25.
  This matches Excalidraw's own measurement so bound labels don't re-wrap on
  load.
- `svg(elements)`: `exportToSvg({ data: { elements, appState, files: {} },
  config: { padding: 24 } })` and return `outerHTML`. The SVG is
  self-contained: Excalidraw subsets the font with harfbuzz wasm on the main
  thread (one expected console error about workers per export) and inlines
  it, about 2 KB per script used.
- `png(elements)`: `exportToBlob` with `mimeType: "image/png"`, padding 24,
  2x scale; return bytes.
- `estimate.ts` exports `estimateMeasurer: TextMeasurer` using 0.6 * fontSize
  per char, for unit tests that must not launch a browser.

## CLI (src/cli.ts)

`node:util` `parseArgs`, no framework.

```
excalix render <spec.json> [-o <basename>]    writes <basename>.excalidraw, .svg, .png
                                              default basename: spec path without extension;
                                              a trailing slash on -o means a directory;
                                              validates before launching Chromium
excalix validate <spec.json>                  exit 0 or print all problems, exit 1
excalix schema                                JSON Schema of the spec to stdout
excalix mcp                                   stdio MCP server
```

Errors go to stderr, one per line, exit code 1. No colour, no spinner.

## MCP (src/mcp.ts)

`@modelcontextprotocol/sdk` `McpServer` over stdio. One tool, `sketch`.
Input: the spec plus an optional `out` (basename, absolute or relative to
cwd; defaults to `diagrams/<title slug>`, or `diagrams/diagram`). The tool
description doubles as the style guide: it lists every kind and edge style with
one line on when to use it, so a calling agent never guesses. Result content:
a text block listing the three written paths, then an `image` block with the
PNG (base64, `image/png`, taken from the in-memory result, never re-read from
disk) so the caller sees the diagram in the same turn. One browser per server
process, opened on the first call, dropped after a failed call so the next one
starts fresh, and closed before the process exits when stdin ends.
Validation errors return `isError: true` with the problem list.

## Conventions

- ESM, Node 22, TypeScript strict. Named exports only.
- No comments that restate code. Doc comment on exported functions, one line.
- Tests: vitest, colocated `*.test.ts`. Unit tests use `estimateMeasurer`.
  Render tests launch the browser and are tagged in their describe name with
  `[browser]`.
- No em dashes anywhere, including comments and docs.
- Conventional commits, no AI attribution.
