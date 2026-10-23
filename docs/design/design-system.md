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
3. **Compact by default.** OverBench is a desktop tool for long sessions: 24 px controls and 28 px rows show more of the work without feeling cramped.
4. **Micro-interactions run on the compositor.** Hover, press, focus and looping indicators are CSS, so they cost no JavaScript per frame. Motion handles springs, layout, exits and gestures ([motion](#css-or-motion)).
5. **The stack first.** What shadcn/ui, Base UI, Tailwind or tw-animate-css already provides is used as it is, styled through the tokens; a custom implementation needs a reason written here.
6. **Every value is a token.** Colors, radii, sizes, durations and curves come from `globals.css`; components never hard-code them.

## Color

### Surfaces

Four surface steps, mapped onto the shadcn tokens so that shadcn components pick them up unchanged:

| Step | Used for                                   | Token          | Light              | Dark               |
| ---- | ------------------------------------------ | -------------- | ------------------ | ------------------ |
| 0    | Sidebar and the window around the thread   | `--sidebar`    | `oklch(0.982 0 0)` | `oklch(0.15 0 0)`  |
| 1    | Thread canvas                              | `--background` | `oklch(0.991 0 0)` | `oklch(0.196 0 0)` |
| 2    | Cards: tool calls, code blocks, diffs      | `--card`       | `oklch(1 0 0)`     | `oklch(0.217 0 0)` |
| 3    | Raised: composer, popovers, menus, dialogs | `--popover`    | `oklch(1 0 0)`     | `oklch(0.243 0 0)` |

- The lightness steps match the reference. Its surfaces carry a trace of warmth (chroma about 0.002); OverBench keeps shadcn's pure neutral.
- `BACKGROUND_COLOR` in `src/main/window.ts` follows `--background` in both themes, so the first frame does not flash.

### Lines

| Token             | Light                | Dark                 | Used for                                              |
| ----------------- | -------------------- | -------------------- | ----------------------------------------------------- |
| `--border`        | `oklch(0 0 0 / 16%)` | `oklch(1 0 0 / 14%)` | Container rings: cards, the composer, menus           |
| `--border-soft`   | `oklch(0 0 0 / 9%)`  | `oklch(1 0 0 / 8%)`  | Dividers inside a container, the ring of an icon tile |
| `--border-strong` | `oklch(0 0 0 / 28%)` | `oklch(1 0 0 / 24%)` | Outline buttons, hovered and focused containers       |

Lines are translucent, so one token reads the same on every surface step. The alphas are set for the 0.5 px hairline of a 2× display; on a 1× display, where the hairline is 1 px, they are halved, so a line keeps the same visual weight.

### Meaning

- `--primary` stays shadcn's neutral: near black in the light theme, near white in the dark one. OverBench has no brand accent, so color is left for meaning.
- `--attention` (amber, with `--attention-foreground`): permission requests and anything else waiting for the user, such as the dot at the end of a sidebar row, which carries a 1 px inset ring in `--attention-text` so its edge reaches 3:1 on the light sidebar. It is the loudest color in the app.
- `--success` (green): completed checks.
- **Tints** are a meaning color at a low alpha, the fill of a status pill or a notice, with the color's text step on top: `--success-tint` with `--success-text`; `--checked-tint` with `--checked-text` (`oklch(0.47 0.16 255)` light, `oklch(0.8 0.1 255)` dark) for information and an action on offer, such as an agent update; `--attention-tint` with `--attention-text`; `--destructive-tint` with `--destructive`. A pill that is a button deepens its tint on hover (`--checked-tint-hover`, `--destructive-tint-hover`). Light tints are 9 to 13% and dark ones 13 to 22%, so they read the same on surfaces 0 and 1.
- `--mark` (a soft yellow, `oklch(0.88 0.15 90 / 55%)` light and `oklch(0.8 0.14 85 / 32%)` dark): the text a search matched, and the brief flash on the row a search result jumps to. It is no state, so it never appears outside search.
- **Usage levels**: a bar of plan usage takes `--success` below 60% used, `--attention` from 60% and `--destructive` from 90% or once the limit is reached, and its percentage the matching text step, so how much is left reads before the number does. Progress that is not usage, such as a download, stays `--checked`.
- `--checked` (blue): a control that is on or chosen, today the switch's track. It is the blue macOS, Windows and GNOME tint their own controls with, so the state reads at a glance.
- `--destructive` is a brick red, `oklch(0.5 0.17 27)` light and `oklch(0.7 0.16 22)` dark, calmer than shadcn's saturated red. It marks errors, conflicts and deletion in text and icons and tints destructive buttons, so a loud red would shout from every one of them; the darker light value still reaches 5.9:1 on surface 0. `--ring` stays shadcn's.
- `--muted-foreground` in the light theme is `oklch(0.53 0 0)` instead of shadcn's 0.556, which reaches only 4.49:1 on surface 0, just under WCAG AA.
- `--sidebar-accent`, the fill of hovered and selected sidebar rows, is `oklch(0.945 0 0)` light and `oklch(0.25 0 0)` dark; shadcn's 0.97 barely shows on surface 0.
- `--muted` (the user bubble, inline code, a disabled send button) is `oklch(0.96 0 0)` light, so the bubble stays visible on surface 1. `--accent` (hovered rows on surface 1, the highlighted menu item, an open selector) is `oklch(0.962 0 0)` light and `oklch(0.27 0 0)` dark.
- `--input`, the track of an unchecked `Switch`, is `oklch(0.9 0 0)` light instead of shadcn's 0.922, so an unchecked switch still reads on a card, and `oklch(1 0 0 / 16%)` dark.

### Reasoning levels

The top reasoning levels cost the most time and tokens, so their names carry a warm gradient wherever they show: in the model menu and on the model button ([interface](./ui.md#composer)). It is the one gradient in the interface, and it marks a cost, so it still carries meaning. Which levels are on top is recognised by name ([interface](./ui.md#composer)).

| Token                        | Light                                                               | Dark                                                                   | Used for                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--effort-high-1`, `-2`      | `oklch(0.6 0.14 70)` → `oklch(0.56 0.18 40)`                        | `oklch(0.86 0.12 82)` → `oklch(0.78 0.15 52)`                          | The high tier's name (`text-effort-high`)                                                                 |
| `--effort-max-1`, `-2`, `-3` | `oklch(0.6 0.15 60)` → `oklch(0.56 0.2 18)` → `oklch(0.52 0.2 300)` | `oklch(0.86 0.12 78)` → `oklch(0.76 0.16 22)` → `oklch(0.75 0.15 305)` | The max tier's name (`text-effort-max`), the middle stop at 55%                                           |
| `--effort-max-ring`          | `oklch(0.6 0.18 30 / 32%)`                                          | `oklch(0.76 0.16 30 / 40%)`                                            | The 1 px ring of the max tier's thumb (`shadow-effort-max`), with a 3 px (4 px dark) glow of the same hue |
| `--sheen`                    | `oklch(0.72 0.17 35 / 26%)`                                         | `oklch(0.82 0.13 45 / 24%)`                                            | The light that sweeps once across the thumb when the max tier is chosen (`animate-sheen`)                 |

- The light stops sit near lightness 0.6, so a 12 px name keeps its contrast on the white thumb; the dark stops are lighter for the same reason.
- The gradient runs across the name itself (`background-clip: text`), so a short name such as "Max" still shows all of it.

### Repository state

Git and pull request states reuse the meaning colors and add one, `--merged`, because a merged pull request is neither a success nor waiting. The mapping follows GitHub's, which every developer already reads at a glance; each color always comes with its own Lucide icon.

| State                            | Icon                                  | Color                                                                 |
| -------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Open pull request                | `GitPullRequest`                      | `--success`                                                           |
| Draft                            | `GitPullRequestDraft`                 | `--muted-foreground`                                                  |
| Merged                           | `GitMerge`                            | `--merged`: `oklch(0.55 0.19 300)` light, `oklch(0.72 0.15 300)` dark |
| Closed                           | `GitPullRequestClosed`                | `--destructive`                                                       |
| Checks passing, failing, pending | `CircleCheck`, `CircleX`, `CircleDot` | `--success`, `--destructive`, `--attention`                           |
| Commits not pushed               | `ArrowUp` with the count              | `--foreground`; pushed and in sync is `--muted-foreground`            |
| Conflicts, a rebase in progress  | `TriangleAlert`                       | `--destructive` for conflicts, `--attention` for the operation        |

- Branch names and commit ids are monospace, at 12 px, with ids cut to 7 characters.
- Pull request chips are neutral: `--muted` fill with a `--border-soft` ring and `--foreground` text, so only the state icon carries color. Hover takes `--accent`.

### Terminal

The terminal sits in the side panel on surface 0, like the sidebar, so the thread on surface 1 stays the one canvas, framed by a quieter surface on each side. Its colors are tokens read by xterm.js:

| Token                   | Light                | Dark                 |
| ----------------------- | -------------------- | -------------------- |
| `--terminal-background` | `--sidebar`          | `--sidebar`          |
| `--terminal-foreground` | `--foreground`       | `--foreground`       |
| `--terminal-cursor`     | `--foreground`       | `--foreground`       |
| `--terminal-selection`  | `oklch(0 0 0 / 12%)` | `oklch(1 0 0 / 20%)` |

The 16 ANSI colors are VS Code's defaults for its light and dark themes (MIT), tuned there for contrast on light and dark backgrounds:

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

- Sizes: 14 px in sidebar and list rows and before the session title in the top bar, 17 px on a 32 px tile in cards (16 px on 30 px in the Welcome list). The tile is `--tile` (`oklch(0.965 0 0)` light, `oklch(0.27 0 0)` dark) with an inset `--border-soft` ring and an 8 px radius.
- An agent that is not installed shows its mark in one color, `--muted-foreground`.
- The marks ship as SVG files with their license notices; the gradient and the two OpenCode colors are tokens, so they follow the theme.

### File icons

Files and folders show their type's icon from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (`material-icon-theme`, MIT), the file icon theme most used in VS Code, resolved from its manifest the way VS Code resolves a file icon theme: the file name (with its parent folder, for names such as `.github/workflows`), then the extensions longest first, then the default; folders by name, open or closed. The light theme takes the manifest's light icons where it has them.

- The colors are the theme's own, unchanged: a reduced saturation was tried and read as dull ([problem 38](../milestones/m0-feedback.md#38-files-pane-no-markdown-preview-file-type-icons-or-editing)). Like the agent marks, they are colored by design, the only icons that are.
- Sizes: 16 px in the Files pane's rows and preview header, 12 px in a file chip in the thread.
- The manifest and the icons load on first use, in a chunk of their own; each icon is a file of its own, never inlined, so only those on screen are read. A plain line icon stands in until they load.

### Data graphics

The [usage page](./usage.md#interface) draws amounts. Its colors carry two meanings, kept apart so one chart never mixes them:

| Token                                  | Light                                                                | Dark                            | Used for                                                                |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| `--agent-claude-code`, `--agent-codex` | `--brand-claude`, `--brand-codex-2` (the middle of Codex's gradient) | the same                        | An agent's series: its bars in the trend and its key in the legend      |
| `--agent-opencode`                     | `oklch(0.6 0 0)`                                                     | `oklch(0.72 0 0)`               | OpenCode's series; its mark is black and white, so a mid grey stands in |
| `--agent-other`                        | `oklch(0.78 0 0)`                                                    | `oklch(0.45 0 0)`               | An agent without a mark                                                 |
| `--heat-0`                             | `oklch(0 0 0 / 5.5%)`                                                | `oklch(1 0 0 / 6.5%)`           | A day without usage in the activity heatmap                             |
| `--heat-1`, `--heat-2`, `--heat-3`     | `--checked` mixed at 26%, 48% and 74% with transparent               | the same, over the dark surface | The heatmap's quartiles of the days with usage, lowest first            |
| `--heat-4`                             | `--checked`                                                          | `--checked`                     | The top quartile                                                        |

- **Series** take the agents' own colors, like their [marks](#agent-marks), so a bar is recognized without the legend.
- **Amount** is one hue that deepens, never a rainbow: more reads as more without a key of colors. The tokens-by-type table keys its rows with the same steps, and output with `--foreground` at 80%.
- Bars have a 2 px top radius (`rounded-t-xs`) and a 1 px gap; heatmap cells are `rounded-xs` squares with a 2 px gap. Days outside the chosen range, and the hours still to come in a one-day trend, are dimmed to 35% opacity rather than recolored, and the hovered or focused cell takes a 1 px `--foreground` ring.

## Borders and elevation

### One line per surface

| Closed border                                                                        | No border                                                                           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Composer, tool call cards, code blocks, diffs, attachments, dialogs, menus, popovers | Agent text, the user bubble (a fill only), sidebar rows, buttons inside a container |

- Inside a bordered container, parts are separated by a hairline `Separator` or a surface step, never by a second border.
- The sidebar and the side panel, on surface 0, meet the thread's surface 1 at a `--border-soft` hairline, drawn by the resizable handle between them at rest, which turns `--border-strong` on hover and drag. The reference draws the same line, measured at about 6% black on a 2× display; the surface step alone, 1% apart, read as an edge that was missing. A collapsed sidebar takes its line with it.
- Borders are drawn as an inset ring (`box-shadow`, Tailwind's `ring-inset`). A ring takes no layout space, follows the radius exactly, and can change on hover without moving anything.
- `--hairline` is 1 px, 0.5 px on 2× displays and 1/3 px on 3× displays (`@media (resolution >= 2x)`), so lines are as fine as the display allows.

### Elevation

| Tier | Shadow                                         | Used for                             |
| ---- | ---------------------------------------------- | ------------------------------------ |
| none |                                                | Everything on the canvas at rest     |
| `sm` | A tight contact shadow and an 8 px ambient one | The composer at rest                 |
| `md` | Contact and a 24 px ambient shadow             | Popovers, menus and floating buttons |
| `lg` | Contact and a 28 px ambient shadow             | Dialogs                              |

- Dark-theme shadows are several times stronger (opacity 0.4 to 0.65), because a shadow on a dark surface barely shows. Raised surfaces in the dark theme also get a 1 px inset highlight along the top edge (`oklch(1 0 0 / 5%)`), which reads as an edge catching the light. In the light theme, outline buttons get a 1 px contact shadow instead.
- **Composer** (the `composer` variant of `InputGroup`): a hairline ring and `sm` at rest; a `--border-strong` ring on hover; on focus within, the strong ring both inside and outside plus a wide, soft shadow (20 px light, 24 px dark). Only color and shadow change, so focusing never moves the text.
- **Attention**: a card waiting for the user replaces its hairline with a 1 px `--attention` ring at 80% and a 3 px halo at 20% (75% and 16% in the dark theme).
- **Focus rings** are shadcn's `focus-visible` ring everywhere. The reference uses a thinner ring with a glow in its brand color; a glow in a neutral color looks smudged, so OverBench keeps shadcn's ring.

## Density and sizing

M0 ships the compact density only. The comfortable values are recorded so that a later density setting switches tokens, not components. Sizes in this document are CSS pixels at 100% [zoom](./ui.md#zoom), the level the window opens at.

| Token                 | Used for                                                           | Compact (M0)               | Comfortable (later)  |
| --------------------- | ------------------------------------------------------------------ | -------------------------- | -------------------- |
| `--radius`            | The base of shadcn's radius scale                                  | 7 px                       | 8 px                 |
| `--control-height`    | Buttons and selectors                                              | 26 px                      | 32 px                |
| `--control-height-sm` | Small inline buttons, icon buttons in the title bar                | 24 px                      | 28 px                |
| `--row-height`        | Sidebar rows, menu items, the plan bar, the composer's control row | 28 px                      | to be measured       |
| `--card-header`       | Card headers, such as a permission request's                       | 30 px                      | 36 px                |
| `--composer-min`      | The composer with one line of text                                 | 52 px                      | 56 px                |
| `--icon-size`         | UI icons; 14 px inside cards and controls                          | 16 px                      | 20 px                |
| Icon stroke           | Every Lucide icon, set once with `LucideProvider` in `main.tsx`    | 1 px at every size         | 1 px at every size   |
| Spacing steps         | Gaps between and around components                                 | 4, 6, 8, 10, 12, 16, 28 px | 8, 12, 16, 28, 40 px |

- The icon stroke is 1 screen pixel whatever the icon's size: `LucideProvider` sets `strokeWidth={1}` with `nonScalingStroke`, which draws the stroke with `vector-effect: non-scaling-stroke`. Lucide's own `absoluteStrokeWidth` scales the width by the `size` prop, which OverBench never passes because sizes come from classes, so it would draw a 16 px icon at 0.67 px. Chosen 2026-10-22 on the Settings canvas from 0.65, 0.8 and 1 px side by side, replacing the relative 1.5, which drew 14 and 12 px icons thinner than 16 px ones ([problem 37](../milestones/m0-feedback.md#37-icons-look-heavy-use-thin-line-icons-from-a-library)).

The radius scale is shadcn's, derived from `--radius`, so shadcn components follow it without new tokens:

| Utility        | Compact | Used for                                 |
| -------------- | ------- | ---------------------------------------- |
| `rounded-md`   | 5.6 px  | Segments and their thumb                 |
| `rounded-lg`   | 7 px    | Buttons, inputs, rows, menu items        |
| `rounded-xl`   | 9.8 px  | Cards, the user bubble                   |
| `rounded-2xl`  | 12.6 px | The composer, menus and popovers         |
| `rounded-3xl`  | 15.4 px | Dialogs                                  |
| `rounded-full` |         | The send button, counts and status pills |

- Where OverBench's look differs from a shadcn component's default, the difference is a variant added to that component with `cva`, such as `InputGroup` `variant="composer"`, `Card` `variant="tool"` and a `Button` `size="compact"` bound to `--control-height`. Call sites never restyle a component with `className`; they use it for layout only.
- The compact spacing steps are Tailwind's `1`, `1.5`, `2`, `2.5`, `3`, `4` and `7`.
- Menu items are `rounded-lg` because they sit 6 px inside a `rounded-2xl` menu: 12.6 − 6 ≈ 6.6, so the item's corner follows the menu's. Segments sit inside their track the same way.
- shadcn's `xs` button (24 px) is the small size; `default` (32 px) is kept for dialogs, empty states and the Welcome screen, where a larger target helps. When the comfortable density arrives, these sizes are bound to the comfortable tokens.

## Typography

### Typefaces

| Text                                   | Typeface                                                                                                   | Source                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Latin letters, digits and punctuation  | Inter Variable, with its optical-size axis                                                                 | Bundled: `@fontsource-variable/inter`, 73 KB for the Latin file             |
| Chinese                                | The platform's interface face: PingFang SC on macOS, Microsoft YaHei on Windows, Noto Sans CJK SC on Linux | The system; a Chinese face runs to several megabytes, so none is bundled    |
| Code, commands and other text set mono | JetBrains Mono Variable, the same on every platform                                                        | Bundled: `@fontsource-variable/jetbrains-mono` (OFL-1.1), chosen 2026-10-22 |

- Inter comes first in the stack (`--font-sans`), so in a Chinese sentence the Latin words, digits and punctuation are Inter and only the Chinese characters fall through to the platform face. `system-ui` ends the stack.
- Inter is the nearest open typeface to the reference's own sans at interface sizes: the same tall x-height, width and rhythm, where Geist read a size smaller and a shade lighter (chosen 2026-10-21 from a six-way render in the real build).
- With `font-optical-sizing: auto`, Inter takes its text design at interface sizes and its display design at title sizes by itself; no second family is loaded for headings.
- JetBrains Mono was chosen on 2026-10-22 over the platform's own monospace, Geist Mono and IBM Plex Mono, from a side-by-side render of code, diffs, branch names and look-alike characters in both themes. It keeps code, diffs and the terminal identical on macOS, Windows and Linux, where the platform faces differ in width and weight, and its tall x-height sits well beside Inter from 11.5 to 13 px. It is a renderer-only dependency, so it goes in `devDependencies`; only its Latin weight file is loaded, and it is added when the code is aligned with this scale.
- `--font-mono` is JetBrains Mono Variable, then `ui-monospace`, SF Mono, Cascadia Code, Menlo and Consolas as fallbacks; Chinese in mono text falls through to the platform's Chinese face. The terminal and the Files editor read `--font-mono`, so they follow it. xterm.js measures its cells when a terminal opens, so the face is loaded (`document.fonts.load`) before the first terminal opens, or the cells take the fallback's width.
- No other typeface: no serif, no display face, no icon font.

### Type scale

Every size in the interface is one of these steps. Line heights sit on a 4 px grid, except prose and the small step, whose ratios come from the [prose](#prose) spec.

| Step      | Utility        | Size    | Line height | Weight | Tracking | Family |
| --------- | -------------- | ------- | ----------- | ------ | -------- | ------ |
| Display   | `text-display` | 28 px   | 36 px       | 600    | −2%      | Sans   |
| Title     | `text-title`   | 22 px   | 28 px       | 600    | −1.5%    | Sans   |
| Heading   | `text-heading` | 16 px   | 24 px       | 500    | 0        | Sans   |
| Prose     | `text-prose`   | 15 px   | 1.7         | 400    | 0        | Sans   |
| Interface | `text-ui`      | 14 px   | 20 px       | 400    | 0        | Sans   |
| Small     | `text-small`   | 13 px   | 1.6         | 400    | 0        | Sans   |
| Control   | `text-control` | 12.5 px | 16 px       | 500    | 0        | Sans   |
| Caption   | `text-xs`      | 12 px   | 16 px       | 400    | 0        | Sans   |
| Code      | `text-code`    | 12 px   | 18 px       | 400    | 0        | Mono   |
| Meta      | `text-meta`    | 11.5 px | 16 px       | 400    | 0        | Mono   |

- `--prose-size` is 15 px; **Text size** sets 14, 15 or 16 px. Prose keeps 1.7 instead of the reference's 1.43 because CJK text needs the extra leading.
- `--ui-size` is the reference's interface size, 14 px. The root stays 16 px, so Tailwind's rem scale is unchanged.
- Tracking is negative only on the two steps that use Inter's display design, and never positive: there are no uppercase or letter-spaced labels.
- 11.5 px is the smallest text in the interface. A count in a pill, a badge or a chart label takes the meta step, never less.
- `text-title`, `text-heading`, `text-prose`, `text-ui`, `text-small`, `text-control`, `text-xs`, `text-code` and `text-meta` are in `globals.css`, each with its line height and tracking; `text-display` is added with its first use.

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

- **Column**: 42em (630 px), about 42 Chinese characters a line, at a 1.7 line height. Text in `--foreground` at 90% opacity; bold and headings at full `--foreground`, so the step in lightness carries the hierarchy. Paragraphs `text-wrap: pretty`, long paths and URLs `overflow-wrap: anywhere`, no letter spacing for Chinese.
- **Headings**: more space above than below, so each sits on its content. h1 20 px with `1.8em 0 0.4em`, h2 17 px with `1.75em 0 0.4em`, h3 15 px with `1.5em 0 0.3em`, h4 and below 15 px in `--muted-foreground`; all at the semibold weight, `text-wrap: balance`, none above the first block.
- **Paragraphs and emphasis**: `margin: 0 0 0.75em`; bold at the semibold weight, never 700; emphasis italic, except in Chinese text, where it is the medium weight upright (`data-cjk-emphasis`, set when the emphasis holds a Han character).
- **Lists**: `padding-left: 1.25em`, items 0.3em apart, markers in `--muted-foreground`, ordered numbers `tabular-nums`, nested lists 0.25em above and below, and no margin on a paragraph inside an item, so loose lists keep the spacing of tight ones.
- **Inline code**: mono at 0.85em on `--muted`, `padding: 0.1em 0.35em`, radius 4 px, no border and no colored text.
- **Code blocks**: `--muted` at 60%, a 1 px `--border`, radius 8 px, 13 px at 1.6, padding 0 14px 12px under a 32 px header with the language at 12 px in `--muted-foreground` and the copy button as a ghost button; a block scrolls sideways and never wraps; 1em above and below.
- **Links**: `--foreground` with an underline in `--muted-foreground` at 40%, 3 px below the text, turning `--foreground` on hover.
- **File chips**: `inline-flex`, 20 px high, `vertical-align: 1px`; the file icon and 3 px; 6 px of padding each side, radius 5 px; mono 11.5 px in `--muted-foreground` on `--muted`, no wrapping; 4 px from what comes before; `--accent` and `--foreground` on hover.
- **Blockquotes**: a 2 px `--border` rule on the left, 12 px in, `--muted-foreground`, no fill. **Tables**: no frame, in a wrapper that scrolls sideways; 14 px with `tabular-nums`; header cells at the medium weight in `--muted-foreground` over a `--border` line; cells `8px 12px` over a `--border` line at 60%, none under the last row. **Rules**: 1 px `--border`, 1.5em above and below.
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

| Part          | Look                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch        | A 28 × 16 px pill (24 × 14 px at `size="sm"`, inside menus) with a 12 px (10 px) thumb inset 2 px. On, the track is `--checked`; off, `--input` with the card ring, so it reads as a recess. The thumb is `--background` in the light theme and `--foreground` in the dark one, with `--thumb-shadow` (a 2 px contact shadow and a hairline) so it sits on the track rather than in it |
| Switch motion | The thumb slides with `translate` over `--duration-base` and `--ease-out-quart`, and the track's color changes over `--duration-fast`; while pressed, the thumb stretches 3 px toward where it will go, as the platform's switches do. Reduce motion keeps the color change only                                                                                                       |
| Select        | The trigger is an outline control at `--control-height`, 12.5 px text, with a 14 px chevron in `--muted-foreground`. Its list is a menu: it opens below the trigger, at least as wide as it and never over it, with the menu's surface, radius, padding, labels, separators and `rounded-lg` items, and a 14 px `Check` on the chosen item                                             |
| Quiet select  | `SelectTrigger` `variant="quiet"`, for Settings rows: no fill, ring or shadow at rest, the `--accent` fill under the pointer and while open, the value at the interface size. A page of rows then reads as settings, not as a form. An item can carry a muted hint after its name and be disabled ("Not installed")                                                                    |

### Status pills

A state shown in a row, such as "Signed in", "Not found on PATH" or an agent's update, is a pill: `Badge` with a status variant, 20 px high, `rounded-full`, 12 px text at weight 500 and a 12 px icon in its leading slot.

| Variant   | Fill and text                               | Used for                                               |
| --------- | ------------------------------------------- | ------------------------------------------------------ |
| `success` | `--success-tint`, `--success-text`          | Found, signed in, updated                              |
| `info`    | `--checked-tint`, `--checked-text`          | Something on offer or under way: an update, an install |
| `warning` | `--attention-tint`, `--attention-text`      | Something to do: not signed in                         |
| `error`   | `--destructive-tint`, `--destructive`       | A failure, with its retry                              |
| `neutral` | `--muted`, `--muted-foreground`, weight 400 | A plain value, such as the shell in use                |

- A pill can be the action itself, rendered as a `button` (`render`), and then keeps its states inside it: the offer, a `Spinner` with a small × that cancels, the failure with `RotateCw`, and the result. The row around it never changes its layout ([Settings › Agents](./ui.md#settings--agents)).
- A pill never shows a percentage it does not have: a task with no measured progress shows the `Spinner` and its words.
- The notices that go with pills are `Alert`s with the same tints and no ring, so Settings keeps to no cards and no shadows: `info` (`--checked-tint`), `success` (`--success-tint`), `warning` (`--attention-tint`) and `error` (`--destructive-tint`). The `destructive` variant, a card, stays for surfaces that have cards. A log or a command inside a notice sits on `--card` with no ring.

### Toggle buttons

An icon button that stays on, such as a side pane's toggle in the top bar, says so with `aria-pressed`, and the `quiet` button shows it sunk into its bar: a `--pressed` fill (black 8% in light, white 10% in dark), a hairline `--border` edge inside it, and the icon in `--foreground`; hover deepens the fill to `--pressed-hover`. The reference marks the same state with a blue tint. OverBench keeps to its neutral palette and makes the state plain through the fill and the edge, so it reads at a glance without a color of its own; an open menu's trigger keeps the lighter `--accent`.

### Menus and dialogs

Every menu, the dropdown menus and the context menus alike, shares one set of measurements, so the session's title menu, its row's context menu and the model menu read as one family.

| Part        | Look                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Menu        | Surface 3, `rounded-2xl`, 6 px padding, `shadow-menu` (a hairline ring and the `md` shadow). It is as wide as its widest item and at least 160 px, never a fixed width, so a short menu stays a small object. It opens with a fade and a zoom from 95% at its anchor in 100 ms, without a slide, and closes the same way |
| Item        | `text-ui` text, at least `--row-height`, 8 px horizontal padding, `rounded-lg`; highlighted, it takes `--accent`. With the menu's padding, a label starts 14 px from the menu's edge and a shortcut ends 14 px before it                                                                                                 |
| Icon        | None: labels and shortcuts line up on their own, as in the reference and in the platform's own menus, and icons only added weight. The one exception is an agent mark at 14 px, which tells agents apart                                                                                                                 |
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
- **Dialogs** (`Dialog`, `AlertDialog`): surface 3, `rounded-3xl`, 20 px padding and 16 px between parts, at most 384 px wide, with the `lg` shadow. The title is 16 px at weight 500, the description 13 px with a relaxed line height in `--muted-foreground`. The buttons sit right-aligned at the end, 8 px apart, at the `default` size; the footer has no band or rule of its own. A destructive action uses `Button`'s `destructive` variant.

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

| Spring (Motion) | Stiffness / damping / mass | Used for            |
| --------------- | -------------------------- | ------------------- |
| `card`          | 320 / 28 / 1               | Cards, drag release |
| `panel`         | 1200 / 80 / 0.1            | Panels and sheets   |

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
- Scrollbars are the platform's, thinned with `scrollbar-width: thin` and tinted `--border-strong` through `scrollbar-color`. On macOS they are overlay scrollbars unless the system setting shows them always. On Linux the main process switches on Chromium's `OverlayScrollbar` feature, because Chromium would otherwise draw classic scrollbars with arrow buttons there. On Windows that switch has no effect from the app's code, since the native theme reads it before the main script runs, and Chromium draws Fluent scrollbars with arrow buttons whenever `scrollbar-width` or `scrollbar-color` is set. So on Windows (`data-platform="win32"` on the root) both are reset to `auto` and the `::-webkit-scrollbar` pseudo-elements draw the scrollbar: a 4 px `--border-strong` pill in a `--scrollbar-size` (10 px) gutter, inset by `--scrollbar-inset`, widening by 2 px under the pointer, with no track or buttons, and hidden while `MessageScroller` follows output. Lists that hide their scrollbar use `no-scrollbar`, which keeps working there. No layout depends on a scrollbar's width: scrollers that must not shift use `scrollbar-gutter: stable`.
- A list that acts as one control, such as the sidebar, a menu or a set of permission options, has one Tab stop and moves focus with the arrow keys (roving focus).
