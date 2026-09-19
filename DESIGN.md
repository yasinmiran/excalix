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

One mistake is reported once. A schema problem hides a reference problem on the
same path, so a bad id is named only by the schema. It also hides the problems
inside a value the schema rejected outright, because those fields never
arrived: a node that is a string has no label to be blank. An unknown key is
the exception, being a problem with that one key: the rest of the object is
real and its own problems come back alongside.

### Problem messages

An agent fixes a spec from this text alone, so every line reads
`<path>: <what arrived>, <what is valid>`:

```
nodes[0].kind: got "db", expected one of "client", "service", "datastore", "queue", "cache", "external"
nodes[0].kind: missing, expected one of "client", "service", "datastore", "queue", "cache", "external"
nodes[0]: unknown key "shape", expected one of "id", "label", "kind", "group"
nodes[0].id: got "a b", expected letters, digits, "_" and "-" only
nodes[0].label: got "  ", expected text
nodes: got an empty array, expected at least one node
nodes[1].id: duplicate id "api", expected an id no other node or group uses
edges[0].from: "aws" is a group, expected a node
edges[0].to: unknown node "apy", did you mean "api"?
groups[0].parent: "k8s" closes the cycle aws -> k8s -> aws
```

The path is the one zod reports, with `spec` for the root; the value is
JSON-quoted, except that an array or object is named rather than printed.

Both halves of a schema problem live on the zod schema, as an `error` function
per field, not in the formatter: `issue.input` reaches an `error` function but
is stripped from the finished issue, so the `got ...` half can only be produced
there. `stringField` is that wording for a plain string, exported so a caller
adding a key of its own, such as the MCP tool's `out`, reports a wrong type in
the same words.

An unknown id gets `, did you mean "x"?` when one existing id of the expected
kind is within a small edit distance: 1 for a target of four characters or
fewer, 2 above that, compared case-insensitively, first in spec order on a tie.
The matcher is a plain Levenshtein in `spec.ts`, no dependency.

`specSchemaWith(extra)` is the spec schema with extra top-level keys, used by
the MCP tool for `out`. Zod's `.extend()` would drop the root description and
leave the unknown-key message listing keys that no longer match, so callers that
add a key go through this instead. `parseSpecWith(schema, input)` runs the same
two passes over such a schema and returns the extra keys with the spec;
`parseSpec` is that with the plain one.

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
  recede behind the flow), strokeStyle `dashed`, strokeWidth 1, label text in the
  top padding strip, fontSize 16, colour `#495057`
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
- edge labels: `elk.edgeLabels.placement: CENTER` and
  `elk.edgeLabels.inline: true` go in each label's own `layoutOptions`. ELK
  reads both from the label and ignores them on the graph, and without `inline`
  it reserves the box beside the edge instead of on it. The box handed to ELK is
  the measured text grown by a 12px margin on every side, so what ELK reserves
  is the text plus its clearance, centred on the route
- self loops: ELK places their labels beside the loop even when the label asks
  to be inline, so `elk.spacing.nodeSelfLoop` stands the loop off its node by
  half the padded box and the text is centred on the loop's outer segment. The
  option is read from the containing parent, never from the node, so it goes on
  the root and on every group, and it is measured in the layered algorithm's
  internal frame, which is transposed for DOWN

Group labels own the top padding strip, but ELK routes edges through it, so the
layout places them after routing: each label goes at the leftmost x in its strip
where no edge segment crosses the text box or runs within 12px to either side of
it, and at the top-left corner when the strip has no free slot. The 12px is
roughly an arrowhead's half width, which is what reaches the text when only the
line misses it.

A corner fallback that still leaves the label under an arrow triggers one more
ELK pass, with that group's left padding widened by enough to clear the leftmost
crossing. The widened gutter moves the crossing edges away from the corner
instead of moving the label away from it, so the label stays where a reader
looks for it. Placement then runs again on the new geometry and can still fall
back. Exactly one extra pass, never a loop, so the output stays deterministic.

