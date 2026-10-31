# Pinned fallback fonts

Excalidraw draws Excalifont text with the stack `Excalifont, Xiaolai, sans-serif, Segoe UI Emoji`. The `@excalidraw/utils` bundle embeds Excalifont and Xiaolai, so Latin, Greek, Cyrillic and CJK are drawn from fonts it ships. Any other glyph used to fall through to whatever the host has, which made the same label measure differently on macOS and Linux.

The two faces here close that gap. The renderer adds them to the page as more `Xiaolai` faces, after the bundle's, so they sit before every system font in the stack, for measurement and export alike. `faces.json` lists them in the order they are declared; where two ranges overlap, the later face wins, as with `@font-face` rules.

| File | Source | License |
|---|---|---|
| `twemoji-subset.woff2` | `twemoji-colr-font@15.0.3`, `twemoji.woff2`, sha256 `598b6867d47954acab46edd6a9773d734b844d221d3a95834da7442d5df64f98` | font OFL 1.1, art CC BY 4.0, see `LICENSE-twemoji.txt` |
| `dejavu-sans-subset.ttf` | `@fontsource/dejavu-sans@5.3.0`, `files/dejavu-sans-latin-400-normal.woff2`, sha256 `c3c7ca00b4538cc10906a5d4d921aab2369b2bee781168ef2ca695f3a5805760` | Bitstream Vera and Arev, see `LICENSE-dejavu.txt` |

The two licence files are the upstream packages' `LICENSE` files, unchanged.

## Changes from upstream

Both files are modified versions of the upstream fonts. Each is a subset holding only the code points `faces.json` lists, cut as described below, and the DejaVu cut drops hinting. Twemoji also carries, for each ligature spelled with U+FE0F, a copy spelled without it, so that browsers which drop U+FE0F before shaping still join the sequence. Outlines, colour layers and metrics are upstream's. Both keep their upstream family names, which neither licence forbids for a modified version.

The Twemoji art is copyright Twitter, Inc and other contributors (https://github.com/jdecked/twemoji, which continues https://github.com/twitter/twemoji), used under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/

## What each subset holds

- Emoji side: every code point at or above U+1F000, plus anything with `Emoji_Presentation`, `Emoji_Modifier` or `Regional_Indicator` in Unicode 15.1's `emoji-data.txt`, plus U+200D, U+FE0F, U+20E3 and the tag characters U+E0020 to U+E007F.
- DejaVu, `unicodeRange`: every code point above U+007F that DejaVu Sans maps, minus the emoji side, minus what Excalifont or Xiaolai already map.
- Twemoji, `unicodeRange`: every code point above U+007F that Twemoji maps, minus what Excalifont, Xiaolai or the DejaVu subset map.
- Twemoji, `sequenceRange`: what Twemoji maps that Excalifont or the DejaVu subset map, such as ☁, ✔, ↔, ❤, ♂, the digits and ©. On its own such a character stays text and comes from Excalifont or DejaVu. In one cluster with a character only Twemoji maps it is part of an emoji: before U+FE0F, U+20E3 or a skin tone, as in ☁️, 1️⃣ or ☝🏽, or joined by U+200D to an emoji, as in ❤‍🔥 or 🏃‍♂ with or without U+FE0F. Chromium draws a cluster from a face that maps all of it, so Twemoji has to cover such a character too or the host's emoji font would. U+200D alone pulls nothing into Twemoji, since it draws nothing: ☁‍☁ stays text. The rule matches what the page draws for every RGI emoji sequence, with or without U+FE0F, and may differ on a join that is not one, such as ™‍☁ or ☝⃣.

Text-default symbols such as ✔ or ☁ therefore come from DejaVu, and emoji, ✔️ and ☁️ included, from Twemoji. The six emoji Xiaolai maps, 〰 〽 ㊗ ㊙ 🉐 🉑, stay with Xiaolai, so the forms of 〰 〽 ㊗ ㊙ followed by U+FE0F still come from the host. So do emoji code points added after Unicode 15, which this Twemoji predates (newer sequences of older code points draw as their separate parts), and the scripts neither subset covers, Devanagari and Thai among them.

Both were cut with fontTools 4.68, `twemoji.unicodes` listing both Twemoji ranges:

```
pyftsubset dejavu-sans-latin-400-normal.woff2 --unicodes-file=dejavu.unicodes --layout-features='*' --no-hinting --flavor=none --output-file=dejavu-sans-subset.ttf
pyftsubset twemoji.woff2 --unicodes-file=twemoji.unicodes --layout-features='*' --flavor=woff2 --output-file=twemoji-subset.woff2
```

Twemoji then gets one change beyond the cut. Its ligatures spell U+FE0F, as in 🏃‍♂️ or 1️⃣, but Chromium folds a U+FE0F into the character before it when the font has no variation sequence for the pair, so HarfBuzz never sees one and 852 sequences fell apart: a runner beside a male sign, a keycap with nothing drawn. Each such ligature gets a twin without U+FE0F, which is the spelling Chromium shapes:

```python
from fontTools.ttLib import TTFont

font = TTFont("twemoji-subset.woff2", recalcTimestamp=False)
vs16 = font.getBestCmap()[0xFE0F]
for lookup in font["GSUB"].table.LookupList.Lookup:
    for subtable in lookup.SubTable:
        for ligatures in getattr(subtable, "ligatures", {}).values():
            spelled = {tuple(lig.Component) for lig in ligatures}
            for lig in list(ligatures):
                twin = [glyph for glyph in lig.Component if glyph != vs16]
                if len(twin) < len(lig.Component) and tuple(twin) not in spelled:
                    copy = type(lig)()
                    copy.Component, copy.CompCount, copy.LigGlyph = twin, len(twin) + 1, lig.LigGlyph
                    ligatures.append(copy)
                    spelled.add(tuple(twin))
            ligatures.sort(key=lambda lig: len(lig.Component), reverse=True)
font.save("twemoji-subset.woff2")
```

The cuts and the patch give the same bytes on every run.

## In the SVG

The exported SVG embeds, beside the bundle's own Excalifont and Xiaolai subsets, a subset of DejaVu holding the characters the diagram draws from it. It is cut at export time with the `harfbuzz-subset.wasm` that `harfbuzzjs` ships, which reads TrueType and not woff2, hence the `.ttf`. Twemoji stays out: that build of harfbuzz has no color table support, so a subset loses its COLR layers and draws black. Emoji in the SVG come from the viewer's emoji font, as they do in an SVG Excalidraw exports itself; the `.excalidraw` and the PNG are measured and drawn with Twemoji.
