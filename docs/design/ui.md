# M0 interface

> Status: Draft · Built in [M0.3 to M0.5](../milestones/m0.md#work-packages) · Visual language: [design system](./design-system.md) · Libraries: [UI stack](../../CONTRIBUTING.md#ui-stack)

This document designs every screen M0 ships. It applies the [core philosophy](../../AGENTS.md#core-philosophy-beauty-is-productivity-颜值也是生产力): the agent's work should be legible at a glance, every state is designed, and nothing moves without a reason. Colors, sizes, radii and timings come from the [design system](./design-system.md); this document says where they are used.

## Window and chrome

- **macOS**: hidden title bar, traffic lights at `{ x: 16, y: 14 }`, centred in a 40 px top bar. The top bar leaves 80 px on the left for them.
- **Windows and Linux**: hidden title bar with `titleBarOverlay` window controls, 40 px high, colored from the current theme and updated with `setTitleBarOverlay` when the theme changes: the background is `--background`, the symbols `--foreground` (`#0a0a0a` light, `#fafafa` dark). The top bar keeps clear of the controls with `env(titlebar-area-x)` and `env(titlebar-area-width)`. There is no menu bar; the renderer handles the shortcuts.
- The top bar is the drag region (`app-region-drag`). Everything clickable inside it is `app-region-no-drag`.
- The window remembers its size, position and maximized state, and never reopens off-screen ([persistence](./persistence.md#window-and-app-state)). Minimum size: 960 × 600.
- The window's own background follows the effective theme, `#fcfcfc` light and `#151515` dark, the values of `--background`, also when the theme changes while it is open.
- On Windows and Linux, closing the last window quits the app, so it goes through the quit confirmation first; on macOS it only closes the window, and agents and terminals keep running.

## Launch

Launching should feel like opening a lid, not waiting for a page: no white or black flash, no empty window, and no content jumping into place.

| Moment                 | What is on screen                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the first frame | Nothing. Main reads the settings, then creates the window hidden, with `backgroundColor` set to `--background` of the theme from settings (`nativeTheme` decides for System), and shows it on `ready-to-show` |
| First frame            | The app shell from the renderer bundle alone: window controls, the sidebar on surface 0 with `Skeleton` rows at the real 28 px row height, and the empty main surface                                         |
| Data arrives           | Projects and sessions from the agent host replace the skeleton rows in place, fading in over `--duration-base`; nothing moves, because the rows already had their size                                        |
| A session is restored  | With **Restore the last session**, the main area shows the thread skeleton until the snapshot arrives, then the thread fades in                                                                               |

- The first frame needs no data and no agent host, so it is on screen within the [launch budget](../milestones/m0.md#performance-budgets) (500 ms to the first interactive frame) whatever the host is doing.
- A launch that takes longer than 1 s, such as a cold start after an update, shows "Starting OverBench…" with a `Spinner` centred in the main area, so a slow start never looks frozen; a normal start never shows it.
- There is no splash screen. A launch mark comes once the OverBench logo is final, and it follows the same rule: it appears only when the launch is slow, so it never delays a fast one.
- With reduce-motion on, the content appears without fading.

## Layout

```text
┌───────────────┬────────────────────────────────────────────────────┐
│ ● ● ●       ◫ │ Fix flaky login ⌄  ✳ Claude Code  ⎇ fix/flaky ⇡2 ▣ │  top bar (40 px)
├───────────────┼────────────────────────────────────────────────────┤
│ ✎ New session │                                                    │
│ Projects    + │       ┌──────────────────────────────────┐         │  user
│ ⌄ overbench   │       │ The login test fails on CI …     │         │
│  ✳ Fix flaky 2│       └──────────────────────────────────┘         │
│   ◇ Explore   │ I'll start by reading the test and the …           │  agent
│   ◇ Review   1│ ┌ ✎ Edit src/auth/session.ts        +4 −3  ✓ ┐     │  tools
│  ◎ Add dark ↳1│ └────────────────────────────────────────────┘     │
│  ✳ Bump deps ⊙│ ⊙ Committed 3f2a1c1 fix(auth): read the clock…     │  git event
│ › website     │ ┌────────────────────────────────────────────┐     │
│               │ │ Ask Claude Code to…                      ↑ │     │  composer
│               │ └────────────────────────────────────────────┘     │
│               │   Default ⌄              Opus 5.5 High ⌄  ◔        │  control row
│               ├────────────────────────────────────────────────────┤
│               │ zsh   pnpm dev ●                       +  ⤢  ×     │  terminal tabs
│               │ ~/overbench (fix/flaky-login) $ pnpm test          │  terminal
│ ⚙ Settings ⌘, │  ✓ 42 passed  ·  1 failed                          │
└───────────────┴────────────────────────────────────────────────────┘
```

- Built with `ResizablePanelGroup`. The sidebar defaults to 260 px, resizes between 200 and 400 px, collapses with `Mod+B` through the panel's own collapse, and remembers its size per device.
- The sidebar sits on surface 0 and the thread on surface 1. The step between them is the only separation; the resize handle shows a hairline only while it is hovered or dragged.
- The thread is a single centred column, 768 px at most (`max-w-3xl`), so prose keeps a comfortable line length at any window width. Tool cards and diffs use the same column.
- The [terminal](#terminal) opens as a panel at the bottom of the main area, under the thread and the composer. The Changes panel arrives later and will open on the right, so both can be open at once.

## Screens

### Welcome

Shown when there are no projects. A centred `Empty`: the OverBench wordmark, one line ("Open a project to start working with an agent."), the **Open project** button (`Mod+O`), and below it the three agents with their status, so a missing Node.js or agent is visible before the first session.

Behind it lies the [ambient field](./design-system.md#ambient-field): a faint dot grid that a soft light drifts across, centred on the content and fading out towards the edges. The content enters once, the wordmark first and each agent row 30 ms after the one before.

### Project home

Shown when a project is selected but no session is. The three agents as large selectable cards (mark, name, version, status) to start a session. A hovered card rises 1 px, takes the `sm` shadow and lights up softly from its bottom edge, as the reference's starter cards do. The project's recent sessions are listed below. The ambient field sits behind the title and the cards and fades out before the list, so the list stays plain. **Import sessions** lists sessions the agents already have for this folder (`agents.listSessions`).

### Session

The thread and the composer, described below. The top bar shows the session title as a button whose menu holds **New sub-session**, **Close** and **Delete** ([session lifecycle](./session-model.md#session-lifecycle)), followed by the agent's mark and name in `--muted-foreground`. A sub-session's top bar starts with its parent's title as a link. On the right of the top bar sit the [git status](#git-in-the-top-bar) and the terminal toggle; Project home shows them too.

### Subagent

Opening a subagent ([sub-sessions](./session-model.md#sub-sessions)) shows its own thread: the parent's instructions first, as a quoted `session_message` entry labelled with the parent's title, then the subagent's work, including its permission requests. The agent drives it, so in place of the composer a bar reads "Claude Code runs this subagent for Fix flaky login test", with **Stop** when the agent allows it and **Back to** the parent.

### Settings

Opened from **Settings** in the sidebar footer or with `Mod+,`. Settings takes the whole window: the app sidebar goes away, and the top bar holds a **Back** button after the window controls that returns to where you were. `Esc` does the same when no field has focus. While a session waits for your approval, the Back button carries the `--attention` count, so the signal the sidebar gave is not lost.

Settings is one scrolling page, the way VS Code's settings editor works. A column on the left, on surface 0 like the app sidebar it replaces, holds the title, a search field (`Mod+F`) that filters rows in every section by name and description, and the table of contents, which jumps to a section and highlights the one in view; while you search, it shows the number of matching rows next to each section. Each section is a card of rows: the name and a one-line description on the left, the control on the right (shadcn `Field` with `Switch`, `Select` or `ToggleGroup`). Changes apply at once, with no Save button.

| Section            | Rows                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| General            | **Default agent** for New session (Ask each time, or one agent) · **Send with** Enter or `Mod+Enter`, the other key adding a newline · **Restore the last session on launch** · **Ask before quitting while agents or terminal commands are running**                                                                                                                                                                                |
| Appearance         | **Theme**: System, Light or Dark, as three preview tiles · **Text size**: Small, Default or Large · **Reduce motion**: System or Always                                                                                                                                                                                                                                                                                              |
| Agents             | One card per agent: status with its next step (**Install** guidance when missing, the sign-in methods when needed, the error with **Retry** when failed), the version from `agentInfo`, the launch command, the Node.js version, the account and its [plan limits](#usage-popover) when the agent reports them, and for OpenCode **Choose binary…**. Below them: where and when the environment was read, and **Reload environment** |
| Terminal           | **Shell**: the platform default, or a program picked with **Choose…** · **Font size**: 12, 13 or 14 px                                                                                                                                                                                                                                                                                                                               |
| Git                | Whether `git` and the GitHub CLI were found and whether `gh` is signed in, with the command to run when it is not · **Fetch in the background** every 5 minutes                                                                                                                                                                                                                                                                      |
| Notifications      | Shown only when no OverBench window is focused: **Needs approval**, **Turn finished**, **Errors**, **Play a sound** (the system notification sound), and **Show a count on the Dock icon** (the taskbar button on Windows; not shown on Linux, where desktops differ)                                                                                                                                                                |
| Keyboard shortcuts | The [shortcuts](#keyboard), read-only, with the platform's modifier                                                                                                                                                                                                                                                                                                                                                                  |
| Advanced           | **Proxy** for agents, `npx` and updates: Use the environment, or Custom with a URL and a no-proxy list · **Diagnostics**: Export diagnostics · **Data folder**: Show in Finder (Explorer, the file manager) · **Remove all sessions from OverBench**, which clears the index after a confirmation and leaves the agents' transcripts alone                                                                                           |
| About              | The version, with the Electron, Chromium and Node.js versions and **Copy**; the [update status](#updates) with its action and **Automatic updates**; links to the source code and the third-party notices                                                                                                                                                                                                                            |

- The sign-in notice in the sidebar footer opens Settings at Agents.
- Settings shows only what M0 supports; there are no disabled placeholders for later features.
- The values and where they are kept: [persistence](./persistence.md#settings).

## Sidebar

- A **New session** row (`Mod+N`) at the top starts a session in the selected project.
- Projects are collapsible groups: folder name, with the full path in a tooltip.
- The sidebar's content is built from shadcn's `Sidebar` parts (`SidebarGroup`, `SidebarMenu`, `SidebarMenuButton` at `size="sm"`, which is 28 px, `SidebarMenuBadge`) with `collapsible="none"`, inside the `ResizablePanel` that owns its width. Rows have no border; hover and selection use the component's own fills.
- Each row: the agent's [mark](./design-system.md#agent-marks) at 14 px, title (truncated), relative time, and one status indicator, in this order of priority:
  1. **Waiting for you** (`attention: 'permission'`): an `--attention` pill with the count, in place of the time. This is the loudest signal in the app.
  2. **Error** (`attention: 'error'`): a destructive `CircleAlert` icon.
  3. **Running** (`status: 'running'`): a dot with Tailwind's `animate-pulse`.
  4. **Starting** (`status: 'starting'`): a `Spinner` while the agent starts or the session loads.
  5. **Unread** (`attention: 'unread'`): a small neutral dot after a turn ended while you were elsewhere.
- Running and starting rows show no time, since the session is active now.
- A session whose branch has a pull request shows its state icon after the title ([repository state](./design-system.md#repository-state)), as in the reference. Hovering the row shows the branch and the pull request in a tooltip.
- **Sub-sessions** ([session model](./session-model.md#sub-sessions)) sit under their parent, indented 16 px along a hairline `--border` guide line. A subagent shows the `Bot` icon with its title and, muted, its description ("Explore · Find where the tests read the clock"); a sub-session you started shows its agent's mark and title.
- A parent has a chevron in front of its mark. It expands by itself while a sub-session is running or waiting for you, and otherwise stays as you left it.
- A parent's indicator includes its sub-sessions: the attention count adds up their permission requests, and it shows Running while any of them runs, so a collapsed parent still says where to look.
- **New sub-session** is in the session's title menu and its row's context menu.
- Indicators always pair a color with a shape or label, never color alone.
- The sidebar list has one Tab stop; the arrow keys move between rows.
- The footer holds **Settings** (`Mod+,`) and, above it, a tinted `--attention` notice when an agent needs sign-in ("Codex needs you to sign in"). The notice opens Settings at Agents and is hidden while that section is open. The [update notice](#updates) sits between the two.
- Later, not in M0: pinned sessions with drag reordering, and grouping by status or date.

## Thread

The thread uses shadcn's `MessageScroller` with `autoScroll`: it follows new output, yields as soon as you scroll up, shows `MessageScrollerButton` to jump back, and fades its edges. The user message that starts a turn is the `scrollAnchor`, so a new turn opens with your prompt in view. Opening a session lands at the bottom.

M0.3 compares its behavior with the reference's measurements: following within 40 px of the bottom, your own scroll winning over following for 150 ms, jump-to-latest beyond 120 px, and instant rather than smooth following. Where `MessageScroller` differs and offers no option, OverBench keeps its behavior and records the difference here; it never adds a second scroll hook.

Turns are 16 px apart, and the blocks within a turn 10 px.

| Entry           | Presentation                                                                                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User            | `Message align="end"` with a `Bubble` in the `muted` variant, at most 80% of the column. Taller than 300 px, it collapses behind a fade and **Show more**                                                                                                                                                              |
| Agent           | Plain prose without bubble, border or avatar, so long answers and code read like a document. Rendered with Streamdown                                                                                                                                                                                                  |
| Thought         | Collapsed to one line: "Thinking" with shadcn's `shimmer` while streaming, "Thought for 12 s" afterwards. Expands as a `Collapsible` to muted text                                                                                                                                                                     |
| Tool call       | A compact card ([below](#tool-calls))                                                                                                                                                                                                                                                                                  |
| Subagent        | A compact card with the `Bot` icon, the subagent's title and description, its status and, while it runs, its latest tool call. It opens the subagent                                                                                                                                                                   |
| Session message | In a subagent's thread, the parent's instructions as a quoted block labelled with the parent's title                                                                                                                                                                                                                   |
| Plan            | A checklist; the latest plan is also pinned above the composer as "Plan 3/5" and expands in place                                                                                                                                                                                                                      |
| Notice          | An `Alert` in the matching variant                                                                                                                                                                                                                                                                                     |
| Compaction      | A `Marker` ("Context compacted"), with the summary behind a disclosure                                                                                                                                                                                                                                                 |
| Turn end        | A quiet `Marker`: "Worked for 2 m 13 s", or "Cancelled", "Stopped at the token limit", "Stopped at the request limit", "Declined"                                                                                                                                                                                      |
| Git event       | A muted line with its icon: `GitCommit` "Committed `3f2a1c1` fix(auth): read the clock once", `ArrowUp` "Pushed 2 commits to origin/fix/flaky-login", `GitBranch` "Switched to fix/flaky-login", or "Opened pull request" with its chip ([git events](./git.md#git-events-in-the-thread)). A commit id copies on click |

Between sending a prompt and the first output, a status line ("Working…") with `shimmer` sits where the reply will appear.

### Markdown

- Streamdown in `streaming` mode with `parseIncompleteMarkdown` while the message streams, then `static` mode.
- Plugins: `@streamdown/code` for Shiki highlighting, with a light and a dark theme matched to the app's tokens, and `@streamdown/cjk` so emphasis and line breaking work around Chinese, Japanese and Korean text.
- `skipHtml` is on: agent output never renders raw HTML. Links pass through Streamdown's link safety and open in the system browser. A GitHub pull request URL renders as a [pull request chip](#pull-requests) instead of a plain link.
- Code blocks are Streamdown's, with its copy button, on surface 2 with a hairline ring.
- Images in agent messages render only from `data:` URLs; the CSP blocks remote images.

### Tool calls

```text
┌──────────────────────────────────────────────────────────────┐
│ ✎  Edit  src/auth/login.test.ts                  +12 −3   ✓ │
├──────────────────────────────────────────────────────────────┤
│  (diff, collapsed after completion; click the header to open) │
└──────────────────────────────────────────────────────────────┘
```

- **Card**: shadcn `Card` with an added `tool` variant (surface 2, a hairline ring, `rounded-xl`) and a `Collapsible` body; the body is separated from the header by a `--border-soft` `Separator`, not a second border. When collapsed, the header itself is the toggle.
- **Header**: a `--card-header` row with the kind icon, the verb, the path or command, a one-line summary on the right (diff stats in `tabular-nums`, exit status, match count) and the status:
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

- The request lives in the tool card it belongs to. The card takes the [attention ring](./design-system.md#elevation), pulses once, and scrolls into view; its header shows "Needs approval" with an `--attention` dot in place of the status icon.
- The diff or command being approved is visible inside the card, so you judge it before you answer.
- Options appear in the agent's order. `allow_once` is the primary button, `allow_always` is `outline`, and `reject_*` options use shadcn's `destructive` variant, a soft tinted button rather than a solid red one.
- Number keys `1` to `4` pick an option when the composer is empty and not focused; within the options, the arrow keys move focus.
- While a request is pending, the composer shows "Waiting for your approval" and the session's sidebar row shows the attention dot.
- After an answer the buttons give way to the choice made ("Allowed once"), shown in the card's header so the history reads clearly even with the card closed.

## Composer

The layout follows the reference: the box holds only your text and the send button, and the session controls sit in a row under it. The box stays quiet, and the controls read as settings rather than as part of the message.

```text
┌──────────────────────────────────────────────────────────┐
│ Ask Claude Code to…                                    ↑ │  composer, 52 px for one line
└──────────────────────────────────────────────────────────┘
  Default ⌄                              Opus 5.5 High ⌄  ◔    control row, 28 px
```

- **Surface**: shadcn's `InputGroup` with an added `composer` variant: raised (surface 3), `rounded-2xl`, and the composer's ring and shadow states from the [design system](./design-system.md#elevation).
- **Text**: `InputGroupTextarea`, which grows with `field-sizing: content`, from `--composer-min` up to `min(40svh, 24rem)`, then scrolls. The placeholder is "Ask <agent> to…".
- **Send button**: a 28 px round `InputGroupButton` at the end of the last line; `--primary` when there is text, `--muted` and disabled when empty.
- **Control row**: a `--row-height` row under the box, outside it, built from `config`. On the left, the mode selector. On the right, one model button that shows the model and, when the agent offers `thought_level`, the reasoning level in muted text ("Opus 5.5 High"); then the usage ring. The model button opens a menu with the models (the current one checked, number keys `1` to `4` pick), **Effort** as a submenu, and boolean options as switches at the end. Any other `select` option gets its own button in the row, placed by `category`. The controls are ghost buttons at `--control-height` in `--muted-foreground`; the model name is `--foreground`.
- **Sending**: **Enter** sends and **Shift+Enter** inserts a newline.
- **IME**: Enter never sends while an IME composition is in progress (`isComposing`, or `keyCode` 229), so Chinese, Japanese and Korean input works. The reference also drops an Enter that arrives within 500 ms after `compositionend`, a guard for WebKit. M0.3 tests Pinyin and Japanese input on all three platforms (the macOS input sources, Microsoft Pinyin and IME, fcitx5) and adds such a guard only where a test shows it is needed, with the shortest window that passes.
- **Drafts**: unsent text is kept per session and restored when you come back, also after a restart; sending clears it ([persistence](./persistence.md)).
- **Slash commands**: `/` at the start opens a `Command` popover with the agent's `available_commands_update` list, filtered as you type; choosing one inserts `/name ` and shows its input hint.
- While a turn runs, the send button becomes a round **Stop** and `Esc` cancels the turn. You can keep writing a draft meanwhile; queueing a prompt during a turn comes later ([M0 scope](../milestones/m0.md#out-planned-for-later-milestones)).
- While a permission request is pending, the placeholder reads "Waiting for your approval" and the send button is disabled.
- While the agent is starting, the text area is disabled and the control row is hidden, because the config options are not known yet.
- **Usage**: a 16 px pie inside a thin ring showing `used / size` of the context, alone at first; a filling wedge, unlike a short arc, never reads as a spinner. From 80% it turns `--attention` and shows the percentage next to it. When a plan limit of the agent's account reaches its warning state, its window and percentage appear in front of the ring in `--attention` ("5h 92%"); once a limit is reached, the composer's placeholder says when it resets. A click opens the [usage popover](#usage-popover).

### Usage popover

```text
┌──────────────────────────────────────────────┐
│ Context                                  84% │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────│
│ 215k of 256k tokens · 41k left               │
│ This session   Input 1.2M  Output 48k        │
│                Cache read 980k  write 64k    │
│                                   Compact    │
├──────────────────────────────────────────────┤
│ Claude Max                     Plan limits   │
│ 5-hour        ━━━━━━━━━━━──────  62%  14:30  │
│ Weekly        ━━━━━────────────  31%  Mon    │
│ Weekly · Opus ━━━━━━━━━━━━━━━──  88%  Mon    │
│ Updated 3 min ago                            │
└──────────────────────────────────────────────┘
```

- A shadcn `Popover`, 320 px wide, in two parts separated by a `Separator`.
- **Context**, for this session: a `Progress` bar of `used / size`, the tokens used and left, and the session's token totals when the agent reports them (input, output, reasoning, cache read and write). The cost appears only when the account is not a subscription. **Compact** runs the agent's own `compact` command, and is shown only when the agent offers one among its slash commands.
- **Plan limits**, for the agent's account: the plan label from the agent ("Claude Max"), then one row per window the agent has reported ([plan limits](./session-model.md#plan-limits)): label, a bar, the percentage in `tabular-nums`, and the reset time (the clock time today, the weekday later, the full time in a tooltip). Bars at the warning state turn `--attention`, and a reached limit `--destructive`. "Updated 3 min ago" tells how fresh the numbers are.
- Agents that report no plan limits, today Codex and OpenCode, show the Context part only; an API key account shows its label without bars.
- Settings › Agents shows the same plan rows on each agent's card.

## Git in the top bar

The right side of the top bar shows the project's repository at a glance. Everything comes from the [git service](./git.md#repository-status) and updates as the agent, the terminal or any other tool changes the repository.

```text
⎇ fix/flaky-login  ⇡2 ⇣1  ±3   ⊙ #42 ✓
```

- **Branch**: `GitBranch` and the branch name in monospace, middle-truncated at 200 px. A detached `HEAD` shows the short commit id; an unborn branch shows its name and "no commits".
- **Sync**: `ArrowUp` with the number of commits not pushed, in `--foreground`; `ArrowDown` with the number behind the upstream, in `--muted-foreground`. In sync, nothing shows. A branch with no upstream shows `CloudUpload` and "Not published".
- **Changes**: `FileDiff` with the number of changed files, staged, unstaged and untracked together. Conflicts replace it with `TriangleAlert` and their count in `--destructive`; a merge or rebase in progress adds "Rebasing 2/5" in `--attention`.
- **Pull request**: the current branch's pull request as a chip, `#42` with its state icon and its checks icon. It opens the pull request in the browser; the rest of the cluster opens the branch popover.
- Each part is a ghost button at `--control-height`; the cluster is one Tab stop with arrow-key focus inside. A project that is not a repository, or a machine without `git`, shows nothing here.

### Branch popover

```text
┌────────────────────────────────────────────────┐
│ ⎇ fix/flaky-login                            ⧉ │
│ from main · tracking origin/fix/flaky-login    │
│                                                │
│ main ──●────────────────────●─ ⇣3              │
│         ╲                                      │
│          ●────●────●────◉────◌                 │
│          pushed        ⇡2 not pushed   3 files │
│                                                │
│ 3f2a1c1  fix(auth): read the clock once   ⇡ 2m │
│ 9be04d7  test(auth): freeze time in login ⇡ 8m │
│ 51c8a20  refactor(auth): extract clock      1h │
│                                                │
│ 3 files changed  +24 −6 · 1 staged · 1 new     │
├────────────────────────────────────────────────┤
│ ⊙ Fix flaky login test                    #42  │
│   Open · into main · ✓ 3 passed · ◌ 1 pending  │
│   Review required              Open on GitHub  │
├────────────────────────────────────────────────┤
│ Fetched 12 min ago          Fetch   Terminal   │
└────────────────────────────────────────────────┘
```

- A shadcn `Popover`, 360 px wide.
- **Header**: the branch name (monospace, wrapping rather than truncating) with a copy button, and under it the base and the upstream.
- **Branch lane**: a small SVG drawing of the branch against its base. The top line is the base branch; dots after the fork point are the base's new commits, labelled with how far behind the branch is. The lower line is the branch: filled dots for pushed commits, `--foreground` rings for commits not pushed, and a dashed ring at the tip when the working tree has changes. A small tick marks the upstream's position. More than eight commits collapse into a gap with their count. The lane has a text alternative that says the same in words ("5 commits ahead of main, 2 not pushed, 3 behind").
- **Commits**: the branch's newest commits, five at first and up to twenty with a scroll: id in monospace, subject, relative time, and `ArrowUp` on those not pushed.
- **Working tree**: files changed with added and removed lines in `tabular-nums`, then the staged, untracked and conflicted counts.
- **Pull request**: state icon and title, number, base, checks summary and review state, and **Open on GitHub**. A published branch without one offers **Create pull request**, which opens GitHub's compare page in the browser. Without `gh`, a muted line says "Install the GitHub CLI to see pull requests"; signed out, it shows `gh auth login` with a copy button.
- **Footer**: when the remote was last fetched, **Fetch** (a spinner while it runs, git's message inline if it fails), and **Terminal**, which opens a terminal in the project.

### Pull requests

- **Chips** in agent text and tool output: `--muted` fill, `--border-soft` ring, the state icon, `owner/repo#42` and the title truncated after 40 characters. Hover shows a `HoverCard` with the title, state, branches, checks, review state and when it was updated; a click opens the pull request in the browser. Without `gh`, the chip shows the neutral `GitPullRequest` icon and the number, and still opens the link.
- **Sidebar**: the badge on a session's row, described in [sidebar](#sidebar).
- **Top bar**: the current branch's chip, above.

## Terminal

The built-in [terminal](./terminal.md) is a panel at the bottom of the main area, under the thread and the composer.

```text
├──────────────────────────────────────────────────────────────┤
│ ▣ zsh   ▣ pnpm dev ●   ▣ git log                  +   ⤢   ×  │  tabs, 32 px
│ ~/overbench (fix/flaky-login) $ pnpm test --filter auth       │
│  ✓ login.test.ts (12)                                        │
│  ✗ session.test.ts (1)                                       │
│ ~/overbench (fix/flaky-login) $ █                            │
└──────────────────────────────────────────────────────────────┘
```

- **Opening**: `` Ctrl+` `` on every platform, as in VS Code, or the `SquareTerminal` toggle at the right of the top bar, which shows a pressed state while the panel is open. The first time in a project it starts a terminal in the project folder and focuses it; later it shows the terminals that already exist.
- **Panel**: a `ResizablePanel` under the thread, 280 px high by default, between 120 px and 70% of the main area, remembered per device. It sits on surface 0 ([terminal tokens](./design-system.md#terminal)); the step from the thread's surface 1 is the separation, and the resize handle shows a hairline only while hovered or dragged. It opens and closes at once, without animating its height.
- **Tabs**: a 32 px strip. Each tab has the `SquareTerminal` icon and the title of its foreground process; the active tab takes `--accent`. A tab that printed while hidden shows a neutral dot, and one whose shell exited shows its exit code. On the right: **New terminal** (`` Ctrl+Shift+` ``), **Maximize** (the panel takes the main area, and the thread is hidden until restored), and **Hide** (`` Ctrl+` ``), which keeps the processes running.
- **Closing a tab** ends its shell, after a confirmation if a command is still running.
- **Selection**: selecting text shows a small **Ask Claude Code** button at the end of the selection; it and `Mod+L` put the selection into the composer as a fenced code block. The context menu holds **Copy**, **Paste**, **Select all**, **Clear** and the same **Ask** item.
- **Copy and paste**: `Cmd+C` and `Cmd+V` on macOS; `Ctrl+Shift+C` and `Ctrl+Shift+V` on Windows and Linux, where `Ctrl+C` stays the interrupt.
- **Focus and shortcuts**: while the terminal has focus, keys go to the shell. On macOS, `Cmd` shortcuts still reach the app. On Windows and Linux, only `` Ctrl+` ``, `` Ctrl+Shift+` ``, copy and paste reach the app, since `Ctrl+B`, `Ctrl+L` and `Ctrl+N` mean something to the shell; `Ctrl+L` reaches the app only while text is selected, the way Windows Terminal treats `Ctrl+C`.
- **Projects**: the panel shows the current project's terminals. In a project without one, the open panel shows a quiet empty state with **New terminal**; it never starts a shell by itself when you switch projects.
- **States**: starting (a `Spinner` in the tab while the shell starts), exited (the output stays, with **Restart**), and terminal host stopped (each tab shows "Terminal stopped unexpectedly" with **Restart**).

## Updates

The [updater](./updates.md) works in the background, and the interface shows it only when there is something to do: an update is ready, or it has just been installed. Checking and downloading never show outside Settings.

- **Update notice**: when an update is ready, a row in the sidebar footer, directly above **Settings** and below the sign-in notice when both show. It is a raised row on surface 2 with `--card-ring`, so it reads as an object rather than a warning: the `CircleArrowUp` icon, "Update ready" with the version in `--muted-foreground`, and a small outline **Restart** button. It is neutral, not `--attention`, because nothing waits on it. Hovering it shows "OverBench 0.3.0 is downloaded. Restart to finish; your sessions come back." and an × that dismisses it until a newer version is found.
- In Link mode ([platforms](./updates.md#platforms)) the notice reads "0.3.0 is available" with **Download**, which opens the release page in the browser.
- **After an update**, the same row reads "Updated to 0.3.0" with **What's new**, which opens the release page, and an ×. It shows for that launch only. There is no dialog and no OS notification.
- With the sidebar collapsed, the sidebar toggle in the top bar carries a small `--foreground` dot, and its tooltip names the version.
- **Restart** with agents working or terminal commands running first opens an `AlertDialog`: "Restart to update?", the running sessions with their agent marks and the busy terminals by command, "Your sessions and drafts come back after the restart.", then **Cancel** and **Restart**. With nothing running it restarts at once. The dialog follows **Ask before quitting while agents or terminal commands are running**.
- Main asks for this dialog, and the same one for quitting, with `app:confirm-quit` (`QuitRequest`, `reason` `update` or `quit`, listing the busy sessions and terminals); the renderer answers with `window.overbench.app.respondQuit(id, confirmed)`. When the page has no listener, or reloads before it answers, main asks with a native dialog instead, so a quit never waits forever.
- **Settings › About** holds the whole status in one row under the version, the state on the left and its action on the right:

  | State        | Text                                                                                        | Action                       |
  | ------------ | ------------------------------------------------------------------------------------------- | ---------------------------- |
  | Up to date   | "You're up to date" · "Checked 5 minutes ago"                                               | **Check for updates**        |
  | Checking     | `Spinner` "Checking for updates…"                                                           | none                         |
  | Just checked | `CircleCheck` "Up to date", for 4 s after a check you started                               | none                         |
  | Downloading  | "Downloading 0.3.0" with a `Progress` bar and the percentage                                | none                         |
  | Ready        | "0.3.0 is ready to install"                                                                 | **What's new**, **Restart**  |
  | Available    | "0.3.0 is available"                                                                        | **What's new**, **Download** |
  | Error        | "Couldn't check for updates" and the reason                                                 | **Try again**                |
  | Off          | "Updates are installed by your package manager", or "Updates are off in development builds" | none                         |

- Below it, **Automatic updates**: Download and install, Notify only, or Off ([checking and downloading](./updates.md#checking-and-downloading)).
- On macOS the app menu has **Check for Updates…** under OverBench. It opens Settings at About and checks there instead of showing a dialog.

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

| Element                                                          | Motion                                  |
| ---------------------------------------------------------------- | --------------------------------------- |
| New entry                                                        | New entry                               |
| Thoughts, tool cards, grouped rows, long user messages, the plan | Disclosure                              |
| Tool status change                                               | Icon crossfade, `--duration-fast`       |
| Status text in a tool header or the composer                     | Status text                             |
| Permission request appears                                       | Attention: one pulse, never looping     |
| Waiting for the first output                                     | Thinking, waiting                       |
| Running session in the sidebar                                   | Running                                 |
| Buttons                                                          | Press                                   |
| Agent cards on Project home                                      | Card hover                              |
| Welcome content and Project home cards on first show             | Staggered entry                         |
| Background of Welcome and Project home                           | Ambient field                           |
| Expanding a parent session in the sidebar                        | Disclosure                              |
| Git event in the thread                                          | New entry                               |
| Counts in the git status and the usage ring                      | Status text                             |
| Terminal panel                                                   | None: it opens and closes at once       |
| Copying code                                                     | Copy feedback                           |
| Update notice appears                                            | New entry                               |
| Dismissed alerts and banners                                     | Motion exit: opacity, `--duration-fast` |
| Menus, popovers and dialogs                                      | shadcn's built-in transitions           |

- Never animate the layout of the whole thread while it streams; only the entry that changed may move.
- Entries restored from history or a snapshot appear without animation.
- With reduce-motion on, movement is removed and only opacity and color changes remain ([reduce motion](./design-system.md#reduce-motion)).

## Keyboard

`Mod` is `Cmd` on macOS and `Ctrl` on Windows and Linux.

| Shortcut                            | Action                                 |
| ----------------------------------- | -------------------------------------- |
| `Mod+O`                             | Open project                           |
| `Mod+N`                             | New session in the current project     |
| `Mod+B`                             | Toggle the sidebar                     |
| `Mod+L`                             | Focus the composer                     |
| `Mod+Shift+[` / `Mod+Shift+]`       | Previous / next session in the sidebar |
| `Mod+,`                             | Settings; `Esc` goes back              |
| `` Ctrl+` ``                        | Show or hide the terminal              |
| `` Ctrl+Shift+` ``                  | New terminal                           |
| `Mod+L` with terminal text selected | Ask the agent about the selection      |
| `Esc`                               | Cancel the running turn                |
| `1` to `4`                          | Answer the pending permission request  |

Shortcuts appear in tooltips and menus, so they can be discovered.

On macOS, `Cmd+O`, `Cmd+N`, `Cmd+B` and `Cmd+,` are also accelerators of the app menu, which sends them to the window as `app:command` (`open-project`, `new-session`, `toggle-sidebar`, `open-settings`); the renderer handles those four itself only on Windows and Linux, where there is no menu bar, so a shortcut never acts twice.

### The macOS menu

| Menu      | Items                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OverBench | About OverBench · **Check for Updates…** (opens Settings at About and checks there) · **Settings…** `Cmd+,` · Services · Hide, Hide Others, Show All · Quit OverBench |
| File      | **Open Project…** `Cmd+O` · **New Session** `Cmd+N` · Close Window                                                                                                    |
| Edit      | The standard roles, so undo, cut, copy, paste and select all work in every text field                                                                                 |
| View      | **Toggle Sidebar** `Cmd+B` · Reload and Toggle Developer Tools in development builds only · Enter Full Screen                                                         |
| Window    | The standard window menu                                                                                                                                              |

Menu commands that need a window open one if every window was closed; **Toggle Sidebar** does nothing without one. In development builds F12 also toggles DevTools on every platform.

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
- Markdown, Shiki and the diff renderer are loaded lazily the first time a session needs them; xterm.js and its addons the first time a terminal opens.
- Git status components select only the shown project's status, and pull request chips load their details when they first scroll into view.
