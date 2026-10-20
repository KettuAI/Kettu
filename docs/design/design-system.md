# Design system

> Status: Draft · Applied by the [interface design](./ui.md) · Tokens live in `src/renderer/src/styles/globals.css` · Built in [M0.3](../milestones/m0.md#work-packages)

The visual language every screen is built from: surfaces, lines, density, type and motion. Components take every color, radius, size and timing from the tokens below. A value that is not here does not belong in a component; if one is missing, add it here first.

## Design reference

The first desktop version benchmarks the Claude Desktop app, through the analysis in [open-claude-ui](https://github.com/Caho1/open-claude-ui) (MIT). Among desktop clients for coding agents it has the most polished interface, and the analysis records the measurements behind it: surface steps, densities, radii, curves and timings, and how the composer, the thread and tool approvals behave.

- **Taken**: the principles in this document and the measured values behind them, expressed as OverBench tokens on top of shadcn/ui.
- **Not taken**:
  - Brand identity: logos, the clay accent color, illustrations, sounds, product names and the proprietary typefaces. OverBench keeps a neutral palette, its own semantic colors and Geist.
  - Code: the reference reconstructs a proprietary app's bundles, so its code examples are a specification to read, never source to copy. Every behavior is implemented with OverBench's own stack.
  - Names: no `cds-` or `claude-` prefixes. Tokens follow shadcn and Tailwind naming.
- **Changed on purpose**: where OverBench deviates, the section says so and why.

## Principles

1. **Quiet chrome, loud content.** Surfaces are told apart by small lightness steps, not by lines. The agent's work is the highest-contrast thing on screen.
2. **One line per surface.** A surface has at most one enclosing border ([below](#one-line-per-surface)).
3. **Compact by default.** OverBench is a desktop tool for long sessions: 24 px controls and 28 px rows show more of the work without feeling cramped.
4. **Micro-interactions run on the compositor.** Hover, press, focus and looping indicators are CSS, so they cost no JavaScript per frame. Motion handles springs, layout, exits and gestures ([motion](#css-or-motion)).
5. **Every value is a token.** Colors, radii, sizes, durations and curves come from `globals.css`; components never hard-code them.

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

| Token             | Light                | Dark                 | Used for                                             |
| ----------------- | -------------------- | -------------------- | ---------------------------------------------------- |
| `--border`        | `oklch(0 0 0 / 10%)` | `oklch(1 0 0 / 9%)`  | Hairline rings and dividers                          |
| `--border-strong` | `oklch(0 0 0 / 20%)` | `oklch(1 0 0 / 18%)` | Hovered and focused containers, such as the composer |

Lines are translucent, so one token reads the same on every surface step.

### Meaning

- `--primary` stays shadcn's neutral: near black in the light theme, near white in the dark one. OverBench has no brand accent, so color is left for meaning.
- `--attention` (amber, with `--attention-foreground`): permission requests and anything else waiting for the user. It is the loudest color in the app.
- `--success` (green): completed checks.
- `--destructive` and `--ring`: shadcn's.
- Agent icons come from the ACP Registry and are the only brand color in the interface.

## Borders and elevation

### One line per surface

| Closed border                                                                        | No border                                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Composer, tool call cards, code blocks, diffs, attachments, dialogs, menus, popovers | Agent text, the user bubble (a fill only), sidebar rows, buttons inside a container, the sidebar edge |

- Inside a bordered container, parts are separated by a hairline `Separator` or a surface step, never by a second border.
- Borders are drawn as an inset ring (`box-shadow`, Tailwind's `ring-inset`). A ring takes no layout space, follows the radius exactly, and can change on hover without moving anything.
- `--hairline` is 1 px, 0.5 px on 2× displays and 1/3 px on 3× displays (`@media (resolution >= 2x)`), so lines are as fine as the display allows.

### Elevation

| Tier | Shadow                                         | Used for                            |
| ---- | ---------------------------------------------- | ----------------------------------- |
| none |                                                | Everything on the canvas at rest    |
| `sm` | A tight contact shadow and an 8 px ambient one | The composer at rest, hovered cards |
| `md` | Contact and a 16 px ambient shadow             | Popovers and menus                  |
| `lg` | Contact and a 28 px ambient shadow             | Dialogs                             |

- Dark-theme shadows are several times stronger (opacity 0.4 to 0.5), because a shadow on a dark surface barely shows. Raised surfaces in the dark theme also get a 1 px inset highlight along the top edge, which reads as an edge catching the light.
- **Composer**: a hairline ring and `sm` at rest; a `--border-strong` ring on hover; on focus within, the strong ring both inside and outside plus a wide, soft 24 px shadow. Only color and shadow change, so focusing never moves the text.
- **Focus rings** are shadcn's `focus-visible` ring everywhere. The reference uses a thinner ring with a glow in its brand color; a glow in a neutral color looks smudged, so OverBench keeps shadcn's ring.

## Density and sizing

M0 ships the compact density only. The comfortable values are recorded so that a later density setting switches tokens, not components.

| Token                     | Used for                                                  | Compact (M0)        | Comfortable (later)  |
| ------------------------- | --------------------------------------------------------- | ------------------- | -------------------- |
| `--radius`                | Controls: buttons, inputs, menu items, rows               | 6 px                | 8 px                 |
| `--radius-card`           | Cards, the user bubble, panels                            | 10 px               | 12 px                |
| `--radius-composer`       | The composer                                              | 12 px               | 14 px                |
| `--radius-dialog`         | Dialogs                                                   | 16 px               | 16 px                |
| `--control-height`        | Buttons, selects and inputs in toolbars and the composer  | 24 px               | 32 px                |
| `--control-height-nested` | Chips and buttons inside an input                         | 18 px               | 22 px                |
| `--icon-size`             | UI icons                                                  | 16 px               | 20 px                |
| `--row-height`            | Sidebar rows, menu items, card headers, the composer chin | 28 px               | to be measured       |
| Spacing steps             | Gaps between and around components                        | 6, 8, 12, 20, 32 px | 8, 12, 16, 28, 40 px |

- shadcn derives its radius scale from `--radius`, so shadcn components follow it. OverBench's own components use `rounded-card`, `rounded-composer` and `rounded-dialog`.
- The compact spacing steps are Tailwind's `1.5`, `2`, `3`, `5` and `8`.
- Among shadcn's sizes, `xs` (24 px) is the control height in toolbars and the composer. `default` (32 px) is kept for dialogs, empty states and the Welcome screen, where a larger target helps. When the comfortable density arrives, these become size variants bound to the tokens.

## Typography

- **Families**: Geist Variable for the interface and prose, falling back to PingFang SC, Microsoft YaHei and Noto Sans CJK SC for Chinese, then `system-ui`. Mono: `ui-monospace`, SF Mono, Cascadia Code, JetBrains Mono, Menlo, Consolas.
- **Sizes**: 13 px for the sidebar and controls, 14 px with 1.6 line height for thread prose, 12.5 px for code and diffs, 12 px for secondary labels. Prose keeps 1.6 instead of the reference's 1.43 because CJK text needs the extra leading.
- **Weights**: 400 for text, 500 for labels and titles, 600 for markdown headings. In the dark theme every weight drops by 20 on Geist's weight axis (400 becomes 380), because light text on a dark surface looks heavier than it is.
- Numbers that change in place, such as timers, token counts, diff stats and counters, use `tabular-nums` so they do not jitter.
- Headings use `text-wrap: balance` and prose `text-wrap: pretty`. Paths, URLs and long identifiers use `overflow-wrap: anywhere`, so they never push a card wider than the column.
- Icons inline with text sit at `vertical-align: -0.125em`, which centres them on the text.

## Motion

### Tokens

| Duration             | Value  | Used for                                        |
| -------------------- | ------ | ----------------------------------------------- |
| `--duration-instant` | 60 ms  | Press, focus, checkbox                          |
| `--duration-fast`    | 120 ms | Hover, color changes, icon crossfades           |
| `--duration-base`    | 200 ms | Disclosures, status text, release after a press |
| `--duration-slow`    | 300 ms | New thread entries, panels                      |
| `--duration-slower`  | 450 ms | The one-time attention pulse                    |

| Easing             | Curve                                    | Used for                                     |
| ------------------ | ---------------------------------------- | -------------------------------------------- |
| `--ease-out-quart` | `cubic-bezier(.165, .84, .44, 1)`        | The default for anything settling into place |
| `--ease-out-quint` | `cubic-bezier(.22, 1, .36, 1)`           | New thread entries                           |
| `--ease-out-expo`  | `cubic-bezier(.16, 1, .3, 1)`            | Hover on frequent controls, disclosures      |
| `--ease-snap`      | `cubic-bezier(.32, .72, 0, 1)`           | Press, snapping into place                   |
| `--ease-overshoot` | `cubic-bezier(.34, 1.3, .64, 1)`         | Release after a press, toggles               |
| `ease-in-out`      | Tailwind's, `cubic-bezier(.4, 0, .2, 1)` | Looping indicators                           |

The reference uses nine curves, several of them nearly identical; OverBench keeps these six.

| Spring (Motion) | Stiffness / damping / mass | Used for                 |
| --------------- | -------------------------- | ------------------------ |
| `press`         | 600 / 30 / 1               | Controls Motion animates |
| `card`          | 320 / 28 / 1               | Cards, drag release      |
| `panel`         | 1200 / 80 / 0.1            | Panels and sheets        |

Durations are custom properties used as `duration-(--duration-fast)`; easings are `--ease-*` theme variables, which give `ease-*` utilities. Springs are exported from `src/renderer/src/lib/motion.ts`.

### CSS or Motion

| CSS transitions and keyframes                                  | Motion                                               |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Hover, press, focus, color, opacity and shadow changes         | Elements leaving the tree (`AnimatePresence`)        |
| Enter-only effects, which run when an element is inserted      | Springs, layout and shared-element animations        |
| Looping indicators: spinners, halos, the waiting dots, shimmer | Gestures: drag and anything that follows the pointer |
| Disclosures and scroll-edge fades                              |                                                      |

CSS cannot animate an element that is being removed, which is why exits go to Motion. The enter and exit transitions built into shadcn components stay as they are.

### Patterns

- **Press**: `:active` scales to 0.975 in `--duration-instant` with `--ease-snap`; release returns in `--duration-base` with `--ease-overshoot`. This replaces shadcn's 1 px nudge in `button.tsx`. Rows and menu items do not scale.
- **Disclosure**: `grid-template-rows` from `0fr` to `1fr`, `--duration-base`, `--ease-out-expo`, with no height measured in JavaScript. It is the only layout animation allowed: one disclosure at a time, never inside an entry that is streaming.
- **New entry**: opacity from 0 and a 4 px rise, `--duration-slow`, `--ease-out-quint`, once per entry. Entries restored from history or a snapshot appear without animation.
- **Status text**: when a line of status changes, the old text falls away and the new one rises in, `--duration-base`.
- **Waiting dots**: three 3 px dots in an opacity wave over 1.9 s, for the gap between sending and the first output.
- **Shimmer and skeletons**: a 105° gradient sweeps across in 2 s. Skeleton sweeps move a gradient layer with `transform`; the "Thinking" text shimmer animates its own small layer's background. All skeletons on screen share one phase, so a list of placeholders reads as one sweep.
- **Scroll-edge fades**: a 28 px mask on any edge that has more content, driven by a scroll-driven animation (`animation-timeline: scroll()`) with no JavaScript.
- **Attention**: a 2 px `--attention` ring that pulses once over `--duration-slower`. It does not loop; the sidebar indicator keeps the signal.
- **Running**: a soft halo pulses around the sidebar's running dot.
- **Copy feedback**: the copy icon becomes a check for 2.5 s, then fades back.

### Reduce motion

- Motion components follow the root `<MotionConfig reducedMotion="user">`: movement is removed and opacity remains.
- CSS follows one `prefers-reduced-motion: reduce` block in `globals.css`: transforms and loops stop (dots and halos hold still, shimmer stops), opacity and color transitions remain, and disclosures open at once.

## Layout behavior

- Components adapt to their container with container queries (`@container`), not viewport media queries, because panels resize independently of the window.
- A list that acts as one control, such as the sidebar, a menu or a set of permission options, has one Tab stop and moves focus with the arrow keys (roving focus).
