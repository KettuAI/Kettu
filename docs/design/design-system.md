# Design system

> Status: Draft · Applied by the [interface design](./ui.md) · Tokens live in `src/renderer/src/styles/globals.css` · Built in [M0.3](../milestones/m0.md#work-packages)

The visual language every screen is built from: surfaces, lines, density, type and motion. Components take every color, radius, size and timing from the tokens below. A value that is not here does not belong in a component; if one is missing, add it here first. Which value to choose where, and how the interface behaves, are the [visual style](./visual-style.md) and the [UX guidelines](./ux-guidelines.md).

## Design reference

The first desktop version benchmarks the Claude Desktop app, through the analysis in [open-claude-ui](https://github.com/Caho1/open-claude-ui) (MIT). Among desktop clients for coding agents it has the most polished interface, and the analysis records the measurements behind it: surface steps, densities, radii, curves and timings, and how the composer, the thread and tool approvals behave.

- **Taken**: the principles in this document and the measured values behind them, expressed as OverBench tokens on top of shadcn/ui.
- **Not taken**:
  - Brand identity: logos, the clay accent color, illustrations, sounds, product names and the proprietary typefaces. OverBench keeps a neutral palette, its own semantic colors and Inter.
  - Code: the reference reconstructs a proprietary app's bundles, so its code examples are a specification to read, never source to copy. Every behavior is implemented with OverBench's own stack.
  - Names: no `cds-` or `claude-` prefixes. Tokens follow shadcn and Tailwind naming.
- **Changed on purpose**: where OverBench deviates, the section says so and why.

## Principles

1. **Quiet chrome, loud content.** Surfaces are told apart by small lightness steps, not by lines. The agent's work is the highest-contrast thing on screen.
2. **One line per surface.** A surface has at most one enclosing border ([below](#one-line-per-surface)).
3. **The reference's density.** 32 px rows and controls, 20 px chrome icons and a 15 px composer, measured from the reference on 2026-10-23 ([#127](https://github.com/overbench/overbench/issues/127)); the compact density shipped until then read cramped beside it.
4. **Micro-interactions run on the compositor.** Hover, press, focus and looping indicators are CSS, so they cost no JavaScript per frame. Motion handles springs, layout, exits and gestures ([motion](#css-or-motion)).
5. **The stack first.** What shadcn/ui, Base UI, Tailwind or tw-animate-css already provides is used as it is, styled through the tokens; a custom implementation needs a reason written here.
6. **Every value is a token.** Colors, radii, sizes, durations and curves come from `globals.css`; components never hard-code them.

## Color

Every color, line color and shadow color in the renderer is a token in `src/renderer/src/styles/tokens.css`, the only file there that may hold a color literal. The palette is the maintainer's, set on 2026-10-23 ([#39](https://github.com/overbench/overbench/issues/39)): warm neutrals a trace off pure grey, and color only where it means something, by the rules in [visual style: color](./visual-style.md#color). Two checks in `pnpm lint` guard it ([color checks](./testing.md#color-checks)): no color literal outside the token file, and every text token at 4.5:1 on the surfaces it sits on.

- **Themes**: light values sit on `:root`, dark ones on `[data-theme='dark']`, which the settings store sets on `<html>`, and under `prefers-color-scheme: dark` until it has; the two dark blocks are identical, and the contrast check fails if they drift. A subtree can take a theme of its own with `data-theme`, as the theme tiles in Settings do. Tailwind's `dark:` variant follows `data-theme`.
- **Utilities**: Tailwind reads the tokens through `@theme inline` in `globals.css`: `bg-app`, `bg-sidebar`, `bg-surface`, `bg-subtle`, `bg-hover`, `bg-selected`, `bg-code-inline`, `bg-code-block`; `border-default`, `border-subtle`, `border-strong`; `text-primary`, `text-secondary`, `text-tertiary`, `text-placeholder`, `text-disabled`, `text-icon`; and `attention`, `attention-dot`, `danger`, `success`, `warning`, `link` and `focus` in every color utility. A fill in a text color is `bg-current` with that text utility.
- `BACKGROUND_COLOR` in `src/main/window.ts` is `--bg-app` of each theme, so the first frame does not flash; the Windows and Linux window controls draw their symbols in `--text-primary`.

### Palette

| Token                              | Light                        | Dark                   | Used for                                                                                                                                                             |
| ---------------------------------- | ---------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bg-app`                         | `#FFFFFF`                    | `#1B1B1A`              | The main area and the top bar                                                                                                                                        |
| `--bg-sidebar`                     | `#FAFAFA`                    | `#171716`              | The sidebar, Settings' column, the side panel                                                                                                                        |
| `--bg-surface`                     | `#FFFFFF`                    | `#232322`              | Inputs, the composer, cards, menus, popovers, dialogs                                                                                                                |
| `--bg-subtle`                      | `#F2F2F2`                    | `#2B2B29`              | The user's bubble, chips, neutral pills, tracks and tiles                                                                                                            |
| `--bg-code-inline`                 | `#F0F0F0`                    | `#2E2E2C`              | Inline code                                                                                                                                                          |
| `--bg-code-block`                  | `#F7F7F7`                    | `#20201F`              | Code blocks, diffs, commands, table headers                                                                                                                          |
| `--bg-hover`                       | `#EEEEEE`                    | `#2A2A28`              | A hovered row or button                                                                                                                                              |
| `--bg-selected`                    | `#E0E0E0`                    | `#33332F`              | The current session, a chosen item, a pressed toggle                                                                                                                 |
| `--border-default`                 | `#E7E7E7`                    | `#3A3A37`              | Inputs, cards, the composer, menus                                                                                                                                   |
| `--border-subtle`                  | `#EFEFEF`                    | `#2F2F2C`              | Dividers, table lines, the top bar's and sidebar's edges                                                                                                             |
| `--border-strong`                  | `#D6D6D6`                    | `#474743`              | A hovered or focused field, an outline button                                                                                                                        |
| `--text-primary`                   | `#141414`                    | `#ECECEA`              | Body text and titles                                                                                                                                                 |
| `--text-secondary`                 | `#525252`                    | `#B5B4AF`              | Descriptions, the top bar's information, model names, levels                                                                                                         |
| `--text-tertiary`                  | `#6B6B6B`                    | `#9A9994`              | Fold lines, times, meta                                                                                                                                              |
| `--text-placeholder`               | `#737373`                    | `#8F8E89`              | Placeholders in inputs                                                                                                                                               |
| `--text-disabled`                  | `#A3A3A3`                    | `#6B6A66`              | Unavailable items                                                                                                                                                    |
| `--icon-default`                   | `#6B6B6B`                    | `#9A9994`              | Icons at rest; `--text-primary` under the pointer                                                                                                                    |
| `--attention`                      | `#C2410C`, its dot `#EA580C` | `#FB923C`              | Waiting for your approval                                                                                                                                            |
| `--danger`                         | `#B42318`                    | `#F87171`              | Failure, deletion, a diff's deleted lines                                                                                                                            |
| `--success`                        | `#15803D`                    | `#4ADE80`              | A diff's added lines, nothing else                                                                                                                                   |
| `--warning`                        | `#B45309`                    | `#FBBF24`              | Usage from 80%                                                                                                                                                       |
| `--link`                           | `#2563EB`, hover `#1D4ED8`   | `#60A5FA`              | Links                                                                                                                                                                |
| `--focus`                          | `rgba(37,99,235,.55)`        | `rgba(96,165,250,.6)`  | The keyboard focus ring                                                                                                                                              |
| `--selection`                      | `rgba(37,99,235,.18)`        | `rgba(96,165,250,.28)` | Selected text, in the thread and the terminal                                                                                                                        |
| `--danger-tint`, `--danger-border` | `#FDF6F5`, `#F1D5D1`         | `#2A1D1B`, `#4A2C28`   | The error notice and the line that ends a cut turn                                                                                                                   |
| `--queue-back`                     | `#F4F4F4`                    | `#1E1E1D`              | What a queued card darkens toward, from `--bg-surface`                                                                                                               |
| `--scrollbar-thumb`                | `rgba(0,0,0,.18)`            | `rgba(255,255,255,.2)` | Scrollbar thumbs, on a transparent track                                                                                                                             |
| `--canvas`                         | `#FFFFFF`                    | `#FFFFFF`              | The page under an [SVG code block](./ui.md#markdown)'s picture: an SVG with no background is drawn for a white page, so its dark strokes would vanish on a dark card |

- `--border-strong` and the dark `--link-hover`, which is `--link` itself, are the two values the palette did not give; they were derived here and wait for the maintainer's confirmation.
- The light theme was moved onto the reference's neutral greys on 2026-10-23 ([#127](https://github.com/overbench/overbench/issues/127)), sampled from its screenshots: a pure white canvas, a `#FAFAFA` sidebar, a `#E0E0E0` current row and text at `#141414`. The text steps below primary, the meaning colors and the dark theme keep the palette's values; the reference's lighter greys would fall under AA. The dark theme has no reference screenshot yet.
- Lines are opaque and keep their hairline width (`--hairline`: 1 px, 0.5 px on 2× displays and 1/3 px on 3×), so a line is one device pixel of its color on every display.
- Neither theme uses pure black or white for text.
- The surface steps other documents name are these tokens: surface 0 is `--bg-sidebar`, surface 1 `--bg-app`, and surfaces 2 (cards) and 3 (the composer, menus, dialogs) are both `--bg-surface`, told apart by their shadows.
- An [artifact canvas](./artifacts.md#canvas), the surface its pages lie on, is surface 0 (`--bg-sidebar`), not `--canvas`, so white pages stand off it in both themes.

### shadcn names

shadcn/ui's components use their own names, which `tokens.css` points at the palette, so they need no changes:

| shadcn and OverBench names                                                                                 | Palette token      |
| ---------------------------------------------------------------------------------------------------------- | ------------------ |
| `--background`                                                                                             | `--bg-app`         |
| `--sidebar`, `--terminal-background`                                                                       | `--bg-sidebar`     |
| `--card`, `--popover`, `--primary-foreground`, `--segment-thumb` (light)                                   | `--bg-surface`     |
| `--muted`, `--secondary`, `--tile`, `--segment-track`                                                      | `--bg-subtle`      |
| `--accent`, `--sidebar-accent`                                                                             | `--bg-hover`       |
| `--pressed`                                                                                                | `--bg-selected`    |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--primary` and the other `-foreground` names | `--text-primary`   |
| `--muted-foreground`                                                                                       | `--text-tertiary`  |
| `--border`, `--input`, `--track`                                                                           | `--border-default` |
| `--border-soft`, `--sidebar-border`                                                                        | `--border-subtle`  |
| `--destructive`                                                                                            | `--danger`         |
| `--ring`, `--sidebar-ring`                                                                                 | `--focus`          |

- `--segment-thumb` is `--bg-surface` in the light theme and `--bg-selected` in the dark one, so the thumb stays lighter than its track in both. `--pressed-hover` is `--bg-selected` with 5% of `--text-primary`.
- The derived meaning tokens: `--diff-add` is `--success` at 9% and `--diff-del` `--danger` at 8%; `--destructive-tint` is `--danger-tint` and `--destructive-tint-hover` `--danger` at 13%; `--attention-ring` and `--attention-halo` are `--attention` at 80% and 20%; `--attention-foreground`, a count on an attention fill, is `--bg-surface`.
- `--mark` (a soft yellow, `oklch(0.88 0.15 90 / 55%)` light and `oklch(0.8 0.14 85 / 32%)` dark), the text a search matched, keeps its value until the maintainer decides it; `--scrim`, black at 10% behind a dialog, likewise.

### Usage levels

A usage hint, a plan window's percentage such as "7 days 57%" or the context's, is `--text-tertiary` below 80% used, `--warning` from 80% and `--danger` from 95% or once the limit is reached. Its bar and its ring take the same step, with a neutral `--text-tertiary` fill below 80%. A prompt cache in its [last minutes](./ui.md#prompt-cache) is a usage warning too and takes `--warning`; nothing about the cache takes `--danger`. Progress that is not usage, such as a download, stays neutral.

### Model names and reasoning levels

A model's name and its reasoning level are `--text-secondary` wherever they show: the composer's model button, New session's route line and the Ultracode label. The model menu's reasoning level is a [segmented control](#segmented-controls) like any other, with no color of its own; the top tier's thumb still plays its one-time sheen when chosen, in a neutral light (`--sheen`, `--text-primary` at 6%), to be reviewed.

### Repository state

Git and pull request states are neutral, except what failed. Each state keeps its own Lucide icon, so the shape tells them apart.

| State                                      | Icon                                                                        | Color                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Open, draft, merged or closed pull request | `GitPullRequest`, `GitPullRequestDraft`, `GitMerge`, `GitPullRequestClosed` | `--icon-default`, the state word `--text-secondary`       |
| Checks passing or pending                  | `CircleCheck`, `CircleDot`                                                  | `--icon-default`                                          |
| Checks failing                             | `CircleX`                                                                   | `--danger`                                                |
| Commits not pushed                         | `ArrowUp` with the count                                                    | `--text-primary`; pushed and in sync is `--text-tertiary` |
| Conflicts                                  | `TriangleAlert`                                                             | `--danger`; a rebase in progress is neutral               |
| Lines added and removed                    | `+N`, `−N`                                                                  | `--success`, `--danger`                                   |

- Branch names and commit ids are monospace, at 12 px, with ids cut to 7 characters; in the top bar the branch and the change counts are `--text-secondary`.
- Pull request chips are neutral: `--muted` fill with a `--border-soft` ring and `--foreground` text.

### Terminal

The terminal sits in the side panel on surface 0, like the sidebar, so the thread on surface 1 stays the one canvas, framed by a quieter surface on each side. Its colors are tokens read by xterm.js:

| Token                   | Value            |
| ----------------------- | ---------------- |
| `--terminal-background` | `--bg-sidebar`   |
| `--terminal-foreground` | `--text-primary` |
| `--terminal-cursor`     | `--text-primary` |
| `--terminal-selection`  | `--selection`    |

The 16 ANSI colors are VS Code's defaults for its light and dark themes (MIT), tuned there for contrast on light and dark backgrounds. They color the programs' own output, so the palette's rules leave them as they are until the maintainer decides otherwise:

| Color   | Light normal | Light bright | Dark normal | Dark bright |
| ------- | ------------ | ------------ | ----------- | ----------- |
| Black   | `#000000`    | `#666666`    | `#000000`   | `#666666`   |
| Red     | `#cd3131`    | `#f14c4c`    | `#cd3131`   | `#f14c4c`   |
| Green   | `#107c10`    | `#14ce14`    | `#0dbc79`   | `#23d18b`   |
| Yellow  | `#949800`    | `#b5ba00`    | `#e5e510`   | `#f5f543`   |
| Blue    | `#0451a5`    | `#3b8eea`    | `#2472c8`   | `#3b8eea`   |
| Magenta | `#bc05bc`    | `#d670d6`    | `#bc3fbc`   | `#d670d6`   |
| Cyan    | `#0598bc`    | `#29b8db`    | `#11a8cd`   | `#29b8db`   |
| White   | `#555555`    | `#a5a5a5`    | `#e5e5e5`   | `#e5e5e5`   |

### Agent marks

Each agent is shown with its official mark in its own colors. They are the only brand colors in the interface.

| Agent       | Mark and colors                                                                                    | Source                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Claude Code | The Claude spark, `#D97757`                                                                        | [ACP Registry](https://github.com/agentclientprotocol/registry) (Apache-2.0) |
| Codex       | The Codex mark, a vertical gradient `#B1A7FF` → `#7A9DFF` → `#3941FF`                              | [`@lobehub/icons`](https://github.com/lobehub/lobe-icons) (MIT)              |
| OpenCode    | The two-tone OpenCode mark: frame `#17181C` and fill `#E6E5E6` light, `#FFFFFF` and `#5A5858` dark | [sst/opencode](https://github.com/sst/opencode) `packages/identity` (MIT)    |

- Sizes: 14 px in sidebar and list rows and before the session title in the top bar, 17 px on a 32 px tile in cards. The tile is `--tile` (`--bg-subtle`) with an inset `--border-soft` ring and an 8 px radius.
- An agent that is not installed shows its mark in one color, `--muted-foreground`.
- The marks ship as SVG files with their license notices; the gradient and the two OpenCode colors are tokens, so they follow the theme.

### File icons

Files and folders show their type's icon from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (`material-icon-theme`, MIT), the file icon theme most used in VS Code, resolved from its manifest the way VS Code resolves a file icon theme: the file name (with its parent folder, for names such as `.github/workflows`), then the extensions longest first, then the default; folders by name, open or closed. The light theme takes the manifest's light icons where it has them.

- The colors are the theme's own, unchanged: a reduced saturation was tried and read as dull ([problem 38](../milestones/m0-feedback.md#38-files-pane-no-markdown-preview-file-type-icons-or-editing)). Like the agent marks, they are colored by design, the only icons that are.
- Sizes: 16 px in the Files pane's rows and preview header, on [attachment](#attachments) tiles and in the `@` list, 12 px in a file chip in the thread.
- The manifest and the icons load on first use, in a chunk of their own; each icon is a file of its own, never inlined, so only those on screen are read. A plain line icon stands in until they load.

### Data graphics

The [usage page](./usage.md#interface) draws amounts. Its colors carry two meanings, kept apart so one chart never mixes them. They predate the palette's rule that brand colors stay on the agent marks, and wait for the maintainer's decision; until then they keep their values, the heatmap's blue as `--heat-hue`:

| Token                                  | Light                                                                | Dark                            | Used for                                                                |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `--agent-claude-code`, `--agent-codex` | `--brand-claude`, `--brand-codex-2` (the middle of Codex's gradient) | the same                        | An agent's series: its bars in the trend and its key in the legend      |
| `--agent-opencode`                     | `oklch(0.6 0 0)`                                                     | `oklch(0.72 0 0)`               | OpenCode's series; its mark is black and white, so a mid grey stands in |
| `--agent-other`                        | `oklch(0.78 0 0)`                                                    | `oklch(0.45 0 0)`               | An agent without a mark                                                 |
| `--heat-0`                             | `oklch(0 0 0 / 5.5%)`                                                | `oklch(1 0 0 / 6.5%)`           | A day without usage in the activity heatmap                             |
| `--heat-1`, `--heat-2`, `--heat-3`     | `--heat-hue` mixed at 26%, 48% and 74% with transparent              | the same, over the dark surface | The heatmap's quartiles of the days with usage, lowest first            |
| `--heat-4`                             | `--heat-hue`: `oklch(0.6 0.17 255)`                                  | `oklch(0.66 0.15 255)`          | The top quartile                                                        |

- **Series** take the agents' own colors, like their [marks](#agent-marks), so a bar is recognized without the legend.
- **Amount** is one hue that deepens, never a rainbow: more reads as more without a key of colors. The tokens-by-type table keys its rows with the same steps, and output with `--foreground` at 80%.
- Bars have a 2 px top radius (`rounded-t-xs`) and a 1 px gap; a bar's part too small for a pixel is drawn 1 px high, so it never reads as a day without usage. Heatmap cells are `rounded-xs` squares with a 2 px gap. Days outside the chosen range, and the hours still to come in a one-day trend, are dimmed to 35% opacity rather than recolored, and the hovered or focused cell takes a 1 px `--foreground` ring.
- **Scale**: a bar chart has one grid line, a 1 px dashed `--border-default` line at its tallest bar, with that bar's amount above its left end. Its labels and dates are captions in `--text-tertiary` with `tabular-nums`, set apart by the 12 px spacing step and never touching.
- **Legend**: a chart whose series can be hidden keys them with toggle buttons (`ToggleGroup` with `Toggle` `variant="legend"`), one Tab stop with the arrow keys between them, in the row above the chart; a chart has one legend, never a second one. A key is an 8 px square, the series' name and its amount in the item the chart names ("—" for none), in `--text-tertiary` with `tabular-nums`, which keeps the room of its widest amount so the keys never move. Shown, the square is the series color and the name `--foreground`; hidden, the key dims in place: the square is empty with a `--border-strong` ring and the name `--muted-foreground`. Under the pointer, the `--accent` fill.

## Borders and elevation

### One line per surface

| Closed border                                                                        | No border                                                                           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Composer, tool call cards, code blocks, diffs, attachments, dialogs, menus, popovers | Agent text, the user bubble (a fill only), sidebar rows, buttons inside a container |

- Inside a bordered container, parts are separated by a hairline `Separator` or a surface step, never by a second border.
- The sidebar and the side panel, on `--bg-sidebar`, meet the thread's `--bg-app` at a `--border-subtle` hairline, drawn by the resizable handle between them at rest, which turns `--border-strong` on hover and drag; the top bar's lower edge is the same hairline. The surface step alone read as an edge that was missing. A collapsed sidebar takes its line with it.
- Borders are drawn as an inset ring (`box-shadow`, Tailwind's `ring-inset`). A ring takes no layout space, follows the radius exactly, and can change on hover without moving anything.
- `--hairline` is 1 px, 0.5 px on 2× displays and 1/3 px on 3× displays (`@media (resolution >= 2x)`), so lines are as fine as the display allows.

### Elevation

| Tier     | Light                                                     | Used for                                                |
| -------- | --------------------------------------------------------- | ------------------------------------------------------- |
| none     |                                                           | Everything on the canvas at rest, list rows always      |
| composer | `0 4px 20px rgba(0,0,0,.06)`, measured from the reference | The composer (`shadow-sm` is the same)                  |
| queue    | `0 1px 6px rgba(20,20,19,.05)`                            | Queued message cards (`shadow-queue`)                   |
| popover  | `0 8px 24px rgba(20,20,19,.10)`                           | Menus, popovers, dialogs, floating buttons (`md`, `lg`) |

- In the dark theme every tier takes the same offsets and blurs in `rgba(0,0,0,.4)`, because a shadow on a dark surface barely shows. Raised surfaces there also keep a 1 px inset highlight along the top edge (`--highlight`, white at 5%), which reads as an edge catching the light.
- Small raised controls keep their contact shadows (`--elevation-button` under an outline button, `--elevation-thumb` under a switch's thumb, `--elevation-segment` under a segment's thumb), which the palette did not cover; they wait for the maintainer's confirmation.
- **Composer** (the `composer` variant of `InputGroup`, `rounded-4xl`): a 1 px `--border-default` ring and the composer shadow at rest; a 1 px `--border-strong` ring on hover and while it has focus, with no outline, as in the reference, where the caret and the darker line show where typing goes. The line is a full pixel, the one exception to the hairline, because the reference's composer line measures one CSS pixel. Only color and shadow change, so focusing never moves the text.
- **Queued cards** (the [queue stack](./ui.md#composer)): `--bg-surface` with a `--border-default` hairline and the queue shadow; a card further back darkens toward `--queue-back`, from `#FFFFFF` to `#F4F4F2` light and from `#232322` to `#1E1E1D` dark.
- **Attention**: a card waiting for your approval replaces its hairline with a 1 px `--attention` ring at 80% and a 3 px halo at 20%.
- **Focus rings**: the `focus-ring` utility, a 2 px `--focus` outline 2 px outside the element, on every control that takes keyboard focus; `focus-ring-within` draws it on a choice card whose control has focus. A text field, an edit in place among them, has no ring: like the composer, its border turns `--border-strong` and the caret shows where typing goes, so it keeps the size of what it replaced. A text field always matches `:focus-visible`, so a ring there showed on every click. The thread's scroller has no ring either: it takes focus on a click, and any key that scrolls it would frame the whole thread.
- **Viewer scrim**: the media [viewer](./ui.md#viewer) covers the window with `--viewer-scrim`, `oklch(0.13 0 0 / 92%)` in both themes, because pictures and video read best on dark, a token of its own since `--scrim` is the light veil behind a dialog; its bar and buttons take the dark theme's tokens on it, whatever the app's theme. It has no backdrop blur, which the flat style does without: a 40 px blur cost no frame time when measured (2026-10-22), so the choice is the look, not the cost. The maintainer saw no difference between the two scrims on the options page (2026-10-24), so the dark one stays.

## Density and sizing

One density, the reference's, measured from its screenshots on 2026-10-23 ([#127](https://github.com/overbench/overbench/issues/127)). Until then OverBench shipped a compact density (7 px radius, 26 px controls, 28 px rows, 16 px icons, 12.5 px control text), which read cramped beside the reference. Sizes in this document are CSS pixels at 100% [zoom](./ui.md#zoom), the level the window opens at.

| Token                 | Used for                                                           | Value                      |
| --------------------- | ------------------------------------------------------------------ | -------------------------- |
| `--radius`            | The base of shadcn's radius scale                                  | 8 px                       |
| `--control-height`    | Buttons and selectors, the top bar's icon buttons                  | 32 px                      |
| `--control-height-sm` | Small inline buttons                                               | 28 px                      |
| `--row-height`        | Sidebar rows, menu items, the plan row, the composer's control row | 32 px                      |
| `--card-header`       | Card headers, such as a permission request's                       | 36 px                      |
| `--composer-min`      | The composer with one line of text                                 | 56 px                      |
| `--icon-size`         | Chrome icons: the sidebar's nav rows, the top bar's buttons        | 20 px                      |
| Icon stroke           | Every Lucide icon, set once with `LucideProvider` in `main.tsx`    | 1 px at every size         |
| Spacing steps         | Gaps between and around components                                 | 4, 6, 8, 10, 12, 16, 28 px |

- Measured on the reference, at one CSS pixel to 1.56 screenshot pixels (calibrated on its 288 px sidebar): sidebar rows 32 px with 2 px between them and an 8 px radius, 20 px icons 8 px in from the row's edge, a 20 px composer radius, a composer about 114 px tall on its start screen, 14 px control text.
- The reference's icon strokes measure about 1.2 px; OverBench keeps the 1 px chosen on 2026-10-22 until the maintainer decides otherwise.
- The icon stroke is 1 screen pixel whatever the icon's size: `LucideProvider` sets `strokeWidth={1}` with `nonScalingStroke`, which draws the stroke with `vector-effect: non-scaling-stroke`. Lucide's own `absoluteStrokeWidth` scales the width by the `size` prop, which OverBench never passes because sizes come from classes, so it would draw a 16 px icon at 0.67 px. Chosen 2026-10-22 on the Settings canvas from 0.65, 0.8 and 1 px side by side, replacing the relative 1.5, which drew 14 and 12 px icons thinner than 16 px ones ([problem 37](../milestones/m0-feedback.md#37-icons-look-heavy-use-thin-line-icons-from-a-library)).

The radius scale is shadcn's, derived from `--radius`, so shadcn components follow it without new tokens:

| Utility        | Value   | Used for                                 |
| -------------- | ------- | ---------------------------------------- |
| `rounded-md`   | 6.4 px  | Segments and their thumb                 |
| `rounded-lg`   | 8 px    | Buttons, inputs, rows, menu items        |
| `rounded-xl`   | 11.2 px | Cards, the user bubble                   |
| `rounded-2xl`  | 14.4 px | Menus and popovers                       |
| `rounded-3xl`  | 17.6 px | Dialogs                                  |
| `rounded-4xl`  | 20.8 px | The composer, the reference's 20 px      |
| `rounded-full` |         | The send button, counts and status pills |

- Where OverBench's look differs from a shadcn component's default, the difference is a variant added to that component with `cva`, such as `InputGroup` `variant="composer"`, `Card` `variant="tool"` and a `Button` `size="compact"` bound to `--control-height`. Call sites never restyle a component with `className`; they use it for layout only.
- The compact spacing steps are Tailwind's `1`, `1.5`, `2`, `2.5`, `3`, `4` and `7`.
- Menu items are `rounded-lg` because they sit 6 px inside a `rounded-2xl` menu: 14.4 − 6 ≈ 8, so the item's corner follows the menu's. Segments sit inside their track the same way.
- shadcn's `xs` button (24 px) is the small size; `compact` and `default` are both 32 px, `compact` bound to `--control-height` with 14 px text.

## Typography

### Typefaces

| Text                                   | Typeface                                                                                                   | Source                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Latin letters, digits and punctuation  | Inter Variable, with its optical-size axis                                                                 | Bundled: `@fontsource-variable/inter`, 73 KB for the Latin file             |
| Chinese                                | The platform's interface face: PingFang SC on macOS, Microsoft YaHei on Windows, Noto Sans CJK SC on Linux | The system; a Chinese face runs to several megabytes, so none is bundled    |
| Code, commands and other text set mono | JetBrains Mono Variable, the same on every platform                                                        | Bundled: `@fontsource-variable/jetbrains-mono` (OFL-1.1), chosen 2026-10-22 |
| The New session heading                | Source Serif 4 Variable, with its optical-size axis                                                        | Bundled: `@fontsource-variable/source-serif-4` (OFL-1.1), chosen 2026-10-23 |

- Inter comes first in the stack (`--font-sans`), so in a Chinese sentence the Latin words, digits and punctuation are Inter and only the Chinese characters fall through to the platform face. `system-ui` ends the stack.
- Inter is the nearest open typeface to the reference's own sans at interface sizes: the same tall x-height, width and rhythm, where Geist read a size smaller and a shade lighter (chosen 2026-10-21 from a six-way render in the real build).
- With `font-optical-sizing: auto`, Inter takes its text design at interface sizes and its display design at title sizes by itself; no second family is loaded for headings.
- JetBrains Mono was chosen on 2026-10-22 over the platform's own monospace, Geist Mono and IBM Plex Mono, from a side-by-side render of code, diffs, branch names and look-alike characters in both themes. It keeps code, diffs and the terminal identical on macOS, Windows and Linux, where the platform faces differ in width and weight, and its tall x-height sits well beside Inter from 11.5 to 13 px. It is a renderer-only dependency, so it goes in `devDependencies`; only its Latin weight file is loaded, and it is added when the code is aligned with this scale.
- `--font-mono` is JetBrains Mono Variable, then `ui-monospace`, SF Mono, Cascadia Code, Menlo and Consolas as fallbacks; Chinese in mono text falls through to the platform's Chinese face. The terminal and the Files editor read `--font-mono`, so they follow it. xterm.js measures its cells when a terminal opens, so the face is loaded (`document.fonts.load`) before the first terminal opens, or the cells take the fallback's width.
- Source Serif 4 sets the New session heading and nothing else (`font-serif`), as the reference sets its start screen's greeting in a serif; chosen by the maintainer on 2026-10-23 ([#127](https://github.com/overbench/overbench/issues/127)). Its optical-size axis gives the display design at the greeting's size; the Latin file is 122 KB and loads only when the heading shows. Chinese falls through to the platform's sans face, as in the reference. No other typeface: no display face, no icon font.

### Type scale

Every size in the interface is one of these steps. Line heights sit on a 4 px grid, except prose and the small step, whose ratios come from the [prose](#prose) spec.

| Step      | Utility         | Size    | Line height | Weight | Tracking | Family |
| --------- | --------------- | ------- | ----------- | ------ | -------- | ------ |
| Greeting  | `text-greeting` | 34 px   | 40 px       | 400    | −1%      | Serif  |
| Display   | `text-display`  | 28 px   | 36 px       | 600    | −2%      | Sans   |
| Title     | `text-title`    | 22 px   | 28 px       | 600    | −1.5%    | Sans   |
| Heading   | `text-heading`  | 16 px   | 24 px       | 500    | 0        | Sans   |
| Prose     | `text-prose`    | 15 px   | 1.45        | 400    | 0        | Sans   |
| Interface | `text-ui`       | 14 px   | 20 px       | 400    | 0        | Sans   |
| Small     | `text-small`    | 13 px   | 1.6         | 400    | 0        | Sans   |
| Control   | `text-control`  | 14 px   | 20 px       | 500    | 0        | Sans   |
| Caption   | `text-xs`       | 12 px   | 16 px       | 400    | 0        | Sans   |
| Code      | `text-code`     | 12 px   | 18 px       | 400    | 0        | Mono   |
| Meta      | `text-meta`     | 11.5 px | 16 px       | 400    | 0        | Mono   |

- `--prose-size` is 15 px; **Text size** sets 14, 15 or 16 px. Prose is set at 1.45, the reference's measured 1.44: at 1.7 the gap between paragraphs was hardly larger than the gap between lines, so a reply read as one loose block ([problem 43](../milestones/m0-feedback.md#43-the-message-body-needs-a-typography-pass-to-a-given-spec), revised 2026-10-23).
- `--ui-size` is the reference's interface size, 14 px. The root stays 16 px, so Tailwind's rem scale is unchanged.
- Tracking is negative only on the greeting and the two steps that use Inter's display design, and never positive: there are no uppercase or letter-spaced labels.
- 11.5 px is the smallest text in the interface. A count in a pill, a badge or a chart label takes the meta step, never less.
- `text-greeting`, `text-title`, `text-heading`, `text-prose`, `text-ui`, `text-small`, `text-control`, `text-xs`, `text-code` and `text-meta` are in `globals.css`, each with its line height and tracking; `text-display` is added with its first use.

### Weights

- 400 for text, 500 for names and labels, 600 for titles and markdown headings; never 700.
- In the dark theme every weight drops by 40 on Inter's weight axis (400 becomes 360, 500 becomes 460, 600 becomes 560), as in the reference, because light text on a dark surface looks heavier than it is.
- The platform's Chinese faces have fixed weights, and CSS matches a weight of 360 to their Light (300), a step thinner than intended: measured on 2026-10-22 with PingFang SC in Chromium, 360 renders as Light, 460 as Medium and 560 as Semibold. So Chinese goes through an alias family whose `@font-face` rules map 300–449 to the face's Regular, 450–549 to its Medium and 550–700 to its Semibold (or the nearest weight a face has, since Microsoft YaHei has fewer), with `local()` sources for each platform's face, and sits second in `--font-sans`. Chinese text therefore keeps Regular, Medium and Semibold in both themes, while Inter takes the lighter dark weights. Checked on macOS; the Windows and Linux faces are checked in the [screenshots](./testing.md#screenshots).

### Setting text

- Numbers that change in place, such as timers, token counts, diff stats and counters, use `tabular-nums` so they do not jitter.
- Headings use `text-wrap: balance` and prose `text-wrap: pretty`. Paths, URLs and long identifiers use `overflow-wrap: anywhere`, so they never push a card wider than the column.
- Icons inline with text sit at `vertical-align: -0.125em`, which centres them on the text.

### Prose

The message body, from the typography spec of [problem 43](../milestones/m0-feedback.md#43-the-message-body-needs-a-typography-pass-to-a-given-spec), all under the `.markdown` class in `globals.css`. Sizes are in em of the prose size, so **Text size** scales them; the pixel values below are those of the default 15 px. Colors come only from the existing tokens, so the dark theme follows without values of its own.

- **Column**: 50em (750 px), about 50 Chinese characters a line, at a 1.45 line height; the reference measured about 51em. Text, bold and headings in `--text-primary`; weight and size carry the hierarchy. Paragraphs `text-wrap: pretty`, long paths and URLs `overflow-wrap: anywhere`, no letter spacing for Chinese.
- **Headings**: more space above than below, so each sits on its content. h1 20 px with `1.8em 0 0.4em`, h2 17 px with `1.75em 0 0.4em`, h3 15 px with `1.5em 0 0.3em`, h4 and below 15 px in `--muted-foreground`; all at the semibold weight, `text-wrap: balance`, none above the first block.
- **Paragraphs and emphasis**: `margin: 0 0 0.75em`; bold at the semibold weight, never 700; emphasis italic, except in Chinese text, where it is the medium weight upright (`data-cjk-emphasis`, set when the emphasis holds a Han character).
- **Lists**: `padding-left: 1.25em`, items 0.3em apart, markers in `--muted-foreground`, ordered numbers `tabular-nums`, nested lists 0.25em above and below, and no margin on a paragraph inside an item, so loose lists keep the spacing of tight ones.
- **Inline code**: mono at 0.8em in `--text-primary` on `--bg-code-inline`, `padding: 0.1em 0.35em`, radius 4 px, no border and no colored text.
- **Code blocks**: `--bg-code-block`, a 1 px `--border-subtle`, radius 8 px, 13 px at 1.6, padding 0 14px 12px under a 32 px header with the language at 12 px in `--muted-foreground` and the copy button as a ghost button; a block scrolls sideways and never wraps; 1em above and below. An `svg` block's picture replaces the text under the same header: centred, `0 14px 12px` from the frame, on a `--canvas` page with 12 px of page around it and `rounded-md` corners, so a shape with round corners keeps them.
- **Links**: `--link` with an underline in `--link` at 40%, 3 px below the text; on hover the text turns `--link-hover` and the underline full.
- **Syntax highlighting** keeps GitHub's themes (`github-light-default`, `github-dark-default` in Shiki, `@uiw/codemirror-theme-github` in the editor) until the maintainer picks the low-saturation theme the palette asks for; its comments must reach 4.5:1 on `--bg-code-block`, which GitHub's light comment, at 4.24:1, does not.
- **File chips**: `inline-flex`, 20 px high, `vertical-align: middle`, which keeps the name within 0.6 px of the text's baseline at any text size, and `margin-block: -1px`, so the line counts the chip as 18 px and a chip never makes its line taller, down to 14 px; the file icon and 3 px; 6 px of padding each side, radius 5 px; mono 11.5 px in `--muted-foreground` on `--muted`, no wrapping; 4 px from what comes before; `--accent` and `--foreground` on hover.
- **Blockquotes**: a 2 px `--border` rule on the left, 12 px in, `--muted-foreground`, no fill. **Tables**: no frame, in a wrapper that scrolls sideways; 14 px with `tabular-nums`; a `--bg-code-block` header row with its cells at the medium weight in `--muted-foreground`; cells `8px 12px`, every line `--border-subtle`, none under the last row, and no zebra stripes. **Rules**: 1 px `--border`, 1.5em above and below.
- The user's bubble, the tool call rows and the thread's spacing are in [Interface: thread](./ui.md#thread).

## Components

### Segmented controls

A choice among two to six ordered or exclusive values, such as the theme in Settings and the reasoning level in the model menu, is a segmented control (`SegmentedControl`, built on shadcn's `ToggleGroup` with its `segmented` variant):

| Part    | Look                                                                                                                                                                                                                                 | Token                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Track   | A recessed fill, `rounded-lg`, 2 px padding and 2 px gaps; 28 px high                                                                                                                                                                | `--segment-track`: `oklch(0 0 0 / 5%)` light, `oklch(1 0 0 / 6%)` dark |
| Segment | As wide as its label, sharing any room the track has left (`flex-auto`); 24 px high, 12.5 px text in `--muted-foreground` with 10 px padding (6 px in the model menu); the segment under the thumb (`data-active`) is `--foreground` | none                                                                   |
| Thumb   | One raised piece under the chosen segment, `rounded-md`                                                                                                                                                                              | `--segment-thumb`: `oklch(1 0 0)` light, `oklch(1 0 0 / 12%)` dark     |
| Ring    | The thumb's edge                                                                                                                                                                                                                     | `--segment-ring` (`shadow-segment`), below                             |

- `--segment-ring` is a hairline of `--border` and a 2 px contact shadow (`oklch(0 0 0 / 8%)`) in the light theme; in the dark theme, a 1 px top highlight (`oklch(1 0 0 / 6%)`) and a 2 px shadow at 30%. The tokens are translucent in the dark theme, so the control reads the same on a card and in a menu.
- The thumb is placed from the segments' measured boxes (a `ResizeObserver` keeps them current) and slides to the chosen segment with `translate` over `--duration-base` with `--ease-out-quart`; its width changes only between segments of different widths, and `contain: strict` keeps that layout to the thumb. Its first placement is not animated, so it never slides in from the track's edge. Pressing captures the pointer; while pressed, the thumb snaps segment by segment under the pointer and shrinks to 97% (`scale-97`), and the segment under it is chosen on release, so a drag sends one change. With reduce motion the thumb moves without a transition (`motion-reduce:transition-none`).
- The control is one Tab stop; the arrow keys move between segments and Space or Enter chooses ([layout behavior](#layout-behavior)). Inside a menu the items sit in `DropdownMenuList`, so opening the menu with the pointer focuses the list rather than the control, and the arrows keep moving through the menu.

### Switches and selects

| Part          | Look                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch        | A 28 × 16 px pill (24 × 14 px at `size="sm"`, inside menus) with a 12 px (10 px) thumb inset 2 px. On, the track is `--text-primary` and the thumb `--bg-surface`, neutral like the rest of the chrome; off, the track is `--input` with the card ring, so it reads as a recess, and the thumb `--background` in the light theme and `--foreground` in the dark one, with `--thumb-shadow` (a 2 px contact shadow and a hairline) so it sits on the track rather than in it |
| Switch motion | The thumb slides with `translate` over `--duration-base` and `--ease-out-quart`, and the track's color changes over `--duration-fast`; while pressed, the thumb stretches 3 px toward where it will go, as the platform's switches do. Reduce motion keeps the color change only                                                                                                                                                                                            |
| Select        | The trigger is an outline control at `--control-height`, 12.5 px text, with a 14 px chevron in `--muted-foreground`. Its list is a menu: it opens below the trigger, at least as wide as it and never over it, with the menu's surface, radius, padding, labels, separators and `rounded-lg` items, and a 14 px `Check` on the chosen item                                                                                                                                  |
| Quiet select  | `SelectTrigger` `variant="quiet"`, for Settings rows: no fill, ring or shadow at rest, the `--accent` fill under the pointer and while open, the value at the interface size. A page of rows then reads as settings, not as a form. An item can carry a muted hint after its name and be disabled ("Not installed")                                                                                                                                                         |

### Status pills

A state shown in a row, such as "Signed in", "Not found on PATH" or an agent's update, is a pill: `Badge` with a status variant, 20 px high, `rounded-full`, 12 px text at weight 500 and a 12 px icon in its leading slot.

| Variant   | Fill and text                               | Used for                                               |
| --------- | ------------------------------------------- | ------------------------------------------------------ |
| `success` | `--bg-subtle`, `--text-secondary`           | Found, signed in, updated                              |
| `info`    | `--bg-subtle`, `--text-secondary`           | Something on offer or under way: an update, an install |
| `warning` | `--bg-subtle`, `--text-secondary`           | Something to do: not signed in                         |
| `error`   | `--danger-tint`, `--danger`                 | A failure, with its retry                              |
| `neutral` | `--muted`, `--muted-foreground`, weight 400 | A plain value, such as the shell in use                |

- A pill can be the action itself, rendered as a `button` (`render`), and then keeps its states inside it: the offer, a `Spinner` with a small × that cancels, the failure with `RotateCw`, and the result. The row around it never changes its layout ([Settings › Agents](./ui.md#settings--agents)).
- A pill never shows a percentage it does not have: a task with no measured progress shows the `Spinner` and its words.
- `success`, `info` and `warning` keep their names, so a caller says what a pill means, but share one neutral look: only a failure is colored. The icon in the leading slot tells them apart.
- The notices that go with pills are `Alert`s with no shadow, so Settings keeps to no cards and no shadows: `info`, `success` and `warning` on `--bg-subtle` with the icon in `--icon-default`, and `error` on `--danger-tint` with a `--danger-border` hairline and the icon in `--danger`, the text `--text-primary` and the description `--text-secondary`; the line that ends a cut turn is this notice. The `destructive` variant, a card, stays for surfaces that have cards. A log or a command inside a notice sits on `--card` with no ring.

### Toggle buttons

An icon button that stays on, such as a side pane's toggle in the top bar, says so with `aria-pressed`, and the `quiet` button shows it sunk into its bar: a `--pressed` fill (`--bg-selected`), a hairline `--border` edge inside it, and the icon in `--foreground`; hover deepens the fill to `--pressed-hover`. The reference marks the same state with a blue tint. OverBench keeps to its neutral palette and makes the state plain through the fill and the edge, so it reads at a glance without a color of its own; an open menu's trigger keeps the lighter `--accent`.

### Menus and dialogs

Every menu, the dropdown menus and the context menus alike, shares one set of measurements, so the session's title menu, its row's context menu and the model menu read as one family.

| Part        | Look                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Menu        | Surface 3, `rounded-2xl`, 6 px padding, `shadow-menu` (a hairline ring and the `md` shadow). It is as wide as its widest item and at least 160 px, never a fixed width, so a short menu stays a small object. It opens with a fade and a zoom from 95% at its anchor in 100 ms, without a slide, and closes the same way |
| Item        | `text-ui` text, at least `--row-height`, 8 px horizontal padding, `rounded-lg`; highlighted, it takes `--accent`. With the menu's padding, a label starts 14 px from the menu's edge and a shortcut ends 14 px before it                                                                                                 |
| Icon        | None: labels and shortcuts line up on their own, as in the reference and in the platform's own menus, and icons only added weight. The exceptions are an agent mark at 14 px, which tells agents apart, and a file's type icon in the composer's `@` list, which tells files from folders                                |
| Check       | The checked item of a radio or checkbox group shows a 14 px `Check` on the right, centred on the first line, so a two-line item keeps it by its name                                                                                                                                                                     |
| Group label | 12 px, weight 500, `--muted-foreground`, with the items' 8 px inset, so it lines up with their text                                                                                                                                                                                                                      |
| Separator   | One hairline of `--border-soft`, inset 8 px on both sides so it lines up with the labels, never edge to edge                                                                                                                                                                                                             |
| Shortcut    | 12 px `--muted-foreground` with `tabular-nums`, on the right                                                                                                                                                                                                                                                             |
| Submenu     | A 14 px `ChevronRight` in `--muted-foreground`; the item stays filled while its submenu is open. The submenu opens beside the menu, 2 px clear of its edge, with its first item level with the item                                                                                                                      |
| Destructive | Text in `--destructive`, with a faint `--destructive-tint` fill only when highlighted; its shortcut stays muted. It comes last, after a separator                                                                                                                                                                        |
| Search      | A menu that filters its list is Base UI's `Combobox` (`components/ui/combobox.tsx`) on the same surface. Its search field spans the top, 36 px tall, unboxed and with no focus ring, its text at the items' inset, over a full-width hairline of `--border-soft`. It keeps its width while it filters                    |
| Two panes   | A menu that picks within a choice, as New session's [agent menu](./ui.md#agent-menu): a rail on the left, the shown row's items on the right, one search field over both. A `--border-soft` hairline divides them, each scrolls on its own, and the shown rail row takes the selected fill                               |

- The session menus, the title menu and the row's context menu, hold **New sub-session**, **Close**, a separator and **Delete…**.
- The two-pane menu was decided while the maintainer was away (2026-10-22); to be reviewed. Its rail fits its widest row.
- The file type icons in the `@` list came with the [attachments](#attachments) for #40, chosen with option A on 2026-10-23 on the comparison page, which shows them.
- **Dialogs** (`Dialog`, `AlertDialog`): surface 3, `rounded-3xl`, 20 px padding and 16 px between parts, at most 384 px wide, with the `lg` shadow. The title is 16 px at weight 500, the description 13 px with a relaxed line height in `--text-secondary`. The buttons sit right-aligned at the end, 8 px apart, at the `default` size; the footer has no band or rule of its own. A destructive action uses `Button`'s `destructive` variant.

### Attachments

The tiles a message's [attachments](./ui.md#attachments) show as, in the composer and in the thread; chosen for #40 on 2026-10-23, option A of three.

| Part         | Look                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row          | Inside the composer, 6 px from its edges and 6 px between tiles, above the text; `rounded-2xl` tiles, so their corners follow the composer's `rounded-4xl` at that gap (20.8 − 6 ≈ 14.4). In the thread, the same row above the bubble, aligned to its end, wrapping |
| Tile         | 112 px square, the reference's 7.5 rem tile at its scale (about 113 px), on the 4 px grid; a hairline `--border-default` ring and no fill, `--border-strong` under the pointer, the `--focus` ring                                                                   |
| Image tile   | The thumbnail, cropped to fill the square, with the ring drawn over it                                                                                                                                                                                               |
| File tile    | 10 px padding; the [type icon](#file-icons) at 16 px at the top; at the bottom the name at the caption step, weight 500, in `--text-primary`, cut in the middle so its extension stays, over the size or "Folder" at the meta step in `--text-tertiary`              |
| Pasted text  | Its first three lines in mono at the meta step, in `--text-secondary`, over "Pasted text" and its line count                                                                                                                                                         |
| Remove       | A 20 px round button on `--bg-surface` with a `--border-default` hairline, inset 4 px at the tile's top right, holding `X` at 12 px in `--icon-default`, `--text-primary` under the pointer; shown on hover and focus                                                |
| Badge        | A 20 px round badge on `--bg-surface` with a `--border-default` hairline, inset 4 px at an image tile's bottom left: `TriangleAlert` at 12 px for an image sent another way                                                                                          |
| Failed       | `CircleAlert` at 16 px in `--danger` in place of the type icon, and the words that name the error in `--danger` in place of the size                                                                                                                                 |
| Drop overlay | Over the thread column, `--bg-app` at 88%; a centred card on `--bg-surface` with a `--border-strong` hairline and `rounded-2xl`, 20 by 28 px padding, "Drop to attach" at the heading step over a caption line                                                       |
| Image dialog | A `Dialog` as wide as the image allows, at most 90% of the window by 85%; the image fitted over `--checker` squares with a `--border-default` hairline; its name, pixel size and file size under it at the meta step                                                 |

- Once the media [viewer](./ui.md#viewer) is built, an attached image opens there instead of in the image dialog, and a pasted text keeps the dialog (proposed with the [media design](./media.md); to be agreed).
- Thumbnails are 224 px on their long side, twice the tile, as WebP at 82%. At 192 px, for a 2880 × 1800 px screenshot of a test run, one took 41 to 87 ms in a worker and came to 2 kB (2026-10-22, the options page in Chromium on macOS); a photo comes out larger.

## Motion

### Tokens

| Duration             | Value  | Used for                                                     |
| -------------------- | ------ | ------------------------------------------------------------ |
| `--duration-instant` | 60 ms  | Focus, checkbox                                              |
| `--duration-fast`    | 120 ms | Hover, color changes, icon crossfades                        |
| `--duration-base`    | 200 ms | Disclosures, status text                                     |
| `--duration-slow`    | 300 ms | New thread entries, panels                                   |
| `--duration-slower`  | 450 ms | The one-time attention pulse, a search result's flash fading |

| Easing             | Curve                                    | Used for                                     |
| ------------------ | ---------------------------------------- | -------------------------------------------- |
| `--ease-out-quart` | `cubic-bezier(.165, .84, .44, 1)`        | The default for anything settling into place |
| `--ease-out-quint` | `cubic-bezier(.22, 1, .36, 1)`           | New thread entries                           |
| `--ease-out-expo`  | `cubic-bezier(.16, 1, .3, 1)`            | Hover on frequent controls, disclosures      |
| `ease-in-out`      | Tailwind's, `cubic-bezier(.4, 0, .2, 1)` | Looping indicators                           |

The reference uses nine curves, several of them nearly identical. OverBench keeps the ones M0 uses; the press and overshoot curves are left out because buttons and switches keep shadcn's own feedback.

| Spring (Motion) | Stiffness / damping / mass | Used for                             |
| --------------- | -------------------------- | ------------------------------------ |
| `card`          | 320 / 28 / 1               | Cards, drag release, the queue stack |
| `panel`         | 1200 / 80 / 0.1            | Panels and sheets                    |

Durations are custom properties: `duration-(--duration-fast)` times a transition, and `animation-duration-(--duration-fast)` times a tw-animate-css enter or exit animation. Never time an animation with `duration-*`: it also sets `transition-duration`, and with the default `transition-property: all` the element would then transition every property that changes, including inherited ones such as `scrollbar-color`, recalculating its whole subtree on each frame. Easings are `--ease-*` theme variables, which give `ease-*` utilities. Springs are exported from `src/renderer/src/lib/motion.ts`.

### CSS or Motion

| CSS                                                                   | Motion                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| Hover, press, focus, color, opacity and shadow changes                | Elements leaving the tree (`AnimatePresence`)        |
| Enter-only effects, through tw-animate-css (`animate-in`, `fade-in`)  | Springs, layout and shared-element animations        |
| Looping indicators: `Spinner`, `Skeleton`, `shimmer`, `animate-pulse` | Gestures: drag and anything that follows the pointer |
| Disclosures (`Collapsible`) and scroll-edge fades (`scroll-fade`)     |                                                      |

CSS cannot animate an element that is being removed, which is why exits go to Motion. The enter and exit transitions built into shadcn components stay as they are.

### Patterns

Each pattern names what provides it. OverBench writes its own keyframes only where nothing in the stack offers the effect: the one-time attention pulse and the sheen on the highest reasoning level.

| Pattern           | Provided by                                                                                                                                                                                                                                                 | Tuning                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Press             | shadcn `Button`'s built-in active state                                                                                                                                                                                                                     | None                                                                                               |
| Disclosure        | shadcn `Collapsible` (Base UI), animating `--collapsible-panel-height`                                                                                                                                                                                      | `--duration-base`, `--ease-out-expo`                                                               |
| New entry         | tw-animate-css: `animate-in fade-in slide-in-from-bottom-1`                                                                                                                                                                                                 | `--duration-slow`, `--ease-out-quint`; once per entry                                              |
| Status text       | tw-animate-css: `animate-in fade-in slide-in-from-bottom-1`                                                                                                                                                                                                 | `--duration-base`                                                                                  |
| Thinking, waiting | shadcn's `shimmer` utility on the status text                                                                                                                                                                                                               | None                                                                                               |
| Loading           | shadcn `Skeleton` and `Spinner`                                                                                                                                                                                                                             | None                                                                                               |
| Scroll-edge fades | shadcn's `scroll-fade` utilities (scroll-driven, no JavaScript); `MessageScrollerViewport` applies them itself. The thread's top edge uses `scroll-fade-top-overlay`, a gradient over the scroller, since a mask there repaints the thread while it streams | `--scroll-fade-size: 28px`                                                                         |
| Running           | The shared `Spinner` at 12 px in `--muted-foreground`, at the end of a sidebar row                                                                                                                                                                          | None                                                                                               |
| Copy feedback     | The copy button in Streamdown's code blocks                                                                                                                                                                                                                 | None                                                                                               |
| Staggered entry   | tw-animate-css: `animate-in fade-in slide-in-from-bottom-1 fill-mode-both`, with a growing `animation-delay`                                                                                                                                                | `--duration-slow`, `--ease-out-quint`; the first item after 60 ms, each next one 30 ms later, once |
| Attention         | Own keyframe: the attention halo grows to 6 px and settles at 3 px, once                                                                                                                                                                                    | `--duration-slower`; it does not loop, because the sidebar indicator keeps the signal              |
| Sidebar slide     | A CSS transition on the workbench panels' `flex-grow`, set only for a toggle; both panels' contents hold their final widths against the panel's right edge, so the thread lays out once and the sidebar slides                                              | `--duration-slow`, `--ease-out-quart`; at once under reduce motion and when resizing by drag       |
| Segmented thumb   | A CSS transition on `translate` and `scale`                                                                                                                                                                                                                 | `--duration-base`, `--ease-out-quart`                                                              |
| Viewer            | Motion: the item moves as a shared element from its place in the thread to its fitted place, while the scrim and the bar fade in; closing reverses it when the place is in view, else fades over `--duration-fast`. Stepping crossfades with a 24 px slide  | `--duration-slow`, `--ease-out-quart`; the scrim over `--duration-base`; reduce motion fades only  |
| Sheen             | Own keyframe: a band of `--sheen` crosses the max tier's thumb from left to right, once, each time it lands there                                                                                                                                           | `--duration-slower`, `--ease-out-quart`; not when the menu merely opens on that level              |

- The disclosure is the only layout animation allowed inside content: one at a time, never inside an entry that is streaming. The sidebar slide is the one between panels; it changes the panels' sizes only, never the content's width while it runs, and nothing on the content's subtree restyles when it starts or ends (no ancestor-attribute selectors, no `display` change).
- Entries restored from history or a snapshot appear without animation.

### Reduce motion

- Motion components follow the root `<MotionConfig reducedMotion="user">`: movement is removed and opacity remains.
- CSS follows one `prefers-reduced-motion: reduce` block in `globals.css`: movement and loops stop (slides, zooms and spins hold still, pulses and shimmer stop), opacity and color transitions remain, and disclosures open at once.
- A staggered entry becomes a plain fade.
- The segmented thumb moves at once, and the sheen does not play (`motion-safe`).

## Layout behavior

- Components adapt to their container with container queries (`@container`), not viewport media queries, because panels resize independently of the window.
- Scrollbars are the platform's, thinned with `scrollbar-width: thin` and tinted `--scrollbar-thumb` on a transparent track through `scrollbar-color`. On macOS they are overlay scrollbars unless the system setting shows them always. On Linux the main process switches on Chromium's `OverlayScrollbar` feature, because Chromium would otherwise draw classic scrollbars with arrow buttons there. On Windows that switch has no effect from the app's code, since the native theme reads it before the main script runs, and Chromium draws Fluent scrollbars with arrow buttons whenever `scrollbar-width` or `scrollbar-color` is set. So on Windows (`data-platform="win32"` on the root) both are reset to `auto` and the `::-webkit-scrollbar` pseudo-elements draw the scrollbar: a 4 px `--scrollbar-thumb` pill in a `--scrollbar-size` (10 px) gutter, inset by `--scrollbar-inset`, widening by 2 px under the pointer, with no track or buttons, and hidden while `MessageScroller` follows output. Lists that hide their scrollbar use `no-scrollbar`, which keeps working there. No layout depends on a scrollbar's width: scrollers that must not shift use `scrollbar-gutter: stable`.
- A list that acts as one control, such as the sidebar, a menu or a set of permission options, has one Tab stop and moves focus with the arrow keys (roving focus).