Gotcha: ELK returns child coordinates relative to their parent node and edge
sections relative to the edge's containing node. Convert everything to absolute
before returning. Label positions likewise.

Output `LayoutResult`: absolute boxes for nodes and groups, a polyline per edge
whose first and last points lie on the source and target borders, a label per
labelled edge, a top-left point per group label, and overall bounds. An edge
label is the top-left of the text plus the arc-length parameter of its centre
along the polyline: the centre of the box ELK reserved is snapped onto the
polyline here, so bounds cover the final text boxes. Normalise so bounds start
at (0, 0).

## Elements (src/elements.ts)

Produces `ExcalidrawElement[]` matching this exact build of Excalidraw. Type
against the vendored declarations via the tsconfig path alias
`excalidraw-types/*` -> `node_modules/@excalidraw/utils/dist/types/*` (type
imports only; e.g. `import type { ExcalidrawElement } from
"excalidraw-types/element/src/types"`). Read those declarations before writing
a field: the binding and text formats here are newer than most online examples.

Those declarations import `@excalidraw/math`, `@excalidraw/common`,
`@excalidraw/element` and `@excalidraw/excalidraw` by bare specifier, and none
of the four is installed as a package, so tsconfig maps each to its own
directory of vendored declarations as well. Keep those entries: without them
`skipLibCheck` swallows the unresolved imports and `angle`, `points` and every
other branded field silently becomes `any`.

`Radians`, `LocalPoint` and the unitless `lineHeight` are branded numerics
whose constructors live in those uninstalled packages, so `elements.ts` exports
`radians`, `localPoint` and `lineHeight`. Those three are the only brands
`elements.ts` asserts; the tests build elements through them too. The fourth
brand, `FractionalIndex`, belongs to `fractional-index.ts` below.

Every element carries the full base: `id, x, y, width, height, angle: 0,
strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness,
opacity, roundness, seed, version: 1, versionNonce, index, isDeleted:
false, groupIds, frameId: null, boundElements, updated: EXCALIX_EPOCH,
created: null, link: null, locked: false`.

- Node label: a `text` element bound to its container. `containerId` set,
  container `boundElements: [{ type: "text", id }]`, `textAlign: "center"`,
  `verticalAlign: "middle"`, `autoResize: true`, `baseFontSize: null`,
  `originalText === text`, `lineHeight: 1.25`, measured width and height,
  x/y centred inside the container.
- Group: a `rectangle` plus a free `text` element (not bound) at the point the
  layout chose for it in `groupLabels`. Excalidraw grouping: every element
  inside a group (including nested group rects and their labels) lists the
  enclosing group ids in `groupIds`, deepest first. The group's own rect and
  label list their own group id first. This makes a group draggable as a unit
  on excalidraw.com.
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
  parameter along the polyline, so a label whose centre is off the path jumps
  when the file is opened. Both x/y and `labelPosition` come straight from
  `RoutedEdge.label`, which layout already put on the path.
- Title: free `text`, fontSize 32, top-left above the diagram bounds with 32px
  gap. Only when the spec has a title.
- Element order: Excalidraw needs the members of a group contiguous in the
  array, so each group emits one block (rect, label, its direct nodes, then its
  nested groups recursively), followed by ungrouped nodes, then arrows with
  their labels, then the title. Order is z-order.

Determinism: `ids.ts` derives every id, `seed`, and `versionNonce` from
`sha256(specHash + ":" + key)` where specHash is the sha256 of the canonical
JSON of the parsed spec and key is like `node:api`, `node:api:label`,
`edge:3`, `edge:3:label`, `group:aws`, `group:aws:label`, `title`. Ids are 20
chars of base62 from the hash. Seeds are 31-bit positive integers. `index` is
the one field that comes from array position instead of the hash. Same spec
in, byte-identical `.excalidraw` and SVG out.

