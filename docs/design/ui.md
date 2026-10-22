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
┌─────────────┬──────────────────────────────────────────┬──────────────────────────┐
│ ● ● ●     ◫ │ ✳ Fix flaky login ⌄             ⎇ fix ▣ │ ▣ zsh  ▣ pnpm ●  +   ⤢ × │  top bar · side panel header
├─────────────┤                                          │ ~/overbench $ pnpm test  │
│ ✎ New       │   ┌──────────────────────────────────┐   │  ✓ 42 passed             │
│ overbench + │   │ The login test fails on CI …     │   │  ✗ 1 failed              │  terminal
│  ✳ Fix fl 2 │   └──────────────────────────────────┘   │ ~/overbench $ █          │
│  ✳ Fix fla  │ I'll start by reading the test and …     │                          │  agent
│   ◇ Explore │ ┌ ✎ Edit src/auth/session.ts  +4 −3 ✓ ┐  │                          │  tools
│  ◎ Add da ↳1│ └─────────────────────────────────────┘  │                          │
│  ✳ Bump d ⊙ │ ⊙ Committed 3f2a1c1 fix(auth): read …    │                          │  git event
│ website › + │ ┌─────────────────────────────────────┐  │                          │
│             │ │ Ask Claude Code to…               ↑ │  │                          │  composer
│             │ └─────────────────────────────────────┘  │                          │
│ ⚙ Settings  │   Default ⌄          Opus 5.5 High ⌄ ◔   │                          │  control row
└─────────────┴──────────────────────────────────────────┴──────────────────────────┘
```

- Built with `ResizablePanelGroup`. The sidebar defaults to 260 px, resizes between 200 and 400 px, collapses with `Mod+B` through the panel's own collapse, sliding as the design system's [sidebar slide](./design-system.md#patterns) describes, and remembers its size per device. The width at collapse is saved too, so an app that starts collapsed expands back to it, not to the minimum. Collapsed, the handle takes no width, so no line shows at the window's edge.
- The sidebar sits on surface 0 and the thread on surface 1. The step between them is the only separation; the resize handle shows a hairline only while it is hovered or dragged.
- The thread is a single centred column of 42em of prose plus its 24 px gutters (`max-w-thread`, 678 px at the default 15 px), about 42 Chinese characters a line, so prose keeps a comfortable line length at any window width. Tool calls and diffs use the same column. The composer below keeps its own 760 px column.
- The **side panel** on the right of the main area holds one pane at a time: the [terminal](#terminal) or the [files](#files). It sits flush on surface 0, like the sidebar on the left, so the thread on surface 1 is framed by two quieter surfaces, each meeting it at a soft hairline ([one line per surface](./design-system.md#one-line-per-surface)). The layout follows the reference; the styling is OverBench's own. The thread column keeps the rest of the width and its own top bar. Each pane has a toggle at the right end of the top bar, as the reference's row of pane buttons: **Files** (`Folder`) and **Terminal** (`SquareTerminal`); the open pane's toggle is [pressed](./design-system.md#toggle-buttons). A toggle shows its pane, or closes the panel when its pane is shown, and the open pane is remembered per project. Each pane keeps its own width (the terminal 340 px by default, the files 560 px). The Changes panel arrives later as a third pane.

## Screens

### Welcome

Shown when there are no projects. A centred `Empty`: the OverBench wordmark, one line ("Open a project to start working with an agent."), the **Open project** button (`Mod+O`), and below it the three agents with their status, so a missing Node.js or agent is visible before the first session.

It sits on the plain `--background` surface, with nothing moving behind it. The content enters once, the wordmark first and each agent row 30 ms after the one before.

### New session

Opened by **New session** (`Mod+N`, also in the File menu) and by the **+** on a project's row in the sidebar. The screen assumes nothing from what was shown before: the top bar says "New session", the thread area holds one line ("What should Claude Code work on?"), and under a composer like the session's sit two menus in the control row, styled as the composer's own:

- **Project**: after the reference's folder menu, a [search menu](./design-system.md#menus-and-dialogs): a search field ("Search projects…") over **No project**, which starts the session in a [scratch folder](./session-model.md#sessions-without-a-project) of its own, then after a separator **Recent**, the projects by name alone, most recently opened first, then after a separator **Open project…**, which adds a folder and chooses it. A project whose folder name another shares adds, in `--muted-foreground`, the fewest parent folders that tell them apart; a missing one is disabled with "Missing"; the full path is the row's tooltip. Typing filters the projects by name and those folders, leaving **Open project…** in place, with "No matching projects" when none match. Only the projects scroll. It starts at the selected project, or at the one whose **+** opened the screen. With no projects yet the screen still opens, the menu holding only the search field, **No project** and **Open project…**.
- **Agent**: the agents with their marks, with no group label; one that is not installed is disabled with "Not installed". It starts at **Default agent** from Settings; with **Ask each time** none is chosen, and Send waits until one is.

The git status and the terminal toggle follow the chosen project. The chosen agent starts while the screen is shown, so a send waits for the session alone. The first send creates the session there and sends the message: the message shows at once as the first entry of the thread, with "Starting Claude Code…" ("Installing Claude Code…" while its adapter installs) and the latest output under it, and the session takes over once its thread is loaded, so no skeleton shows in between. Until the session exists the text is kept as a [draft](./persistence.md#composer-drafts), so nothing is lost when the start fails (**Back** returns here with the text) or the agent asks to sign in first (the session opens on its sign-in screen, with the text in its composer). Opening the screen again while it is shown keeps the agent you chose.

### Project home

Shown when you click a project's name in the sidebar, and after the shown session is closed or deleted. The three agents as large selectable cards (mark, name, version, status) to start a session. A hovered card rises 1 px, takes the `sm` shadow and lights up softly from its bottom edge, as the reference's starter cards do. The project's recent sessions are listed below. Like Welcome, it sits on the plain `--background` surface. **Import sessions** lists sessions the agents already have for this folder (`agents.listSessions`).

### Session

The thread and the composer, described below. The top bar shows the session title as a button whose menu holds **Rename…**, **New sub-session** (with a submenu of agents), **Close** and, after a separator, **Delete…** (in `--destructive`): the session's own items, one list shared with the sidebar row's context menu and **More** button, styled as in [menus](./design-system.md#menus-and-dialogs) ([session lifecycle](./session-model.md#session-lifecycle)). **Rename…** opens a dialog with the title selected; an empty title returns to the agent's ([titles](./session-model.md#titles)). Closing or deleting the shown session, or its parent, returns to the project home, and a closed session opens again from the sidebar with `session/load`. The agent's mark (14 px) leads the title inside the button, so the mark names the agent and its name is left out; a subagent's session leads with the `Bot` icon instead. The button's tooltip gives the full title and the agent. A sub-session's top bar starts with its parent's title as a link. On the right of the top bar sit the [git status](#git-in-the-top-bar) and the terminal toggle; Project home shows them too.

### Subagent

Opening a subagent ([sub-sessions](./session-model.md#sub-sessions)) shows its own thread: the parent's instructions first, as a quoted `session_message` entry labelled with the parent's title, then the subagent's work, including its permission requests. The agent drives it, so in place of the composer a bar reads "Claude Code runs this subagent for Fix flaky login test", with **Stop** when the agent allows it and **Back to** the parent.

### Settings

Opened from **Settings** in the sidebar footer or with `Mod+,`. Settings takes the whole window: the app sidebar goes away, and the top bar holds a **Back** button after the window controls that returns to where you were. `Esc` does the same when no field has focus. While a session waits for your approval, the Back button carries the `--attention` count, so the signal the sidebar gave is not lost.

Each section is a page of its own, as in the reference. A column on the left, on surface 0 like the app sidebar it replaces, holds the title, a search field (`Mod+F`) and the list of sections; the selected section takes the row fill, and choosing another replaces the page, which fades in over `--duration-fast` and starts at its top. Each section row is 32 px high, taller than a sidebar row as in the reference, and leads with a 16 px Lucide icon in `--muted-foreground` that takes the label's color on hover and when selected: `Settings` for General, `Palette` for Appearance, `Bot` for Agents, `SquareTerminal` for Terminal, `GitBranch` for Git, `Bell` for Notifications, `Keyboard` for Keyboard shortcuts, `Wrench` for Advanced and `Info` for About. The page is a column centred in the area beside the list, at most 560 px wide, so a short page sits in balance on a wide window instead of in its top left corner ([problem 40](../milestones/m0-feedback.md#40-the-settings-pages-look-crude-and-their-colours-are-untuned)). It opens with the section's name as its title (22 px, weight 600) and holds its rows on the page itself, with no card around them: a `--border-soft` hairline between rows, the text in line with the title, the name and a one-line description on the left, the control on the right (shadcn `Field` with `Switch`, `Select` or `ToggleGroup`). A row that reveals more, such as Proxy's fields or an update's progress, keeps the same first line and puts what it reveals underneath; Updates shows its status as the row's description, beside its action. Changes apply at once, with no Save button.

Search filters rows in every section by name and description, and by the row's English name in any interface language, so a search for proxy finds 代理. While you search, the page gives way to the results, grouped under their sections' names, and the list shows the number of matching rows next to each section; choosing a section clears the search and opens its page. `Esc` in the field clears it, then leaves it.

| Section            | Rows                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General            | **Language**: System, English or 简体中文, each named in its own language, switching at once ([localization](./localization.md)) · **Default agent** for New session (Ask each time, or one agent, each shown with its mark) · **Send with** Enter or `Mod+Enter`, the other key adding a newline · **Restore the last session on launch** · **Ask before quitting while agents or terminal commands are running**                              |
| Appearance         | **Theme**: System, Light or Dark, as three preview tiles · **Text size**: Small, Default or Large · **Reduce motion**: System or Always                                                                                                                                                                                                                                                                                                         |
| Agents             | A list of the agents, then a page per agent, as described [below](#settings--agents). Under the list: where and when the environment was read, and **Reload environment**                                                                                                                                                                                                                                                                       |
| Terminal           | **Shell**: the platform default, or a program picked with **Choose…** · **Font size**: 12, 13 or 14 px                                                                                                                                                                                                                                                                                                                                          |
| Git                | Whether `git` and the GitHub CLI were found and whether `gh` is signed in, with the command to run when it is not · **Fetch in the background** every 5 minutes                                                                                                                                                                                                                                                                                 |
| Notifications      | Shown only when no OverBench window is focused: **Needs approval**, **Turn finished**, **Errors**, **Play a sound** (the system notification sound), and **Show a count on the Dock icon** (the taskbar button on Windows; not shown on Linux, where desktops differ)                                                                                                                                                                           |
| Keyboard shortcuts | The [shortcuts](#keyboard), read-only, with the platform's modifier                                                                                                                                                                                                                                                                                                                                                                             |
| Advanced           | **Proxy** for agents, npm and updates: Use the environment, or Custom with a URL and a no-proxy list; choosing Custom opens the fields with the URL focused, and the setting changes once a valid URL is in · **Diagnostics**: Export diagnostics · **Data folder**: Show in Finder (Explorer, the file manager) · **Remove all sessions from OverBench**, which clears the index after a confirmation and leaves the agents' transcripts alone |
| About              | The version, with the Electron, Chromium and Node.js versions and **Copy**; the [update status](#updates) with its action and **Automatic updates**; links to the source code and the third-party notices                                                                                                                                                                                                                                       |

- The sign-in notice in the sidebar footer opens Settings at Agents, and **Check for Updates…** at About; opening Settings without a section shows the one shown last, or General.
- Settings shows only what M0 supports; there are no disabled placeholders for later features.
- The values and where they are kept: [persistence](./persistence.md#settings).

### Settings › Agents

The page scales to many agents: a list first, and a page of its own for each agent.

- **The list** groups the agents under **Installed** and **Not installed**, each with its count, in catalog order. Each agent is one row of up to three lines, and the whole row opens its page. The first line is the agent's tile and name with its own version in mono (for Claude Code and Codex the CLI their adapter runs, never the adapter's version), its state and a chevron on the right. The state is a dot with a word ("Sign in to start", "Installing…", "Failed"), except **Ready**, which asks nothing of the user and is the green dot alone, with "Ready" as its tooltip and accessible name; the project home's and the Welcome screen's agent cards show it the same way. The second is the account: the plan and the email, the email in a stronger color; else what the agent needs (install, sign in, the error), "Reading the account…", "Installs on first use", or, for an agent that names no account, its config folder. The third is the [plan limits](#usage-popover): up to two current windows, each with its percentage, the time left and a bar; "Reading plan usage…" while they are read; "Plan usage shows once it runs" for an agent that reports them but cannot run yet; "No plan usage reported" for one that has none. A row takes a `--muted` fill on hover. Settings search finds an agent's row by name or account.
- **Fresh on every visit**: whenever the list or an agent's page shows, `agents.refreshAccount` starts each installed agent that reports an account or plan limits (Claude Code, Codex) and reads them; an agent that would need an install first is left alone, and a started one stops after the usual idle time. Meanwhile the account and windows the agent last reported, kept by the agent host across runs ([persistence](./persistence.md#what-is-stored-and-where)), stand in.
- **An agent's page** starts with **‹ Agents**, back to the list, which `Esc` also does before it leaves Settings. The title is the agent's tile and name as a button that opens a searchable list of the agents (Base UI's `Combobox`, as in the project menu), each with its mark and state, so moving between agents needs no trip back. The agent's actions sit on the right of the title (**Retry**, the install link, **Sign out**), with the sign-in methods or the error under it. The page then holds four groups, each a heading over rows with hairlines between them:
  - **Account**: the version; the plan for a subscription account ("Claude Max", "ChatGPT Free"), else the login method ("Anthropic API key", a cloud provider, a gateway); and the email. "Not reported" until the agent says.
  - **Usage**: the plan limits as the usage popover shows them, without the plan and title above the windows, since Account names the plan; "Reading plan usage…" while they are read; **Check plan limits** for a stopped agent that can report them, which installs its adapter first when needed; otherwise a line saying the agent does not report plan usage.
  - **Configuration**: where the agent reads its own configuration ([agent configuration](./agent-host.md#agent-configuration)): the config folder, the settings file and the instructions file, each with its path in mono, the variable that moved it, and **Show in Finder** (Explorer, the file manager) when it exists, else "Not created yet". OpenCode adds **Program** with **Choose binary…**. This first version only shows these places; which settings each agent shows from them comes later.
  - **Advanced**, folded by default: the launch command with **Copy**, the adapter's package and version with **Reinstall**, and the Node.js version.

## Sidebar

- A **New session** row (`Mod+N`) at the top opens [New session](#new-session), and stays highlighted while it is shown.
- The projects follow **New session** with no header row above them. A project is added with `Mod+O`, File › Open Project…, **Open project…** in New session's project menu, or the Welcome screen.
- Projects are collapsible groups: folder name, with the full path in a tooltip. Clicking the name opens the [project home](#project-home). A fold chevron follows the name: a folded group always shows it (`ChevronRight`), an open one only while the row is hovered or has keyboard focus (`ChevronDown`), so the names line up at the sidebar's edge. Each project shows a **+** at the row's end at all times (shadcn's `SidebarMenuAction`), which opens New session in that project; a missing project has none.
- Sessions started with **No project** form a last group, **No project**, shown while it has any. It folds like a project's group and its **+**, shown on hover, opens New session with No project, but it has no home, so clicking its name only folds it. While one of its sessions is shown, `Mod+N` starts New session at No project.
- The sidebar's content is built from shadcn's `Sidebar` parts (`SidebarGroup`, `SidebarMenu`, `SidebarMenuButton` at `size="sm"`, which is 28 px, `SidebarMenuBadge`) with `collapsible="none"`, inside the `ResizablePanel` that owns its width. Rows have no border; hover and selection use the component's own fills, and a row keeps the hover fill while its context menu is open. The list scrolls behind [scroll-edge fades](./design-system.md#patterns), so rows fade out at the edges instead of being cut by the footer.
- Each row: the agent's [mark](./design-system.md#agent-marks) at 14 px, title (truncated), and one status indicator in a 16 px slot at the row's end, kept when the row has none so a status appearing never moves the title. Rows show no time. The indicator, in this order of priority:
  1. **Waiting for you** (`attention: 'permission'`): an `--attention` pill with the count. This is the loudest signal in the app.
  2. **Error** (`attention: 'error'`): a destructive `CircleAlert` icon, until the session has been in front of you ([attention](./session-model.md#how-the-host-keeps-sessions)).
  3. **Running** (`status: 'running'`): a dot with Tailwind's `animate-pulse`.
  4. **Starting** (`status: 'starting'`): a `Spinner` while the agent starts or the session loads.
  5. **Unread** (`attention: 'unread'`): a small neutral dot after a turn ended while you were elsewhere.
- Hovering a row, or focusing it from the keyboard, shows a **More** button (`Ellipsis`) over the indicator's slot, so the title keeps its width. It opens the same menu as a right-click, and so does the context menu key (`Shift+F10`) on a focused row.
- A session whose branch has a pull request shows its state icon after the title ([repository state](./design-system.md#repository-state)), as in the reference. Hovering the row shows the branch and the pull request in a tooltip.
- **Sub-sessions** ([session model](./session-model.md#sub-sessions)) sit under their parent, indented 16 px along a hairline `--border` guide line. A subagent shows the `Bot` icon with its title and, muted, its description ("Explore · Find where the tests read the clock"); a sub-session you started shows its agent's mark and title.
- A parent's mark turns into a chevron under the pointer, so rows stay aligned; the chevron folds and unfolds its sub-sessions, and so do `→` and `←` on the row. It expands by itself while a sub-session is running or waiting for you, and otherwise stays as you left it.
- A parent's indicator includes its sub-sessions: the attention count adds up their permission requests, and it shows Running while any of them runs, so a collapsed parent still says where to look.
- **New sub-session** is in the session's title menu and its row's menus. The row's context menu and **More** menu hold the same items as the title menu, from one definition: **Rename…**, **New sub-session**, **Close**, a separator, and **Delete…**, which asks first in an `AlertDialog`.
- Indicators always pair a color with a shape or label, never color alone. The one exception is an agent's **Ready** state ([Settings › Agents](#settings--agents)): the green dot alone, named by its tooltip and its accessible name.
- The sidebar list has one Tab stop; the arrow keys move between rows.
- The footer holds **Settings**, with no shortcut hint (`Mod+,` stays in the app menu and Settings › Keyboard shortcuts), and, above it, a tinted `--attention` notice when an agent needs sign-in ("Codex needs you to sign in"). The notice opens Settings at Agents and is hidden while that section is open. The [update notice](#updates) sits between the two.
- **Plan usage** sits directly above **Settings**: one chip per agent that has reported [plan limits](./session-model.md#plan-limits), in the agents' order, wrapping if they do not fit. A chip is 24 px high with 6 px padding, `rounded-md`, 12 px `tabular-nums` text: the agent's mark (13 px), the used percentage of its tightest window, and that window's reset countdown in `--muted-foreground` ("42m", "5h 12m", "1d 5h"). The tightest window is a reached one, else the fullest; a window whose reset time has passed is skipped, because its percentage predates the reset, and with no window left the chip shows "—". The percentage turns `--attention-text` at the warning state and `--destructive` when reached. Hover and an open popover fill the chip with `--sidebar-accent` over `--duration-fast`. A click opens a `Popover` above it, 320 px wide and aligned to its start, holding the same plan limits part as the [usage popover](#usage-popover). Countdowns follow the shared 30 s clock (`useNow`), so the strip runs no timer of its own. With no agent reporting limits, the strip is not shown; it lives in the sidebar, so it hides when the sidebar collapses. Each chip's label reads out the agent, window, percentage and countdown ("Claude Code plan usage: 5-hour 62%, resets in 2h 10m").
- Later, not in M0: pinned sessions with drag reordering, and grouping by status or date.

## Thread

The thread uses shadcn's `MessageScroller` with `autoScroll`: it follows new output, yields as soon as you scroll up, shows `MessageScrollerButton` to jump back, and fades both edges, so content no longer meets the top bar on a hard line. The bottom is shadcn's own `scroll-fade-b` in `MessageScrollerViewport`; the top is `scroll-fade-top-overlay`, a `--background` gradient drawn over the scroller whose opacity follows the scroll position, because a mask that fades the top made Chromium repaint the thread on every streamed chunk ([results](../perf/m0.md)). Focused from the keyboard, the thread shows an inset `--ring` ring drawn over the scroller, since the bottom fade would mask one on the viewport and an outer one would be clipped at the window's edge. The user message that starts the latest turn is the `scrollAnchor`, so a new turn opens with your prompt in view. Older turns are not anchors: when an update keeps the number of items, such as a reply replacing "Working…" or lookups merging into a group, `MessageScroller` scrolls to the first anchor it has not handled, and every anchor it mounted from history or remounted is one, so the view would jump back to the start of the thread. Opening a session lands at the bottom.

M0.3 compares its behavior with the reference's measurements: following within 40 px of the bottom, your own scroll winning over following for 150 ms, jump-to-latest beyond 120 px, and instant rather than smooth following. Where `MessageScroller` differs and offers no option, OverBench keeps its behavior and records the difference here; it never adds a second scroll hook.

Against `@shadcn/react` 0.3.1:

| Behavior        | Reference                      | OverBench                                                                                                       |
| --------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Following       | Within 40 px of the bottom     | The same, through `scrollEdgeThreshold={40}`                                                                    |
| Your scroll     | Wins over following for 150 ms | A wheel, touch or scroll key stops following at once, with no timer, and following picks up again at the bottom |
| Jump to latest  | Beyond 120 px                  | Beyond 40 px: the scroller uses one threshold for following and for the button                                  |
| Scroll behavior | Instant following              | Instant following; the jump button scrolls smoothly                                                             |

Turns are 32 px apart. Within a turn, a tool call or thought sits 16 px from a message, consecutive steps 4 px from each other, and the reply's action row 10 px under the reply.

| Entry           | Presentation                                                                                                                                                                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User            | `Message align="end"` with a `Bubble` in the `muted` variant, radius 14 px, padding 10 by 14 px, at most 85% of the column. Taller than 300 px, it collapses behind a fade and **Show more**. Under it, at its end, a row shown on hover or focus: when it was sent ("5 minutes ago", for messages sent in this run of the app) and **Copy** |
| Agent           | Plain prose without bubble, border or avatar, so long answers and code read like a document. Rendered with Streamdown. Its images follow inline; links and content OverBench cannot show follow as labelled chips                                                                                                                            |
| Thought         | Collapsed to one line: "Thinking" with shadcn's `shimmer` while streaming, "Thought for 12 s" afterwards. Expands as a `Collapsible` to muted text                                                                                                                                                                                           |
| Tool call       | A quiet row ([below](#tool-calls))                                                                                                                                                                                                                                                                                                           |
| Subagent        | A compact card with the `Bot` icon, the subagent's title and description, its status and, while it runs, its latest tool call. It opens the subagent                                                                                                                                                                                         |
| Session message | In a subagent's thread, the parent's instructions as a quoted block labelled with the parent's title                                                                                                                                                                                                                                         |
| Plan            | A checklist, which folds with the steps around it; the latest plan is also pinned above the composer as "Plan 3/5" and expands in place                                                                                                                                                                                                      |
| Notice          | An `Alert` in the matching variant                                                                                                                                                                                                                                                                                                           |
| Compaction      | A `Marker` ("Context compacted"), with the summary behind a disclosure                                                                                                                                                                                                                                                                       |
| Turn end        | A quiet `Marker`: "Worked for 2 m 13 s", or "Cancelled", "Stopped at the token limit", "Stopped at the request limit", "Declined". In a turn with a reply, it moves into the [reply row](#message-actions)                                                                                                                                   |
| Git event       | A muted line with its icon: `GitCommit` "Committed `3f2a1c1` fix(auth): read the clock once", `ArrowUp` "Pushed 2 commits to origin/fix/flaky-login", `GitBranch` "Switched to fix/flaky-login", or "Opened pull request" with its chip ([git events](./git.md#git-events-in-the-thread)). A commit id copies on click                       |

Between sending a prompt and the first output, a status line ("Working…") with `shimmer` sits where the reply will appear.

### Message actions

Every turn with a reply ends in one row, after its last entry, in place of its turn-end marker: **Copy** (every message of the turn's reply, as markdown), **Read aloud** (the same text through the system voice, without code blocks; **Stop** while it reads), and under the latest reply **Fork into a new session**, when the agent supports `session/fork`; then the turn-end text and when the reply began ("Worked for 1 m 9 s · just now"). The buttons are quiet `icon-xs` buttons with tooltips. The row is hidden under every reply, the latest one too, and shows while the pointer is over the reply, from the first entry after the user message to the row itself, or while it holds keyboard focus; it holds its place, so the text does not move. A turn from a replay has no end marker and no times, so its row holds the buttons only. The turn still running gets its row when it ends.

Fork copies the whole session, never a part of it: ACP's `session/fork` takes no message to fork at. Rewinding to a message and pinning are left for later.

### Markdown

- Streamdown in `streaming` mode, which splits the text into memoized blocks, with `parseIncompleteMarkdown` and the caret while the message streams. The mode never changes: `static` mode renders one tree, so switching to it when a message finishes would rebuild the whole message.
- Plugins: `@streamdown/code` for Shiki highlighting, with a light and a dark theme matched to the app's tokens, and `@streamdown/cjk` so emphasis and line breaking work around Chinese, Japanese and Korean text.
- `skipHtml` is on: agent output never renders raw HTML. Links pass through Streamdown's link safety and open in the system browser. A GitHub pull request URL renders as a [pull request chip](#pull-requests) instead of a plain link.
- **File references**: inline code or a link that names a file of the session's project is a chip that opens that file in the [Files](#files) pane, at the line when it gives one. Recognised forms: a relative path (`src/x.ts`, `./src/x.ts`), a path with a line (`src/x.ts:12`, `src/x.ts:12:5`, `src/x.ts#L12`), and an absolute path inside the project. Only paths in the project's file list count, so an identifier in backticks stays plain code. The chip shows the file's [type icon](./design-system.md#file-icons) at 12 px and its name, with `:12` after it for a line and the full path as its tooltip, so a file and a web link are told apart at a glance. A link to a local path that is not a project file shows its text alone. Link hardening blocks relative links, so a remark plugin (`local-links.ts`) carries a local link's target in a `#local:` fragment past it.
- **Typography**: [Design system: prose](./design-system.md#prose) has the measurements, the typography spec of [problem 43](../milestones/m0-feedback.md#43-the-message-body-needs-a-typography-pass-to-a-given-spec). Emphasis in Chinese text is a step of weight instead of italics.
- Code blocks are Streamdown's, with its copy button in a 32 px header beside the language.
- Images in agent messages render only from `data:` URLs; the CSP blocks remote images.

### Tool calls

```text
 ✎  Edit  src/auth/login.test.ts                           +12 −3   ✓
    ┌──────────────────────────────────────────────────────────────┐
    │  (the diff, when the row is opened)                          │
    └──────────────────────────────────────────────────────────────┘
```

- **Row**: tool calls are records, never bordered cards, so they weigh clearly less than the answer. A tool call is a 24 px row at 13 px in `--muted-foreground`, reaching 6 px past the column on each side so its icon lines up with the prose; when it has details, the row is the toggle of a `Collapsible` and takes the `--accent` fill on hover. The details open under it, indented to the text: the command, the output and the diff, which is framed like a code block. Only a request for permission keeps a card ([below](#permission-requests)).
- **Row content**: the kind icon (14 px, swapped for the chevron under the pointer), the verb, the path or command, a summary on the right (diff stats in `tabular-nums`, the permission answer) and the status:
  - `pending`: a hollow circle.
  - `in_progress`: a spinner.
  - `completed`: a check in `--success` that fades in.
  - `failed`: a destructive cross, and the row opens to show why.
- **Kind icons** (Lucide): `read` FileText, `edit` FilePen, `delete` Trash2, `move` ArrowRightLeft, `search` Search, `execute` SquareTerminal, `think` Brain, `fetch` Globe, `switch_mode` Repeat, `other` Wrench.
- **Paths and commands** are monospace, middle-truncated so the file name stays visible, with the full value in a tooltip.
- **Content**: markdown through Streamdown, finished from the start; diffs through `@pierre/diffs` `MultiFileDiff` in `unified` style with wrapping, at most 480 px high with **Show full diff**.
- **Folding a run**: two or more steps of the agent's work between messages (thoughts, tool calls, plan updates and compactions) fold into one 13 px `--muted-foreground` line, led by a 12 px chevron and taking the `--accent` fill and a 6 px radius on hover, that says what they did, one part per kind in the order it first appears: "Thought for 8 s, ran 3 commands, read 2 files, edited ui.md +3 −0, updated the plan ›". A single file is named, more are counted; the edits' diff stats follow their part, failures add "1 failed" in `--destructive`, and a step still running adds a spinner. The line expands, as a disclosure, to the steps beside a 1 px `--border` rule, 6 px in and 14 px from the steps. Messages never fold: what the agent says to you stays in view, as in the reference, and only the work between two messages folds. A subagent, a notice or a git event ends a run, since each is something to see or act on; a single step stays as it is. The run a turn is still adding to shows step by step and folds once a message or the turn's end follows it, so the current work stays in view. A step waiting for permission holds its run open.
- **Progress notes**: Codex writes short notes before its tool calls ("Checking the build scripts next") and marks them `commentary`, apart from its `final_answer`, but codex-acp passes the mark to JetBrains AIR clients only. So for an agent the catalog marks with `progressNotes`, today Codex, a message that more work in its turn follows counts as a note, since Codex ends a turn with its answer: it folds with the work around it, in the run, as a 13 px `--muted-foreground` paragraph, and the turn reads as one run above its answer. The answer is the turn's last messages, and Copy and Read aloud take only those. While the turn runs, its notes show as they stream and its work does not fold, since a message still streaming may be a note; when it ends, everything before the answer folds.
- **Grouping**: inside a run, consecutive completed `read`, `search` and `fetch` calls collapse into one row, "Explored 4 files" or "Searched 3 times", which expands to the individual calls.
- **Defaults**: running rows and requests waiting for permission are open; completed rows are collapsed.

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
- **Text**: `InputGroupTextarea`, which grows with `field-sizing: content`, from `--composer-min` up to `min(40svh, 24rem)`, then scrolls. Typing at the end of a long draft keeps it scrolled to the bottom, padding included, because a textarea scrolls only the caret into view and would leave the last line on the edge. The placeholder is "Ask <agent> to…".
- **Send button**: a 28 px round `InputGroupButton` at the end of the last line; `--primary` when there is text, `--muted` and disabled when empty.
- **Control row**: a `--row-height` row under the box, outside it, built from `config`. On the left, the mode selector. On the right, one model button that shows the model and, when the agent offers `thought_level`, the reasoning level after it ("Opus 5.5 High"); then the usage ring. The controls are ghost buttons at `--control-height` in `--muted-foreground`; the model name is `--foreground`. For a `provider/model` name, such as OpenCode's `opencode-go/GLM-5.3`, the button shows only the model part, with the full name in its tooltip. Any other `select` option gets its own button in the row, placed by `category`; its menu closes once a choice is made.
- **Model menu**: one 320 px menu (`w-80`) for the model, the reasoning level and the boolean options, so a model and its level are set together. Choosing a model closes it, whether by a click, `Enter` or `1` to `4` for the first four models. The reasoning level, which `←` and `→` step, and the switches keep it open, so a level and options can be set in one visit; `Esc` or a click outside closes it. The model list comes first under its option's name, the current model checked; each row shows the model's name and, when the agent gives one, its description in muted text, and a `provider/` prefix in `--muted-foreground`. A long list, such as OpenCode's dozens of models, scrolls by itself within 288 px (`max-h-72`) with [scroll-edge fades](./design-system.md#patterns), and opens scrolled to the current model, so the reasoning level below it stays in view. The boolean options follow as switches, after a separator.
- **Reasoning level**: the levels are ordered and one is always chosen, so up to six of them show as a [segmented control](./design-system.md#segmented-controls) under a row with the option's name. The control spans the menu's full content width, like the rows above it, with 6 px of padding inside each segment; more than six levels fall back to a list like the models'. A choice named Default leaves the level to the agent, so it is one of the levels in effect and gets no segment: while it stands, the thumb rests on the level its name or description names ("Default (High)"), or on none when the agent does not say, and the row shows "Default" on the right; once a level is set by hand, a reset button (`RotateCcw`, "Use the agent's default") takes its place. The model button leaves a Default level out. A click on a level chooses it. Pressing captures the pointer: while pressed, the thumb snaps segment by segment under the pointer and shrinks to 97%, and the label and the thumb's tier styles follow it; the segment under the pointer is chosen on release, so the agent gets one request. The thumb slides with `translate` over `--duration-base` and `--ease-out-quart`, and moves at once with reduce motion. The top levels are recognised by name, compared without case or dashes: **Xhigh**, Extra high and Very high are the high tier, **Max**, Maximum, Ultra, Ultrathink and Ultracode the max tier. A chosen high-tier level shows its name in a warm gradient (`text-effort-high`); the max tier takes a wider gradient (`text-effort-max`), a tinted ring on the thumb (`shadow-effort-max`), and one sheen that sweeps across the thumb when it lands there ([reasoning levels](./design-system.md#reasoning-levels)). The model button shows the level's name with the same gradient, so a costly level is visible without opening the menu.
- **Ultracode**: a switch after Fast mode in the model menu, for Claude Code sessions whose reasoning level offers the high tier (`xhigh`), since ultracode needs it; it also shows while on. It turns on, for the session, a dynamic workflow on every substantial task, and restarts Claude Code to do it, so it changes only between turns: during a turn it is disabled and says "Changes between turns". While it is on, the control row shows **Ultracode** in the max tier's gradient before the model button ("Ultracode is on for this session"). A message that says `ultracode` still turns it on for that message alone, and the same label shows while such a draft is written ([session model](./session-model.md#config-options)).
- **Picks show at once**: a chosen model or level shows immediately. The agent's own value arrives with the session's next patch, after the request has settled, so the pick stands until that value lands, the request fails (the error shows in the control row and the old value returns), or 1.5 s pass.
- **Sending**: **Enter** sends and **Shift+Enter** inserts a newline.
- **IME**: Enter never sends while an IME composition is in progress (`isComposing`, or `keyCode` 229), so Chinese, Japanese and Korean input works. The reference also drops an Enter that arrives within 500 ms after `compositionend`, a guard for WebKit. M0.3 tests Pinyin and Japanese input on all three platforms (the macOS input sources, Microsoft Pinyin and IME, fcitx5) and adds such a guard only where a test shows it is needed, with the shortest window that passes.
- **Drafts**: unsent text is kept per session and restored when you come back, also after a restart; sending clears it ([persistence](./persistence.md)).
- **Slash commands**: `/` at the start opens a `Command` popover with the agent's `available_commands_update` list, filtered as you type; choosing one inserts `/name ` and shows its input hint.
- While a turn runs, the send button becomes a round **Stop** and `Esc` cancels the turn. A message written meanwhile is either queued or steered:
  - **Queue** (the send key, or the `ListPlus` button that appears beside **Stop** while there is text): the message waits in the queue and is sent when the turn ends.
  - **Steer** (`Mod+Enter`, or `Mod+Shift+Enter` when `Mod+Enter` sends): the message goes into the running turn, for an agent that supports it, and shows in the thread with a muted `CornerDownRight` "Steered" label under the bubble. Claude Code supports it; Codex and OpenCode only queue ([session model](./session-model.md#queue-and-steering)).
  - The placeholder says which: "Queue a message, or steer with ⌘↩", or "Queue a message for when the turn ends".
- **Queue tray**: above the composer, on the plan bar's surface, while anything waits: "Queued 2" with "Sent when the turn ends", then one row per message, oldest first, each with **Steer now** (where steering is supported and a turn runs), **Edit in the composer**, which moves the text back into the draft, and **Remove**. After **Stop**, a failed turn or a restart the queue is paused: the tray says "Paused until you resume" with **Resume**. Sending while the session is idle goes at once, beside a paused queue.
- While a permission request is pending, the placeholder reads "Waiting for your approval" and the send button is disabled.
- While the agent is starting, the text area is disabled and the control row is hidden, because the config options are not known yet.
- **Usage**: a 16 px pie inside a thin ring showing `used / size` of the context, alone at first; a filling wedge, unlike a short arc, never reads as a spinner. From 80% it turns `--attention` and shows the percentage next to it. When a plan limit of the agent's account reaches its warning state, its window and percentage appear in front of the ring in `--attention` ("5h 92%"); once a limit is reached, the composer's placeholder says when it resets. A click opens the [usage popover](#usage-popover).

### Usage popover

```text
┌──────────────────────────────────────────────┐
│ Context                                  84% │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────│
│ 215k of 256k tokens · 41k left               │
│ System prompt                    4.6k   0.8% │
│ Messages                        160k   62.5% │
│ Free space                        8k    3.1% │
│ › MCP Tools 8                                │
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
- **What fills the context**, for Claude Code: opening the popover while no turn runs reads the [context breakdown](./session-model.md#context-breakdown), which shows one row per category (name, tokens, share of the window) under the token line, then each list the report has (MCP tools, memory files, skills) as a `Collapsible` with its count. `Skeleton` rows stand in until the first one arrives; a later read dims the rows it replaces; a failure says so in one line. The breakdown is kept until the session's context changes. This is the existing layout with rows added; the popover's redesign is [problem 7](../milestones/m0-feedback.md#7-the-usage-popover-shows-too-little-and-needs-a-full-redesign).
- **Plan limits**, for the agent's account: the plan label from the agent ("Claude Max"), then one row per window the agent has reported ([plan limits](./session-model.md#plan-limits)), which opening the popover reads afresh from the agent's report (Claude Code's `/usage`, Codex's `/status`): label, a bar, the percentage in `tabular-nums`, and the reset time (the clock time today, the weekday within six days, the date beyond, the full time in a tooltip). Bars at the warning state turn `--attention`, and a reached limit `--destructive`. "Updated 3 min ago" tells how fresh the numbers are.
- Agents that report no plan limits, today OpenCode, show the Context part only; an API key account shows its label without bars.
- Settings › Agents shows the same plan windows in its list and on each agent's page, read afresh whenever they show, starting the agent if it is installed ([Settings › Agents](#settings--agents)). Until the read is back, the windows last reported, kept across runs, stand in.

## Git in the top bar

The right side of the top bar shows the project's repository at a glance. Everything comes from the [git service](./git.md#repository-status) and updates as the agent, the terminal or any other tool changes the repository.

```text
⎇ fix/flaky-login  ⇡2 ⇣1  ±3   ⊙ #42 ✓
```

- **Branch**: `GitBranch` and the branch name in monospace, middle-truncated at 200 px. A detached `HEAD` shows the short commit id; an unborn branch shows its name and "no commits".
- **Sync**: `ArrowUp` with the number of commits not pushed, in `--foreground`; `ArrowDown` with the number behind the upstream, in `--muted-foreground`. In sync, nothing shows. A branch with no upstream shows `CloudUpload` and "Not published".
- **Crowded top bar**: the top bar is a container (`@container/top-bar`), so it adapts to its own width, not the window's. The session title keeps priority at every width: the git status shrinks a thousand times faster (`shrink-1000`), so the branch name truncates first, then the status gives way down to its branch icon, and only then does the title truncate, with its full text in the title button's tooltip. The branch name takes at most a quarter of the bar (`25cqw`), and 96 px below 520 px; "Not published" keeps only its icon below 720 px. The pane toggles always stay.
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
│ Fetched 12 min ago                     Fetch   │
└────────────────────────────────────────────────┘
```

- A shadcn `Popover`, 360 px wide.
- **Header**: the branch name (monospace, wrapping rather than truncating) with a copy button, and under it the base and the upstream.
- **Branch lane**: a small SVG drawing of the branch against its base. The top line is the base branch; dots after the fork point are the base's new commits, labelled with how far behind the branch is. The lower line is the branch: filled dots for pushed commits, `--foreground` rings for commits not pushed, and a dashed ring at the tip when the working tree has changes. A small tick marks the upstream's position. More than eight commits collapse into a gap with their count. The lane has a text alternative that says the same in words ("5 commits ahead of main, 2 not pushed, 3 behind").
- **Commits**: the branch's newest commits, five at first and up to twenty with a scroll: id in monospace, subject, relative time, and `ArrowUp` on those not pushed.
- **Working tree**: files changed with added and removed lines in `tabular-nums`, then the staged, untracked and conflicted counts.
- **Pull request**: state icon and title, number, base, checks summary and review state, and **Open on GitHub**. A published branch without one offers **Create pull request**, which opens GitHub's compare page in the browser. Without `gh`, a muted line says "Install the GitHub CLI to see pull requests"; signed out, it shows `gh auth login` with a copy button.
- **Footer**: when the remote was last fetched, and **Fetch** (a spinner while it runs, git's message inline if it fails). A terminal opens from the top bar's toggle only.

### Pull requests

- **Chips** in agent text and tool output: `--muted` fill, `--border-soft` ring, the state icon, `owner/repo#42` and the title truncated after 40 characters. Hover shows a `HoverCard` with the title, state, branches, checks, review state and when it was updated; a click opens the pull request in the browser. Without `gh`, the chip shows the neutral `GitPullRequest` icon and the number, and still opens the link.
- **Sidebar**: the badge on a session's row, described in [sidebar](#sidebar).
- **Top bar**: the current branch's chip, above.

## Files

The Files pane, in the side panel, shows the project's files beside the one that is open, as the reference's Files pane does. The agent host lists, reads and searches them ([project files](./agent-host.md#project-files)); the renderer has no file system access.

```text
┬──────────────────────────────────────────────────────────┐
│ ⌕ Filter, or ? to search in files           ☰   ⤢   ×    │  header, 40 px, a drag region
├──────────────────┬───────────────────────────────────────┤
│ › docs           │ session.ts  src/agent-host     ⧉  ×   │  the open file
│ ⌄ src            │   1  import { randomUUID } from …     │
│   › agent-host   │   2  …                                │  highlighted, line marked
│     index.ts     │                                       │
└──────────────────┴───────────────────────────────────────┘
```

- **Header**: **Hide the file list** (`FolderTree` at 15 px, as the top bar's `Folder` toggle; not `PanelLeft`, which would repeat the sidebar toggle at the window's other side), the filter field, then **Show as a list** / **Show as a tree** (`List`, `ListTree`), **Maximize** and **Close**, as the terminal's header. Maximized with the sidebar collapsed, it starts with the sidebar toggle, as the terminal does.
- **Hiding the list**: to read a file undisturbed, the list folds away and the preview takes the pane's width; the header keeps only **Show the file list**, the same button, **Maximize** and **Close**. Dragging the divider past the list's 160 px minimum folds it too, and dragging it back opens it. The pane's saved layout keeps it folded.
- **Tree**: folders first, then files, by name; folders start closed. Each row shows its [file type icon](./design-system.md#file-icons), a folder's open or closed by its state. Opening a file from the conversation opens its folders and scrolls it into view. Rows are `--row-height` and virtualized, so a project of 50,000 files scrolls like a small one. **Show as a list** lists every path instead.
- **Filter**: typing filters the paths by their characters in order, ignoring case, the best match first (as fzf's first algorithm: consecutive characters, word starts and the file name count for more); the matched characters of the name are marked, the folder follows in `--muted-foreground`. Up to 1,000 matches show, with a count of the rest. `Esc` clears it.
- **Search**: a filter starting with `?` searches the files' text instead (literal, ignoring case, 250 ms after the last keystroke), listing each file with its matching lines, the line number and the match marked; a line opens the file there.
- **Preview**: "Open files appear here" until a file is picked. An open file shows its type icon, name and folder above the text, with **Copy path** and **Close file**, and the text highlighted by the diffs library's `File` on the shared worker pool, virtualized, with the referenced line marked and centred. Long lines wrap inside the pane; a wrapped line keeps one number, on its first row. A Markdown file shows rendered, through the thread's Streamdown in a 42em column, with **Show source** (`Code`) in the header, and **Show preview** (`BookOpen`) back; the choice holds for every Markdown file until changed, and a reference to a line opens the source at it. Images in the file do not load: the CSP blocks remote ones and local ones have no route yet. An image (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) shows centred at its own size, fitted to the pane when larger, over `--checker` squares that show its transparency, with a hairline edge, and its pixel size and file size under it ("1920 × 1080 · 66.6 kB"); one that does not decode says so. A binary file, a file over 1 MB (10 MB for an image) and one that cannot be read show an `Empty` state saying so.
- **Freshness**: the list and the open file reload when the project's git status changes, which follows edits on disk, and when the window gains focus.
- The tree and the preview split the pane with a resize handle; the tree defaults to 220 px.

## Terminal

The built-in [terminal](./terminal.md) opens in the side panel, on the right of the main area. The placement follows the reference; the panel itself follows OverBench's surfaces.

```text
┬───────────────────────────────────┐
│ ▣ zsh  ▣ pnpm dev ●  +       ⤢  × │  header, 40 px, in line with the top bar
│ ~/overbench (fix/flaky-login) $   │
│ pnpm test --filter auth           │
│  ✓ login.test.ts (12)             │
│  ✗ session.test.ts (1)            │
│ ~/overbench (fix/flaky-login) $ █ │
┴───────────────────────────────────┘
```

- **Opening**: `` Ctrl+` `` on every platform, as in VS Code, or the `SquareTerminal` toggle at the right of the top bar, which shows a pressed state while the panel is open. The first time in a project it starts a terminal in the project folder and focuses it; later it shows the terminals that already exist.
- **Panel**: flush with the window's top, right and bottom edges on surface 0 (`--sidebar`), mirroring the sidebar on the left, with no ring, inset or shadow ([terminal tokens](./design-system.md#terminal)). It sits in a `ResizablePanel` with `groupResizeBehavior` `preserve-pixel-size`, so it keeps its width when the window or the sidebar changes: 340 px by default and at least 280 px, while the content beside it never gets less than 360 px. The width is remembered per device. The resize handle shows a hairline only while hovered or dragged, like the sidebar's. Opening fades the panel in over `--duration-fast` and gives the content its new width at once; closing is immediate.
- **Header**: 40 px (`--top-bar`), so it lines up with the top bar and, on macOS, the traffic lights, and it is part of the window's drag region. On Windows and Linux the panel, not the top bar, reaches the window's right edge, so its header leaves room for the window controls there and the top bar beside it drops its own (`SidePanelContext`).
- **Tabs**: in the header, from its left edge. Each tab is 24 px high with the `SquareTerminal` icon and the title of its foreground process, or the name you gave it; the active tab is raised like a segmented control's thumb (`--segment-thumb` with `shadow-segment`), and a hovered one takes the flat `--sidebar-accent` fill, so the two never look alike and neither changes the tab's width. A tab is at most 192 px wide; when the header runs short, as it does beside the window controls on Windows and Linux, tabs shrink to 80 px with their titles truncated and their close buttons kept, and only then does the row scroll. A tab that printed while hidden shows a neutral dot, and one whose shell exited shows its exit code. **New terminal** (`+`, `` Ctrl+Shift+` ``) follows the last tab, as in the reference.
- **Renaming and reordering a tab**: double-clicking a tab, or **Rename** in its context menu (with **Close**), turns its label into a field; `Enter` or leaving the field keeps the name, `Esc` cancels, and an empty name returns to the process's title, which a renamed tab keeps in its tooltip. Tabs reorder by dragging (`@dnd-kit/react` sortable, moving by `transform` only), starting after 5 px of travel or a 200 ms hold so a click still selects and a double click still renames; from the keyboard, `Space` picks a focused tab up, the arrow keys move it and `Space` or `Enter` drops it. Names and order live in the renderer for the app's run, since terminals do not survive a restart. On the right: **Maximize** (`Maximize2`) and **Close** (`X`, `` Ctrl+` ``), which hides the panel and keeps the processes running. The header is a window drag region like the top bar, so the tabs and its buttons are `app-region-no-drag`.
- **Maximize** covers the whole main area with the panel, as a layer over the layout, which keeps its sizes underneath, so **Restore** (`Minimize2`) returns to exactly the widths before. The content under it keeps its state but is inert and not rendered (`content-visibility: hidden`). With the sidebar collapsed, the header is then the window's top left corner: it starts with the sidebar toggle and, on macOS, leaves the same room for the traffic lights as the top bar.
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

- Below it, **Automatic updates**: Download and install, Notify only, or Off ([checking and downloading](./updates.md#checking-and-downloading)). A `Select`, since the labels are too long to sit side by side as segments.
- On macOS the app menu has **Check for Updates…** under OverBench. It opens Settings at About and checks there instead of showing a dialog.

## States

| Situation             | What the user sees                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent installing      | "Installing Claude Code…" in place of "Starting…", with npm's latest output lines, the first time a pinned adapter version is used ([installing adapters](./agent-host.md#installing-adapters))                                                                                                                                                                                                      |
| Agent starting        | Thread skeleton, "Starting Codex…", and the agent's latest stderr lines; while a session opens, in the composer's frame (below)                                                                                                                                                                                                                                                                      |
| Loading history       | The thread skeleton, a message and a reply at their real sizes, fading in after 200 ms so a quick load shows nothing; the composer's frame stands in place with a spinner and "Starting Codex…" where the prompt goes, then "Loading the conversation…" until the `session/load` replay ends, and the agent's latest stderr line under it in mono; the composer then takes its place without a shift |
| New, empty session    | One quiet line: "What should Claude Code work on?"                                                                                                                                                                                                                                                                                                                                                   |
| Sign-in needed        | `Empty` with the agent's sign-in methods ([agent host](./agent-host.md#sign-in)); in a session with history, an `Alert` above the composer with **Retry** and **Sign in…**, which opens Settings at Agents; signing in there resumes the session                                                                                                                                                     |
| Disconnected          | An `Alert` above the composer: "Codex stopped unexpectedly. Reconnecting…", then **Reconnect** if it fails                                                                                                                                                                                                                                                                                           |
| Failed                | The error and its detail, with **Retry** and **Export diagnostics**                                                                                                                                                                                                                                                                                                                                  |
| Agent host restarting | A small status pill floating over the centre of the top bar, so it never pushes the window down or meets the traffic lights; everything comes back by itself. If the host cannot restart, the pill says so, with **Restart** and **Export diagnostics**                                                                                                                                              |

Every one of these exists in light and dark themes before M0.3 is done.

## Motion

Each element uses a pattern from the [design system](./design-system.md#patterns):

| Element                                                          | Motion                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| New entry                                                        | New entry                                                                                    |
| Thoughts, tool cards, grouped rows, long user messages, the plan | Disclosure                                                                                   |
| Tool status change                                               | Icon crossfade, `--duration-fast`                                                            |
| Status text in a tool header or the composer                     | Status text                                                                                  |
| Permission request appears                                       | Attention: one pulse, never looping                                                          |
| Waiting for the first output                                     | Thinking, waiting                                                                            |
| Running session in the sidebar                                   | Running                                                                                      |
| Buttons                                                          | Press                                                                                        |
| Agent cards on Project home                                      | Card hover                                                                                   |
| Welcome content and Project home cards on first show             | Staggered entry                                                                              |
| Expanding a parent session in the sidebar                        | Disclosure                                                                                   |
| Git event in the thread                                          | New entry                                                                                    |
| Counts in the git status and the usage ring                      | Status text                                                                                  |
| Side panel                                                       | Fades in over `--duration-fast`; closes at once                                              |
| Collapsing and expanding the sidebar                             | Sidebar slide                                                                                |
| Copying code                                                     | Copy feedback                                                                                |
| Update notice appears                                            | New entry                                                                                    |
| Dismissed alerts and banners                                     | Motion exit: opacity, `--duration-fast`                                                      |
| Menus                                                            | Fade and zoom from 95% at the anchor, 100 ms, without a slide                                |
| Popovers and dialogs                                             | shadcn's built-in transitions                                                                |
| Segmented control thumb                                          | Slides with `translate`, `--duration-base`, `--ease-out-quart`; shrinks to 97% while pressed |
| The highest reasoning level chosen                               | Sheen: one sweep across the thumb, `--duration-slower`                                       |

- Never animate the layout of the whole thread while it streams; only the entry that changed may move.
- Entries restored from history or a snapshot appear without animation.
- With reduce-motion on, movement is removed and only opacity and color changes remain ([reduce motion](./design-system.md#reduce-motion)).

## Keyboard

`Mod` is `Cmd` on macOS and `Ctrl` on Windows and Linux.

| Shortcut                            | Action                                 |
| ----------------------------------- | -------------------------------------- |
| `Mod+O`                             | Open project                           |
| `Mod+N`                             | New session                            |
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

Every item carries its label in the interface language, roles included, and the menu is rebuilt when the language changes ([localization](./localization.md#switching)). Menu commands that need a window open one if every window was closed; **Toggle Sidebar** does nothing without one. In development builds F12 also toggles DevTools on every platform.

## Accessibility

- Every control is reachable by keyboard, with a visible focus ring. Lists that act as one control use roving focus.
- An `aria-live="polite"` region announces turn ends and permission requests.
- Icon-only buttons have labels; status is never conveyed by color alone.
- Contrast meets WCAG AA in both themes, including `--muted-foreground` on surface 0, the lowest-contrast pairing.

## Performance rules for components

- Entry components are memoized and select only their own entry from the store.
- Streamdown stays in `streaming` mode, so a finished message keeps its rendered blocks. Props it reads through context, such as `controls`, are module constants: a new object per render would re-render every code block and table on each chunk.
- A message longer than 8,000 characters renders in chunks that end on block boundaries (`markdown/chunks.ts`), each a Streamdown of its own inside one `.markdown`: settled chunks never re-render, and only the live tail does, so a streamed update costs the tail instead of the whole message. A text with footnotes or link definitions stays whole, as Streamdown keeps it. Margins collapse through the chunks, so a chunked message is pixel-identical to an unchunked one. On a 200 KB reply, frames while streaming went from 25 to 10 ms at p95 (fake agent, production build, 2026-10-21; [results](../perf/m0.md)).
- Diff highlighting runs in `@pierre/diffs`' worker pool (`WorkerPoolContextProvider`), off the main thread.
- A thread renders from its end: the first frame mounts its last 40 items, and older ones follow in transitions on the next frames, doubling the shown count each time (80, 160, 320, …), which MessageScroller keeps in place as they are prepended. Each prepend lays the thread out again, so doubling keeps the passes logarithmic in the thread's length. Switching to a session with 1,000 entries paints in about 35 ms instead of 260 ms.
- Every `Clamp` (long user messages, long diffs) is measured by one shared `ResizeObserver`, whose callback reads all changed heights while the layout is clean and commits them in one synchronous render before paint, so a clamped block is never painted unclamped first. Measuring in each `Clamp`'s layout effect laid the whole thread out once per commit. Switching back to a cached 4,000-entry session settled in 4.5 s with 28 frames over 50 ms before these two changes, and in 0.9 to 1.0 s with one or two after them (fake agent, production build, 2026-10-21).
- Thread items use `content-visibility: auto` with an intrinsic size estimate, except the last one: while it grows it would flip between skipped and rendered on every chunk, recalculating its whole subtree each time.
- Micro-interactions and looping indicators are CSS; no component re-renders to animate.
- Markdown, Shiki and the diff renderer are loaded lazily the first time a session needs them; xterm.js and its addons the first time a terminal opens.
- Git status components select only the shown project's status, and pull request chips load their details when they first scroll into view.
