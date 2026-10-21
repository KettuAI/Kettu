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
- `--destructive` and `--ring`: shadcn's.
- `--muted-foreground` in the light theme is `oklch(0.53 0 0)` instead of shadcn's 0.556, which reaches only 4.49:1 on surface 0, just under WCAG AA.
- `--sidebar-accent`, the fill of hovered and selected sidebar rows, is `oklch(0.945 0 0)` light and `oklch(0.25 0 0)` dark; shadcn's 0.97 barely shows on surface 0.
- `--muted` (the user bubble, inline code, a disabled send button) is `oklch(0.96 0 0)` light, so the bubble stays visible on surface 1. `--accent` (hovered rows on surface 1, the highlighted menu item, an open selector) is `oklch(0.962 0 0)` light and `oklch(0.27 0 0)` dark.
- `--input`, the track of an unchecked `Switch`, is `oklch(0.9 0 0)` light instead of shadcn's 0.922, so an unchecked switch still reads on a card, and `oklch(1 0 0 / 16%)` dark.

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

The terminal panel sits on surface 0, like the sidebar, so it reads as part of the workbench and the thread stays the one canvas. Its colors are tokens read by xterm.js:

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

- Sizes: 14 px in sidebar and list rows, 13 px next to the session title, 17 px on a 32 px tile in cards (16 px on 30 px in the Welcome list). The tile is `--tile` (`oklch(0.965 0 0)` light, `oklch(0.27 0 0)` dark) with an inset `--border-soft` ring and an 8 px radius.
- An agent that is not installed shows its mark in one color, `--muted-foreground`.
- The marks ship as SVG files with their license notices; the gradient and the two OpenCode colors are tokens, so they follow the theme.

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

- Dark-theme shadows are several times stronger (opacity 0.4 to 0.5), because a shadow on a dark surface barely shows. Raised surfaces in the dark theme also get a 1 px inset highlight along the top edge (`oklch(1 0 0 / 5%)`), which reads as an edge catching the light. In the light theme, outline buttons get a 1 px contact shadow instead.
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
| `--card-header`       | Tool call card headers                                             | 30 px                      | 36 px                |
| `--composer-min`      | The composer with one line of text                                 | 52 px                      | 56 px                |
| `--icon-size`         | UI icons; 14 px inside cards and controls                          | 16 px                      | 20 px                |
| Spacing steps         | Gaps between and around components                                 | 4, 6, 8, 10, 12, 16, 28 px | 8, 12, 16, 28, 40 px |

The radius scale is shadcn's, derived from `--radius`, so shadcn components follow it without new tokens:

| Utility        | Compact | Used for                                   |
| -------------- | ------- | ------------------------------------------ |
| `rounded-lg`   | 7 px    | Buttons, inputs, rows, menu items          |
| `rounded-xl`   | 9.8 px  | Cards, the user bubble, menus and popovers |
| `rounded-2xl`  | 12.6 px | The composer                               |
| `rounded-3xl`  | 15.4 px | Dialogs                                    |
| `rounded-full` |         | The send button, counts and status pills   |

- Where OverBench's look differs from a shadcn component's default, the difference is a variant added to that component with `cva`, such as `InputGroup` `variant="composer"`, `Card` `variant="tool"` and a `Button` `size="compact"` bound to `--control-height`. Call sites never restyle a component with `className`; they use it for layout only.
- The compact spacing steps are Tailwind's `1`, `1.5`, `2`, `2.5`, `3`, `4` and `7`.
- shadcn's `xs` button (24 px) is the small size; `default` (32 px) is kept for dialogs, empty states and the Welcome screen, where a larger target helps. When the comfortable density arrives, these sizes are bound to the comfortable tokens.

## Typography