The `.excalidraw` document: `{ type: "excalidraw", version: 2, source:
"excalix", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: 20
}, files: {} }`.

## Fractional indices (src/fractional-index.ts)

`index` is an order key in the format of rocicorp's `fractional-indexing`, which
Excalidraw vendors. `fractionalIndex(position)` returns the key for a position
in the element array, and `buildElements` stamps them on in a final pass once
the array order is settled. A null or out-of-order key sends restore through
`syncInvalidIndices`, which rewrites it with `mutateElement` and so bumps
`version`, `versionNonce` and `updated` on every element: without valid keys
the whole file is rewritten the first time someone opens and saves it.

What this build accepts, from `validateOrderKey` and `isValidFractionalIndex`
in the dev bundle:

- every character a base62 digit, `0-9A-Za-z`, which is also ASCII order, so a
  valid key sorts under plain string comparison
- an integer part whose length its head letter encodes: `a` two characters
  through `z` twenty-seven, and `A`..`Z` counting back down, 27 through 2, for
  the keys below `a0`. `A` followed by 26 zeros is reserved and always invalid
- an optional fractional part after the integer part, which may not end in `0`
- a key strictly between its neighbours in the array

So the keys here are integer parts counting up, `a0`..`az`, `b00`..`bzz`,
`c000`..`czzz` and on, 62 keys at the `a` head and 62^n at the nth. That is
digit for digit what the bundle's own `generateNKeysBetween(undefined,
undefined, n)` produces, so restore finds nothing to fix. The bundle cannot be
imported in Node (it reads `devicePixelRatio` at load), hence a local generator
rather than a call into it.

One rule beyond ascending: `validateFractionalIndices` with
`includeBoundTextValidation` demands that a bound text's key sit above its
container's, and the editor throws on a violation in dev and test builds.
`syncInvalidIndices` does not check it, so restore will not repair it. It holds
here because every container is emitted immediately before its text.

## Render (src/render/)

`@excalidraw/utils` cannot run in Node (touches `devicePixelRatio`,
`document`, canvas). It runs inside headless Chromium via Playwright.

- `browser.ts` exports `createBrowserRenderer(): Promise<Renderer>` (see
  `Renderer` in types). One Chromium, one page, reused across calls; `close()`
  tears it down. `openBundlePage(browser)` is that page without the renderer
  around it, for the restore check below.
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
- `restore.test.ts` runs the elements of every spec in `examples/` and `stress/`
  through Excalidraw's own restore inside the page and asserts nothing moves, so
  a field restore rewrites fails the suite instead of silently changing the file
  the first time someone opens it. The bundle exports no restore, but
  `exportToClipboard({ type: "json" })` serialises what `restoreElements`
  returned, and on this insecure origin `navigator.clipboard` is absent, so the
  bundle copies that JSON through `execCommand`, which the test intercepts.
  The comparison ignores no field: restore is a true no-op, so the restored
  elements are deep-equal to the built ones.
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

`schema` prints `z.toJSONSchema(specSchema, { io: "input" })`, which is the
schema the `sketch` tool advertises minus `out`. The two are serialized
separately, the MCP one against draft 7, so `mcp.test.ts` compares them and the
only differences allowed are `$schema` and `out`.

Errors go to stderr, one per line, exit code 1. No colour, no spinner.

## MCP (src/mcp.ts)

`@modelcontextprotocol/sdk` `Server` over stdio, with hand-written `tools/list`
and `tools/call` handlers. One tool, `sketch`, which runs to completion inside
the call (`execution.taskSupport: "forbidden"`).
Input: `specSchemaWith({ out })`, where `out` is a basename, absolute or
relative to the server's working directory, defaulting to
`diagrams/<title slug>` or `diagrams/diagram`. The tool description doubles as
the style guide: it lists every kind and edge style with one line on when to
use it, and says how the layout answers the spec (nodes in reading order, short
edge labels, `\n` for a new line), so a calling agent never guesses. Every
sentence in it has to change what the agent writes.

Result content: a text block listing the three written paths, then an `image`
block with the PNG (base64, `image/png`, taken from the in-memory result, never
re-read from disk) so the caller sees the diagram in the same turn.
`structuredContent` repeats the three paths under an `outputSchema` and adds
`pixels`, the PNG's own size read from its IHDR header, which tells an agent
that a long label stretched the layout without it having to measure the image.
The text block stays as three bare paths: a client that ignores structured
content is no worse off than before.

One validation surface. The handler calls `parseSpecWith(inputSchema, ...)`
itself, so schema problems and reference problems arrive in one `isError` text
block, the same lines `excalix validate` prints, and a spec wrong in both ways
costs one call. `McpServer` cannot do this: it parses the arguments against the
advertised schema before the handler runs and answers in its own frame, and it
reads one schema for both advertising and parsing, so a permissive parse would
advertise a permissive schema. Hence the low-level `Server`: `tools/list`
serves the tool verbatim, with both schemas serialized by `z.toJSONSchema`
against draft 7, and `tools/call` owns everything else. Validating in the
handler also means a bad spec never launches Chromium, as with `excalix render`.
A tool name we do not serve is a protocol error (`-32602`), not a result.

One browser per server process, opened on the first call, dropped after a
failed call so the next one starts fresh, and closed before the process exits
when stdin ends. Failures return `isError: true` and no structured content.

## Conventions

- ESM, Node 22, TypeScript strict. Named exports only.
- No comments that restate code. Doc comment on exported functions, one line.
- Tests: vitest, colocated `*.test.ts`. Unit tests use `estimateMeasurer`.
  Render tests launch the browser and are tagged in their describe name with
  `[browser]`.
- `src/__snapshots__/sketch-tool.md` is the whole agent-facing contract, the
  tool description and every schema with its field descriptions, as one page.
  `mcp.test.ts` writes it from `listTools()`, so any change to the wording or
  the schema turns up as a diff to read rather than a surprise in a client.
- `spec.test.ts` holds one table row per way a spec can be wrong, each with the
  exact text an agent gets back, and parses the example spec out of
  `skills/excalix/SKILL.md` so the skill cannot rot.
- `src/test-support.ts` is the shared harness: the spec corpus (`specFiles`,
  `readSpec`), `measuringOnly` (a renderer that measures and stubs svg and png,
  because the invariants read elements only), and `describeGeometry`, which
  registers six cells per spec: node overlap, nesting, edge labels clear of
  nodes and of each other, arrows clear of group labels, and bounds. A spec
  dropped in `examples/` or `stress/` is covered without touching a test.
  Defects a suite still has go in the `KNOWN` table it passes in, which turns
  those cells into `it.fails` with the reason in the test name, so fixing one
  fails the suite until its entry goes with it.
- Both measurers run those cells: `src/geometry.test.ts` with `estimateMeasurer`,
  `src/render/geometry.test.ts` with the real Excalifont metrics from a single
  `createBrowserRenderer()` shared by the file. The estimate is rough enough that
  a spec can be clean under it and broken in the rendered PNG, so the browser
  suite is the one that speaks for the output.
- `src/pipeline.test.ts` sketches every spec twice and compares the `.excalidraw`
  strings byte for byte, so neither ELK pass can leak into the next sketch, and
  reverses the keys inside one spec's JSON objects to show the output follows the
  canonical form rather than key order.
- `src/render/restore.test.ts` picks up a new spec in either directory the same
  way. It covers `restoreElements(elements, null)`, what every export path runs
  minus the flag that deletes invisibly small elements, which excalix never
  emits. Opening a file on excalidraw.com also runs the `repairBindings`
  pass, which repairs containers and bindings and reorders bound text, and no
  export reaches it, so bumping `@excalidraw/utils` still means loading an
  example on excalidraw.com once and confirming that labels and arrow bindings
  do not move.
- No em dashes anywhere, including comments and docs.
- Conventional commits, no AI attribution.
