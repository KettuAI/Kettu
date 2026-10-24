# Brand

> Status: Implemented · The maintainer's brand guidelines, black and white v1.0, 2026-10-24 ([#33](https://github.com/overbench/overbench/issues/33)) · Geometry in `src/shared/brand.ts`, drawn by `src/renderer/src/components/brand.tsx`, files in `docs/brand/` and `build/`

The OverBench mark, the wordmark, how they combine, and where the app shows them. The interface's own colors and type are the [design system](./design-system.md); this document covers only the brand.

## The mark

Three mountains standing on one bench. The mountains are the agents OverBench drives, each separate, with a clear line between them; the cuts stop at the bench instead of running through it, because every agent works on the same bench, in one interface; the front mountains overlap the ones behind, as OverBench is the one layer over all of them.

- **Construction**: a 60° grid measured in a unit u. The mountains' sides are 3u, 3u and 2u, each 1u from the next; the whole mark is 4u by 2.6u; the bench is 0.5u thick; each wedge cut opens 0.26u and ends at the bench. Corners round at 0.25u outside, 0.2u at the peaks and 0.1u at the shoulders and the foot of each cut.
- **Artboard**: every size rule measures the mark's 80 × 52 box (`MARK_BOX`), not the shape inside it.
- **Versions**: the **standard** version from 48 px wide (12 mm in print), and the **small** version, with wider cuts and a thicker bench so both cuts still read, from 16 to 47 px (5 to 12 mm). `markVersionFor(width)` picks one; nothing below 16 px.
- **Clear space**: x = 1u, a quarter of the mark's width, on every side. Nothing else enters it.

## The wordmark

"OverBench", in that case, set in Manrope SemiBold (600) with −1% tracking. The app and the files carry it as outlines (`WORDMARK`), so nothing depends on the font being installed; it stays outlined until a custom wordmark replaces it. Elsewhere, English and figures use Manrope and Chinese uses PingFang on macOS and Source Han Sans elsewhere; headings at SemiBold with −1% tracking, body text at Regular or Medium on a 1.6 line height. The interface's own type stays [Inter](./design-system.md#typography).

## Lockups

The mark and the wordmark combine only in these fixed proportions (`lockupGeometry`), never adjusted by hand:

| Lockup                | Mark width       | Gap              | Alignment            |
| --------------------- | ---------------- | ---------------- | -------------------- |
| Horizontal, preferred | 1.95 × font size | 0.45 × font size | Centred vertically   |
| Vertical              | 3.3 × font size  | 0.6 × font size  | Centred horizontally |

The wordmark sits in a line box one font size tall, as text with a line height of 1 does, so the lockup matches the guidelines' own drawing. A lockup is at least 100 px wide; below 48 px of mark width it takes the small version.

## Color

The brand is black and white for now.

| Name  | Value     | Use                                                       |
| ----- | --------- | --------------------------------------------------------- |
| Ink   | `#1C1B18` | The mark on light grounds; the ground of reversed artwork |
| Paper | `#F4F3EE` | The mark on dark grounds; light grounds                   |
| Black | `#000000` | One-color print, foil and engraving (K100)                |
| Stone | `#8A8A85` | Supporting text in brand artwork; never the mark          |

In the app the mark takes `--brand-overbench`: ink in the light theme, paper in the dark one.

## Misuse

Never stretch or squash it, rotate or skew it, draw it as an outline, drop the cuts or the bench, add shadows or glows, set it on a ground without enough contrast, change the wordmark's typeface or the lockup's proportions, or use the standard version below 48 px.

## App icons

`pnpm exec electron tools/brand/build.mjs`, run on macOS, draws every size from `src/shared/brand.ts` and writes the icons to `build/`, where electron-builder picks them up, and the vector files and the preview image to `docs/brand/`. Each size is drawn at its own pixel size; the mark is 62% of the tile's width and centred on its outer box, and tiles from 48 px take the standard version.

- **macOS** (`build/icon.icns`, the default dark icon): Apple's grid, an 824 px tile on a 1024 px canvas, 22.5% corners, a gradient from `#2C2B28` to `#161513` with a lit top edge, and a soft shadow; the mark in paper.
- **Windows** (`build/icon.ico`, 16 to 256 px): a flat ink square filling the canvas, 12% corners; at 16 px the mark grows to 69% so its cuts still show.
- **Linux** (`build/icon.png`, 1024 px): the macOS tile.

The guidelines also define a light macOS icon; it is not shipped, since an `.icns` has one appearance.

## In the app

| Where                                | What                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| [Sidebar](./ui.md#sidebar) header    | The horizontal lockup at 14 px, after the traffic lights on macOS, before the toggle |
| [New session](./ui.md#new-session)   | The mark, 48 px wide, centred above the heading                                      |
| [Launch](./ui.md#launch), when slow  | The mark, 72 px wide, above "Starting OverBench…"                                    |
| Settings › [About](./ui.md#settings) | The horizontal lockup at 22 px in place of the title, named "OverBench"              |

The marks are decorative where text beside them already says OverBench; the lockup is an image named "OverBench".

## Outside the app

- **README**: the horizontal lockup, ink or paper with the reader's color scheme (`docs/brand/lockup-horizontal*.svg`).
- **GitHub and website preview** (`docs/brand/social-preview.png`, 1280 × 640): the horizontal lockup on paper. GitHub takes it in the repository's Settings › Social preview; it has no API for it.
- **Avatars**: a circle crop with the mark at 58% of the diameter, ink on paper or paper on ink.