- **Families**: Geist Variable for the interface and prose, falling back to PingFang SC, Microsoft YaHei and Noto Sans CJK SC for Chinese, then `system-ui`. Mono: `ui-monospace`, SF Mono, Cascadia Code, JetBrains Mono, Menlo, Consolas.
- **Sizes**: 22 px (weight 600, tracking −1.5%) for page titles, 14 px with a 1.625 line height for thread prose (shadcn `Bubble`'s `text-sm leading-relaxed`), 13 px for the sidebar and controls, 12 px for code, diffs and secondary labels, 11.5 px mono for versions, times and diff stats. Prose keeps 1.625 instead of the reference's 1.43 because CJK text needs the extra leading.
- **Weights**: 400 for text, 500 for labels and titles, 600 for markdown headings. In the dark theme every weight drops by 20 on Geist's weight axis (400 becomes 380), because light text on a dark surface looks heavier than it is.
- Numbers that change in place, such as timers, token counts, diff stats and counters, use `tabular-nums` so they do not jitter.
- Headings use `text-wrap: balance` and prose `text-wrap: pretty`. Paths, URLs and long identifiers use `overflow-wrap: anywhere`, so they never push a card wider than the column.
- Icons inline with text sit at `vertical-align: -0.125em`, which centres them on the text.

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

Durations are custom properties used as `duration-(--duration-fast)`; easings are `--ease-*` theme variables, which give `ease-*` utilities. Springs are exported from `src/renderer/src/lib/motion.ts`.

### CSS or Motion

| CSS                                                                   | Motion                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| Hover, press, focus, color, opacity and shadow changes                | Elements leaving the tree (`AnimatePresence`)        |
| Enter-only effects, through tw-animate-css (`animate-in`, `fade-in`)  | Springs, layout and shared-element animations        |
| Looping indicators: `Spinner`, `Skeleton`, `shimmer`, `animate-pulse` | Gestures: drag and anything that follows the pointer |
| Disclosures (`Collapsible`) and scroll-edge fades (`scroll-fade`)     |                                                      |

CSS cannot animate an element that is being removed, which is why exits go to Motion. The enter and exit transitions built into shadcn components stay as they are.

### Patterns

Each pattern names what provides it. OverBench writes its own keyframes only where nothing in the stack offers the effect: the one-time attention pulse and the ambient field's drift.

| Pattern           | Provided by                                                                                                    | Tuning                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Press             | shadcn `Button`'s built-in active state                                                                        | None                                                                                               |
| Disclosure        | shadcn `Collapsible` (Base UI), animating `--collapsible-panel-height`                                         | `--duration-base`, `--ease-out-expo`                                                               |
| New entry         | tw-animate-css: `animate-in fade-in slide-in-from-bottom-1`                                                    | `--duration-slow`, `--ease-out-quint`; once per entry                                              |
| Status text       | tw-animate-css: `animate-in fade-in slide-in-from-bottom-1`                                                    | `--duration-base`                                                                                  |
| Thinking, waiting | shadcn's `shimmer` utility on the status text                                                                  | None                                                                                               |
| Loading           | shadcn `Skeleton` and `Spinner`                                                                                | None                                                                                               |
| Scroll-edge fades | shadcn's `scroll-fade` utilities (scroll-driven, no JavaScript); `MessageScrollerViewport` applies them itself | `--scroll-fade-size: 28px`                                                                         |
| Running           | Tailwind's `animate-pulse` on the sidebar's running dot                                                        | None                                                                                               |
| Copy feedback     | The copy button in Streamdown's code blocks                                                                    | None                                                                                               |
| Staggered entry   | tw-animate-css: `animate-in fade-in slide-in-from-bottom-1 fill-mode-both`, with a growing `animation-delay`   | `--duration-slow`, `--ease-out-quint`; the first item after 60 ms, each next one 30 ms later, once |
| Card hover        | CSS transitions on `transform`, the ring, the shadow and the opacity of the `--card-glow` layer                | `--duration-fast`, `--ease-out-expo`                                                               |
| Ambient field     | Own keyframes, described [below](#ambient-field)                                                               | 41 s and 29 s, `ease-in-out`, alternating                                                          |
| Attention         | Own keyframe: the attention halo grows to 6 px and settles at 3 px, once                                       | `--duration-slower`; it does not loop, because the sidebar indicator keeps the signal              |

- The disclosure is the only layout animation allowed: one at a time, never inside an entry that is streaming.
- Entries restored from history or a snapshot appear without animation.

### Ambient field

The Welcome screen and Project home have a quiet background: a faint dot grid that a soft light drifts across. It is the only motion on screen while nothing happens, so it stays slow and dim; sessions and Settings never show it.

| Layer    | What it draws                                                            | Token               | Light                | Dark                 |
| -------- | ------------------------------------------------------------------------ | ------------------- | -------------------- | -------------------- |
| Grid     | 1.4 px dots on a 20 px grid                                              | `--ambient-dot`     | `oklch(0 0 0 / 9%)`  | `oklch(1 0 0 / 8%)`  |
| Light    | A 240 px circle that brightens what it passes over                       | `--ambient-glow`    | `oklch(1 0 0 / 0%)`  | `oklch(1 0 0 / 4%)`  |
| Lit grid | Slightly larger dots, visible only inside the light                      | `--ambient-dot-lit` | `oklch(0 0 0 / 30%)` | `oklch(1 0 0 / 30%)` |
| Clearing | A radial wash of the surface color behind text, so no dot sits in a word | `--background`      |                      |                      |

- The field is centred on the content and fades out towards the edges with a radial mask. On Project home it covers the title and the agent cards and fades out before the recent sessions.
- The light drifts on two axes with different periods, 41 s across (±15% of the field) and 29 s down (−9% to +11%), both `ease-in-out` and alternating, so its path does not visibly repeat. The lit grid moves the opposite way inside the light, so the dots stay in place and only the light travels.
- Every layer is one element moved with `transform`; the grids are CSS gradients, not images or a canvas. Check in the Performance panel that the field adds no layout or paint per frame.
- The drift pauses (`animation-play-state: paused`) while the window is hidden or not focused, from the renderer's `focus`, `blur` and `visibilitychange` events.
- In the light theme the light itself is invisible on a near-white surface; there the lit dots alone carry it.

### Reduce motion

- Motion components follow the root `<MotionConfig reducedMotion="user">`: movement is removed and opacity remains.
- CSS follows one `prefers-reduced-motion: reduce` block in `globals.css`: movement and loops stop (pulses hold still, shimmer stops), opacity and color transitions remain, and disclosures open at once.
- The ambient field's light rests at the centre of the content, a staggered entry becomes a plain fade, and a hovered card keeps its glow and shadow but does not rise.

## Layout behavior

- Components adapt to their container with container queries (`@container`), not viewport media queries, because panels resize independently of the window.
- A list that acts as one control, such as the sidebar, a menu or a set of permission options, has one Tab stop and moves focus with the arrow keys (roving focus).
