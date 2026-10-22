# Design system

> Status: Draft · Applied by the [interface design](./ui.md) · Tokens live in `src/renderer/src/styles/globals.css` · Built in [M0.3](../milestones/m0.md#work-packages)

The visual language every screen is built from: surfaces, lines, density, type and motion. Components take every color, radius, size and timing from the tokens below. A value that is not here does not belong in a component; if one is missing, add it here first.

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
- `--attention` (amber, with `--attention-foreground`): permission requests and anything else waiting for the user. It is the loudest color in the app.
- `--success` (green): completed checks.
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

## Borders and elevation

### One line per surface

| Closed border                                                                        | No border                                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Composer, tool call cards, code blocks, diffs, attachments, dialogs, menus, popovers | Agent text, the user bubble (a fill only), sidebar rows, buttons inside a container, the sidebar edge |

- Inside a bordered container, parts are separated by a hairline `Separator` or a surface step, never by a second border.
- Borders are drawn as an inset ring (`box-shadow`, Tailwind's `ring-inset`). A ring takes no layout space, follows the radius exactly, and can change on hover without moving anything.
- `--hairline` is 1 px, 0.5 px on 2× displays and 1/3 px on 3× displays (`@media (resolution >= 2x)`), so lines are as fine as the display allows.

### Elevation

| Tier | Shadow                                         | Used for                             |
| ---- | ---------------------------------------------- | ------------------------------------ |
| none |                                                | Everything on the canvas at rest     |
| `sm` | A tight contact shadow and an 8 px ambient one | The composer at rest, hovered cards  |
| `md` | Contact and a 24 px ambient shadow             | Popovers, menus and floating buttons |
| `lg` | Contact and a 28 px ambient shadow             | Dialogs                              |

- Dark-theme shadows are several times stronger (opacity 0.4 to 0.65), because a shadow on a dark surface barely shows. Raised surfaces in the dark theme also get a 1 px inset highlight along the top edge (`oklch(1 0 0 / 5%)`), which reads as an edge catching the light. In the light theme, outline buttons get a 1 px contact shadow instead.
- **Composer** (the `composer` variant of `InputGroup`): a hairline ring and `sm` at rest; a `--border-strong` ring on hover; on focus within, the strong ring both inside and outside plus a wide, soft shadow (20 px light, 24 px dark). Only color and shadow change, so focusing never moves the text.
- **Hovered cards** (the agent cards on Project home): the card rises 1 px, its ring turns `--border-strong`, it takes `sm`, and a soft light rises from its bottom edge, as the reference's starter cards do. The light is a radial gradient of `--card-glow` (`oklch(0 0 0 / 3%)` light, `oklch(1 0 0 / 5%)` dark) on a pseudo-element that fades in, because a gradient cannot be transitioned.
- **Attention**: a card waiting for the user replaces its hairline with a 1 px `--attention` ring at 80% and a 3 px halo at 20% (75% and 16% in the dark theme).
- **Focus rings** are shadcn's `focus-visible` ring everywhere. The reference uses a thinner ring with a glow in its brand color; a glow in a neutral color looks smudged, so OverBench keeps shadcn's ring.

## Density and sizing

M0 ships the compact density only. The comfortable values are recorded so that a later density setting switches tokens, not components.

| Token                 | Used for                                                           | Compact (M0)               | Comfortable (later)  |
| --------------------- | ------------------------------------------------------------------ | -------------------------- | -------------------- |
| `--radius`            | The base of shadcn's radius scale                                  | 7 px                       | 8 px                 |
| `--control-height`    | Buttons and selectors                                              | 26 px                      | 32 px                |
| `--control-height-sm` | Small inline buttons, icon buttons in the title bar                | 24 px                      | 28 px                |
| `--row-height`        | Sidebar rows, menu items, the plan bar, the composer's control row | 28 px                      | to be measured       |
| `--card-header`       | Card headers, such as a permission request's                       | 30 px                      | 36 px                |
| `--composer-min`      | The composer with one line of text                                 | 52 px                      | 56 px                |
| `--icon-size`         | UI icons; 14 px inside cards and controls                          | 16 px                      | 20 px                |
| Icon stroke           | Every Lucide icon, set once with `LucideProvider` in `main.tsx`    | 1.5                        | 1.5                  |
| Spacing steps         | Gaps between and around components                                 | 4, 6, 8, 10, 12, 16, 28 px | 8, 12, 16, 28, 40 px |

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

- **Families**: Inter Variable for the interface and prose, loaded with its optical-size axis so interface sizes get Inter's text design, falling back to PingFang SC, Microsoft YaHei and Noto Sans CJK SC for Chinese, then `system-ui`. Inter is the nearest open typeface to the reference's own sans at interface sizes: the same tall x-height, width and rhythm, where Geist read a size smaller and a shade lighter. Mono: `ui-monospace`, SF Mono, Cascadia Code, JetBrains Mono, Menlo, Consolas.
- **Sizes**: 22 px (weight 600, tracking −1.5%) for page titles, 15 px with a 1.75 line height for thread prose (`--prose-size`; **Text size** sets 14, 15 or 16 px), 14 px for the sidebar, menus and controls (`--ui-size`, the `text-ui` utility; the reference's interface size), 12 px for code, diffs and secondary labels, 11.5 px mono for versions, times and diff stats. Prose keeps 1.75 instead of the reference's 1.43 because CJK text needs the extra leading.
- **Weights**: 400 for text, 500 for labels and titles, 600 for markdown headings. In the dark theme every weight drops by 40 on Inter's weight axis (400 becomes 360, 500 becomes 460, 600 becomes 560), as in the reference, because light text on a dark surface looks heavier than it is.
- Numbers that change in place, such as timers, token counts, diff stats and counters, use `tabular-nums` so they do not jitter.
- Headings use `text-wrap: balance` and prose `text-wrap: pretty`. Paths, URLs and long identifiers use `overflow-wrap: anywhere`, so they never push a card wider than the column.
- Icons inline with text sit at `vertical-align: -0.125em`, which centres them on the text.

### Prose

The message body, from the typography spec of [problem 43](../milestones/m0-feedback.md#43-the-message-body-needs-a-typography-pass-to-a-given-spec), all under the `.markdown` class in `globals.css`. Sizes are in em of the prose size, so **Text size** scales them; the pixel values below are those of the default 15 px. Colors come only from the existing tokens, so the dark theme follows without values of its own.

- **Column**: 42em (630 px), about 42 Chinese characters a line. Text in `--foreground` at 90% opacity; bold and headings at full `--foreground`, so the step in lightness carries the hierarchy. Paragraphs `text-wrap: pretty`, long paths and URLs `overflow-wrap: anywhere`, no letter spacing for Chinese.
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

- The session menus, the title menu and the row's context menu, hold **New sub-session**, **Close**, a separator and **Delete…**.
- **Dialogs** (`Dialog`, `AlertDialog`): surface 3, `rounded-3xl`, 20 px padding and 16 px between parts, at most 384 px wide, with the `lg` shadow. The title is 16 px at weight 500, the description 13 px with a relaxed line height in `--muted-foreground`. The buttons sit right-aligned at the end, 8 px apart, at the `default` size; the footer has no band or rule of its own. A destructive action uses `Button`'s `destructive` variant.

## Motion

### Tokens

| Duration             | Value  | Used for                              |
| -------------------- | ------ | ------------------------------------- |
| `--duration-instant` | 60 ms  | Focus, checkbox                       |
| `--duration-fast`    | 120 ms | Hover, color changes, icon crossfades |
| `--duration-base`    | 200 ms | Disclosures, status text              |
| `--duration-slow`    | 300 ms | New thread entries, panels            |
| `--duration-slower`  | 450 ms | The one-time attention pulse          |

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
| Running           | Tailwind's `animate-pulse` on the sidebar's running dot                                                                                                                                                                                                     | None                                                                                               |
| Copy feedback     | The copy button in Streamdown's code blocks                                                                                                                                                                                                                 | None                                                                                               |
| Staggered entry   | tw-animate-css: `animate-in fade-in slide-in-from-bottom-1 fill-mode-both`, with a growing `animation-delay`                                                                                                                                                | `--duration-slow`, `--ease-out-quint`; the first item after 60 ms, each next one 30 ms later, once |
| Card hover        | CSS transitions on `transform`, the ring, the shadow and the opacity of the `--card-glow` layer                                                                                                                                                             | `--duration-fast`, `--ease-out-expo`                                                               |
| Attention         | Own keyframe: the attention halo grows to 6 px and settles at 3 px, once                                                                                                                                                                                    | `--duration-slower`; it does not loop, because the sidebar indicator keeps the signal              |
| Sidebar slide     | A CSS transition on the workbench panels' `flex-grow`, set only for a toggle; both panels' contents hold their final widths against the panel's right edge, so the thread lays out once and the sidebar slides                                              | `--duration-slow`, `--ease-out-quart`; at once under reduce motion and when resizing by drag       |
| Segmented thumb   | A CSS transition on `translate` and `scale`                                                                                                                                                                                                                 | `--duration-base`, `--ease-out-quart`                                                              |
| Sheen             | Own keyframe: a band of `--sheen` crosses the max tier's thumb from left to right, once, each time it lands there                                                                                                                                           | `--duration-slower`, `--ease-out-quart`; not when the menu merely opens on that level              |

- The disclosure is the only layout animation allowed inside content: one at a time, never inside an entry that is streaming. The sidebar slide is the one between panels; it changes the panels' sizes only, never the content's width while it runs, and nothing on the content's subtree restyles when it starts or ends (no ancestor-attribute selectors, no `display` change).
- Entries restored from history or a snapshot appear without animation.

### Reduce motion

- Motion components follow the root `<MotionConfig reducedMotion="user">`: movement is removed and opacity remains.
- CSS follows one `prefers-reduced-motion: reduce` block in `globals.css`: movement and loops stop (slides, zooms and spins hold still, pulses and shimmer stop), opacity and color transitions remain, and disclosures open at once.
- A staggered entry becomes a plain fade, and a hovered card keeps its glow and shadow but does not rise.
- The segmented thumb moves at once, and the sheen does not play (`motion-safe`).

## Layout behavior

- Components adapt to their container with container queries (`@container`), not viewport media queries, because panels resize independently of the window.
- Scrollbars are the platform's, thinned with `scrollbar-width: thin` and tinted `--border-strong` through `scrollbar-color`. On macOS they are overlay scrollbars unless the system setting shows them always. On Linux the main process switches on Chromium's `OverlayScrollbar` feature, because Chromium would otherwise draw classic scrollbars with arrow buttons there. On Windows that switch has no effect from the app's code, since the native theme reads it before the main script runs, and Chromium draws Fluent scrollbars with arrow buttons whenever `scrollbar-width` or `scrollbar-color` is set. So on Windows (`data-platform="win32"` on the root) both are reset to `auto` and the `::-webkit-scrollbar` pseudo-elements draw the scrollbar: a 4 px `--border-strong` pill in a `--scrollbar-size` (10 px) gutter, inset by `--scrollbar-inset`, widening by 2 px under the pointer, with no track or buttons, and hidden while `MessageScroller` follows output. Lists that hide their scrollbar use `no-scrollbar`, which keeps working there. No layout depends on a scrollbar's width: scrollers that must not shift use `scrollbar-gutter: stable`.
- A list that acts as one control, such as the sidebar, a menu or a set of permission options, has one Tab stop and moves focus with the arrow keys (roving focus).
