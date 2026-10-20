# M0 interface

> Status: Draft · Built in [M0.3 to M0.5](../milestones/m0.md#work-packages) · Visual language: [design system](./design-system.md) · Libraries: [UI stack](../../CONTRIBUTING.md#ui-stack)

This document designs every screen M0 ships. It applies the [core philosophy](../../AGENTS.md#core-philosophy-beauty-is-productivity-颜值也是生产力): the agent's work should be legible at a glance, every state is designed, and nothing moves without a reason. Colors, sizes, radii and timings come from the [design system](./design-system.md); this document says where they are used.

## Window and chrome

- **macOS**: hidden title bar, traffic lights at `{ x: 16, y: 14 }`, centred in a 40 px top bar. The top bar leaves 80 px on the left for them.
- **Windows and Linux**: hidden title bar with `titleBarOverlay` window controls, 40 px high, colored from the current theme and updated with `setTitleBarOverlay` when the theme changes. The top bar keeps clear of the controls with `env(titlebar-area-x)` and `env(titlebar-area-width)`.
- The top bar is the drag region (`app-region-drag`). Everything clickable inside it is `app-region-no-drag`.
- The window remembers its size and position ([persistence](./persistence.md)). Minimum size: 960 × 600.

## Layout

```text
┌───────────────┬────────────────────────────────────────────────────┐
│ ● ● ●         │ Fix flaky login test          Claude Code   ⌄ Plan │  top bar (40 px)
├───────────────┼────────────────────────────────────────────────────┤
│ PROJECTS    + │                                                    │
│ ▾ overbench   │        ┌──────────────────────────────────┐        │
│   Fix flaky…● │        │ The login test fails on CI …     │  user  │
│   Add dark …  │        └──────────────────────────────────┘        │
│ ▸ website     │   I'll start by reading the test and the …  agent  │
│               │   ▸ Explored 4 files                         tools │
│               │   ┌ ✎ Edit src/auth/login.test.ts   +12 −3 ┐       │
│               │   │  … diff …                               │       │
│               │   └─────────────────────────────────────────┘       │
│               │                                                    │
│               ├────────────────────────────────────────────────────┤
│               │ ▸ Plan 3/5                                          │  pinned plan
│               │ ┌────────────────────────────────────────────────┐ │
│               │ │ Ask Claude Code to…                            │ │  composer
│               │ │ Mode ⌄   Model ⌄                    ◔ 34%   ↑ │ │
│ ⚙ Agents      │ └────────────────────────────────────────────────┘ │
└───────────────┴────────────────────────────────────────────────────┘
```

- Built with `ResizablePanelGroup`. The sidebar defaults to 260 px, resizes between 200 and 400 px, collapses with `Mod+B`, and remembers its size per device.
- The sidebar sits on surface 0 and the thread on surface 1. The step between them is the only separation; the resize handle shows a hairline only while it is hovered or dragged.
- The thread is a single centred column, 768 px at most (`max-w-3xl`), so prose keeps a comfortable line length at any window width. Tool cards and diffs use the same column.
- There is no right-hand panel in M0. The Changes panel and terminal arrive later and will open on the right.

## Screens

### Welcome

Shown when there are no projects. A centred `Empty`: the OverBench wordmark, one line ("Open a project to start working with an agent."), the **Open project** button (`Mod+O`), and below it the three agents with their status, so a missing Node.js or agent is visible before the first session.

### Project home

Shown when a project is selected but no session is. The three agents as large selectable cards (icon, name, version, status) to start a session; a hovered card rises 1 px and takes the `sm` shadow. The project's recent sessions are listed below. **Import sessions** lists sessions the agents already have for this folder (`agents.listSessions`).

### Session

The thread and the composer, described below.

### Agents

Opened from the sidebar footer or with `Mod+,`. One card per agent:

- Status with a clear next step: **Install** guidance and a link when missing, **Sign in** when needed, the error with **Retry** when failed.
- Version, from `agentInfo` once started.
- For OpenCode, **Choose binary…**, which opens the native file dialog.
- At the bottom: **Reload environment** and **Export diagnostics**.

## Sidebar

- Projects are collapsible groups: folder name, with the full path in a tooltip. **New session** (`Mod+N`) appears on hover and for the selected project.
- Session rows are `--row-height` (28 px) with `--radius` and no border. A hovered row fills with `--sidebar-accent`; the selected row has a stronger fill.
- Each row: agent icon, title (truncated), relative time, and one status indicator, in this order of priority:
  1. **Waiting for you** (`attention: 'permission'`): a filled `--attention` dot and count. This is the loudest signal in the app.
  2. **Error** (`attention: 'error'`): a destructive dot.
  3. **Running** (`status: 'running'`): a dot with a soft pulsing halo.
  4. **Starting** (`status: 'starting'`): a small spinner while the agent starts or the session loads.
  5. **Unread** (`attention: 'unread'`): a small neutral dot after a turn ended while you were elsewhere.
- Indicators always pair a color with a shape or label, never color alone.
- The sidebar list has one Tab stop; the arrow keys move between rows.
- The footer holds **Agents** and the sign-in warning when an agent needs attention.
- Later, not in M0: pinned sessions with drag reordering, grouping by status or date, and branch badges once git integration exists.

## Thread

The thread uses shadcn's `MessageScroller`. Opening a session lands at the bottom. Its scrolling must match the reference's measured behavior, which M0.3 checks:

- It follows new output while the view is within 40 px of the bottom, and stops following as soon as you scroll up.
- A scroll you make (wheel, touch, keys) wins over following for 150 ms, so streaming never fights your hand.
- Jump-to-latest appears once the view is more than 120 px from the bottom.
- Following scrolls instantly (`behavior: 'auto'`); smooth scrolling lags behind streaming text.

If `MessageScroller` cannot be configured to match, the change goes into the component, not into a second scroll hook.

Turns are 16 px apart, and the blocks within a turn 10 px.

| Entry      | Presentation                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User       | A `Bubble` with a `--muted` fill, no border and `--radius-card`, right-aligned, at most 85% of the column. Taller than 300 px, it collapses behind a 48 px fade and **Show more** |
| Agent      | Plain prose without bubble, border or avatar, so long answers and code read like a document. Rendered with Streamdown                                                             |
| Thought    | Collapsed to one line: "Thinking" with a shimmer while streaming, "Thought for 12 s" afterwards. Expands as a disclosure to muted text                                            |
| Tool call  | A compact card ([below](#tool-calls))                                                                                                                                             |
| Plan       | A checklist; the latest plan is also pinned above the composer as "Plan 3/5" and expands in place                                                                                 |
| Notice     | An `Alert` in the matching variant                                                                                                                                                |
| Compaction | A `Marker` ("Context compacted"), with the summary behind a disclosure                                                                                                            |
| Turn end   | A quiet `Marker`: "Worked for 2 m 13 s", or "Cancelled", "Stopped at the token limit", "Stopped at the request limit", "Declined"                                                 |

Between sending a prompt and the first output, the waiting dots sit where the reply will appear.

### Markdown

- Streamdown in `streaming` mode with `parseIncompleteMarkdown` while the message streams, then `static` mode.
- Plugins: `@streamdown/code` for Shiki highlighting, with a light and a dark theme matched to the app's tokens, and `@streamdown/cjk` so emphasis and line breaking work around Chinese, Japanese and Korean text.
- `skipHtml` is on: agent output never renders raw HTML. Links pass through Streamdown's link safety and open in the system browser.
- Code blocks are cards: surface 2, a hairline ring and `--radius-card`, with a `--row-height` header holding the language and a copy button.
- Images in agent messages render only from `data:` URLs; the CSP blocks remote images.

### Tool calls

```text
┌──────────────────────────────────────────────────────────────┐
│ ✎  Edit  src/auth/login.test.ts                  +12 −3   ✓ │
├──────────────────────────────────────────────────────────────┤
│  (diff, collapsed after completion; click the header to open) │
└──────────────────────────────────────────────────────────────┘
```

- **Card**: surface 2, a hairline ring, `--radius-card`; the body is separated from the header by a hairline divider, not a second border.
- **Header**: a `--row-height` row with the kind icon, the title, a one-line summary on the right (diff stats in `tabular-nums`, exit status, match count) and the status:
  - `pending`: a hollow circle.
  - `in_progress`: a spinner.
  - `completed`: a check that fades in.
  - `failed`: a destructive cross, and the card opens to show why.
- **Kind icons** (Lucide): `read` FileText, `edit` FilePen, `delete` Trash2, `move` ArrowRightLeft, `search` Search, `execute` SquareTerminal, `think` Brain, `fetch` Globe, `switch_mode` Repeat, `other` Wrench.
- **Paths and commands** are monospace, middle-truncated so the file name stays visible, with the full value in a tooltip.
- **Content**: markdown through Streamdown in `static` mode; diffs through `@pierre/diffs` `MultiFileDiff` in `unified` style with wrapping, at most 480 px high with **Show full diff**.
- **Grouping**: consecutive completed `read`, `search` and `fetch` calls collapse into one row, "Explored 4 files" or "Searched 3 times", which expands to the individual calls. Edits, commands and failures are never grouped.
- **Defaults**: running cards and cards waiting for permission are open; completed cards are collapsed, except that a turn's last edit stays open until the next turn starts.

### Permission requests

```text
┌──────────────────────────────────────────────────────────────┐
│ ▶  Run  pnpm test --filter auth                    Waiting  │
├──────────────────────────────────────────────────────────────┤
│  Claude Code wants to run this command.                      │
│                                                              │
│  [1 Allow once]  [2 Always allow]  [3 Reject]                │
└──────────────────────────────────────────────────────────────┘
```

- The request lives in the tool card it belongs to. The card takes the attention ring, pulses once, and scrolls into view.
- The diff or command being approved is visible inside the card, so you judge it before you answer.
- Options appear in the agent's order. `allow_once` is the primary button, `allow_always` is `outline`, and `reject_*` options use shadcn's `destructive` variant, a soft tinted button rather than a solid red one.
- Number keys `1` to `4` pick an option when the composer is empty and not focused; within the options, the arrow keys move focus.
- While a request is pending, the composer shows "Waiting for your approval" and the session's sidebar row shows the attention dot.
- After an answer the buttons give way to the choice made ("Allowed once"), so the history reads clearly.

## Composer

- **Surface**: raised (surface 3), `--radius-composer`, with the composer's ring and shadow states from the [design system](./design-system.md#elevation).
- **Text**: a textarea that grows with `field-sizing: content`, from 44 px up to `min(40svh, 24rem)`, then scrolls. No height is measured in JavaScript. The placeholder is "Ask <agent> to…".
- **Chin**: a `--row-height` row under the text with the controls from `config`: the mode selector, the model selector, and the reasoning selector (`thought_level`) when the agent offers one, placed by `category`. Boolean options become switches in an overflow menu. On the right are the usage ring and the send button. Controls are `--control-height`.
- **Sending**: **Enter** sends and **Shift+Enter** inserts a newline.
- **IME**: Enter never sends while an IME composition is in progress (`isComposing`, or `keyCode` 229), so Chinese, Japanese and Korean input works. The reference also drops an Enter that arrives within 500 ms after `compositionend`, a guard for WebKit. M0.3 tests Pinyin and Japanese input on all three platforms (the macOS input sources, Microsoft Pinyin and IME, fcitx5) and adds such a guard only where a test shows it is needed, with the shortest window that passes.
- **Drafts**: unsent text is kept per session and restored when you come back, also after a restart; sending clears it ([persistence](./persistence.md)).
- **Slash commands**: `/` at the start opens a `Command` popover with the agent's `available_commands_update` list, filtered as you type; choosing one inserts `/name ` and shows its input hint.
- While a turn runs, the send button becomes **Stop** and `Esc` cancels the turn. Queueing a prompt during a turn comes later ([M0 scope](../milestones/m0.md#out-planned-for-later-milestones)).
- **Usage**: a small ring showing `used / size` of the context, which turns `--attention` above 80%. The tooltip shows tokens and cost when the agent reports it.

## States

| Situation             | What the user sees                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent starting        | Thread skeleton, "Starting Codex…", and the latest stderr lines while `npx` downloads on first run         |
| Loading history       | `Skeleton` entries, replaced progressively as the replay streams in                                        |
| New, empty session    | One quiet line: "What should Claude Code work on?"                                                         |
| Sign-in needed        | `Empty` with the agent's sign-in methods ([agent host](./agent-host.md#sign-in))                           |
| Disconnected          | An `Alert` above the composer: "Codex stopped unexpectedly. Reconnecting…", then **Reconnect** if it fails |
| Failed                | The error and its detail, with **Retry** and **Export diagnostics**                                        |
| Agent host restarting | A thin banner at the top of the window; everything comes back by itself                                    |

Every one of these exists in light and dark themes before M0.3 is done.

## Motion

Each element uses a pattern from the [design system](./design-system.md#patterns):

| Element                                                          | Motion                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| New entry                                                        | Enter: opacity and a 4 px rise                        |
| Thoughts, tool cards, grouped rows, long user messages, the plan | Disclosure                                            |
| Tool status change                                               | Icon crossfade, `--duration-fast`                     |
| Status text in a tool header or the composer                     | Status text                                           |
| Permission request appears                                       | Attention: one pulse, never looping                   |
| Waiting for the first output                                     | Waiting dots                                          |
| Running session in the sidebar                                   | Halo                                                  |
| Buttons                                                          | Press and release                                     |
| Agent cards on Project home                                      | 1 px rise and `sm` shadow on hover, `--duration-fast` |
| Copying code                                                     | Copy feedback                                         |
| Dismissed alerts and banners                                     | Motion exit: opacity, `--duration-fast`               |
| Menus, popovers and dialogs                                      | shadcn's built-in transitions                         |

- Never animate the layout of the whole thread while it streams; only the entry that changed may move.
- Entries restored from history or a snapshot appear without animation.
- With reduce-motion on, movement is removed and only opacity and color changes remain ([reduce motion](./design-system.md#reduce-motion)).

## Keyboard

`Mod` is `Cmd` on macOS and `Ctrl` on Windows and Linux.

| Shortcut                      | Action                                 |
| ----------------------------- | -------------------------------------- |
| `Mod+O`                       | Open project                           |
| `Mod+N`                       | New session in the current project     |
| `Mod+B`                       | Toggle the sidebar                     |
| `Mod+L`                       | Focus the composer                     |
| `Mod+Shift+[` / `Mod+Shift+]` | Previous / next session in the sidebar |
| `Mod+,`                       | Agents                                 |
| `Esc`                         | Cancel the running turn                |
| `1` to `4`                    | Answer the pending permission request  |

Shortcuts appear in tooltips and menus, so they can be discovered.

## Accessibility

- Every control is reachable by keyboard, with a visible focus ring. Lists that act as one control use roving focus.
- An `aria-live="polite"` region announces turn ends and permission requests.
- Icon-only buttons have labels; status is never conveyed by color alone.
- Contrast meets WCAG AA in both themes, including `--muted-foreground` on surface 0, the lowest-contrast pairing.

## Performance rules for components

- Entry components are memoized and select only their own entry from the store.
- Finished messages switch Streamdown to `static` mode.
- Diff highlighting runs in `@pierre/diffs`' worker pool (`WorkerPoolContextProvider`), off the main thread.
- Thread items use `content-visibility: auto` with an intrinsic size estimate.
- Micro-interactions and looping indicators are CSS; no component re-renders to animate.
- Markdown, Shiki and the diff renderer are loaded lazily the first time a session needs them.
