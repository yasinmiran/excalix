# Icons

The glyphs a node's `icon` draws. Each file is a Lucide icon (https://lucide.dev) from `lucide-static@1.56.0`, tarball sha256 `176ce6fb71be02910852cc5e243cac2399e85c13465ae1e742cb7a534eacb44a`, under the ISC licence in `LICENSE-lucide.txt`, which is upstream's `LICENSE` unchanged. Eight of them, `clock`, `database`, `lock`, `monitor`, `search`, `server`, `smartphone` and `terminal`, derive from Feather, and the same file carries the MIT notice that covers those.

| `icon` | file |
|---|---|
| `user` | `user.svg` |
| `users` | `users.svg` |
| `browser` | `app-window.svg` |
| `phone` | `smartphone.svg` |
| `desktop` | `monitor.svg` |
| `terminal` | `terminal.svg` |
| `bot` | `bot.svg` |
| `globe` | `globe.svg` |
| `cloud` | `cloud.svg` |
| `gateway` | `network.svg` |
| `server` | `server.svg` |
| `container` | `container.svg` |
| `function` | `square-function.svg` |
| `database` | `database.svg` |
| `cache` | `database-zap.svg` |
| `queue` | `gallery-horizontal-end.svg` |
| `storage` | `hard-drive.svg` |
| `search` | `search.svg` |
| `file` | `file-text.svg` |
| `mail` | `mail.svg` |
| `chat` | `message-square.svg` |
| `bell` | `bell.svg` |
| `webhook` | `webhook.svg` |
| `payment` | `credit-card.svg` |
| `lock` | `lock.svg` |
| `key` | `key-round.svg` |
| `shield` | `shield.svg` |
| `chart` | `chart-column.svg` |
| `logs` | `logs.svg` |
| `clock` | `clock.svg` |
| `settings` | `settings.svg` |
| `git` | `git-branch.svg` |

Every file keeps its upstream name, so the table is the whole mapping; `ICON_GLYPHS` in `src/style.ts` is the same table in code.

## Changes from upstream

Each file is upstream's `icons/<name>.svg` with three changes: the licence comment is gone, so is the `class` attribute, and so is the whitespace between tags. The result is then written out the way the Excalidraw editor's `normalizeSVG` writes it, attributes on one line and `/>` with no space before it. Paths, `viewBox`, stroke width, caps and joins are upstream's.

The editor runs `normalizeSVG` over every SVG file in a drawing it opens and replaces, and version-bumps, any file that comes out different, so the shipped bytes have to be its fixed point. They are produced with the copy of `@excalidraw/element` that the pinned `@excalidraw/excalidraw` devDependency resolves:

```js
const stripped = upstream
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\s+class="[^"]*"/, "")
  .replace(/>\s+</g, "><")
  .trim();
const shipped = normalizeSVG(stripped); // in a page; a second pass changes nothing
```

The files keep Lucide's `currentColor`, on every stroke and on the one filled dot in `key-round.svg`. excalix puts its own colour there when it draws an icon, from `ICON` in `src/style.ts`, so every icon is the colour of the labels beside it, in a dark export too: Excalidraw draws an SVG file through the same transform that darkens every other colour, and excalix writes that transform into a dark SVG as an SVG filter, since WebKit ignores the CSS filter function Excalidraw puts there.
