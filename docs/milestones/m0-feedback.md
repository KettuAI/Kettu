# M0 acceptance feedback

> Status: Collecting · [M0](./m0.md) · [All docs](../README.md)

Problems the maintainer found while using M0 by hand. Each one is recorded as reported, with where it lives today; fixes are planned together once the list is complete, and the design docs change with them.

| #   | Problem                                                        | Area           | Status       |
| --- | -------------------------------------------------------------- | -------------- | ------------ |
| 1   | Thoughts and tool calls cannot be folded together              | Thread entries | Fixed        |
| 2   | Choosing a model does not close the model menu                 | Model menu     | Fixed        |
| 3   | No switch for Claude Code's ultracode                          | Model menu     | Fixed        |
| 4   | The model menu does not look polished                          | Model menu     | Partly fixed |
| 5   | Messages have no action row                                    | Thread entries | Fixed        |
| 6   | Markdown looks plain and file references do not stand out      | Markdown       | Partly fixed |
| 7   | The usage popover shows too little and needs a full redesign   | Usage          | Partly fixed |
| 8   | Session rows show their time badly                             | Sidebar        | Open         |
| 9   | New session is tied to the selected project                    | Sidebar        | Fixed        |
| 10  | The welcome screen and the project home lack polish            | Home           | Open         |
| 11  | No steering or queued messages while a turn runs               | Composer       | Fixed        |
| 12  | Switching sessions visibly stalls                              | Performance    | Partly fixed |
| 13  | The git popover only displays, and repeats the terminal toggle | Git            | Partly fixed |
| 14  | The terminal panel's own buttons do nothing                    | Terminal       | Fixed        |
| 15  | Settings selects show names only and keep the default look     | Settings       | Fixed        |
| 16  | Switches keep shadcn's default look                            | Settings       | Fixed        |
| 17  | Settings › Agents leaves out what matters                      | Settings       | Partly fixed |
| 18  | The About page needs redoing                                   | Settings       | Open         |
| 19  | Settings leave too much empty space                            | Settings       | Open         |
| 20  | Collapsing the sidebar is abrupt                               | Sidebar        | Fixed        |
| 21  | No file browser or preview                                     | Side panel     | Fixed        |
| 22  | The New session project and agent menus look crude             | New session    | Fixed        |
| 23  | The project chevron sits before the name and always shows      | Sidebar        | Open         |
| 24  | The Projects header row can go; each project gets a +          | Sidebar        | Open         |
| 25  | The sidebar footer needs a design of its own                   | Sidebar        | Open         |
| 26  | Account details cannot be hidden                               | Settings       | Open         |
| 27  | Agent adapters have no update check or one-click update        | Agents         | Open         |
| 28  | The Ready label next to the status dot is redundant            | Settings       | Open         |
| 29  | Agents that are not installed cannot be installed from here    | Settings       | Open         |
| 30  | The session context menu lacks rename, pin and archive         | Sidebar        | Open         |
| 31  | Earlier replies show actions only on hover, and no Fork        | Thread entries | Open         |
| 32  | No message outline beside the thread, expanding on hover       | Thread         | Open         |
| 33  | Title menu needs polish; agent mark goes before the title      | Top bar        | Open         |
| 34  | The slash command popover looks crude                          | Composer       | Open         |
| 35  | The palette is black and grey and reads as cheap               | Design system  | Open         |
| 36  | The composer has no + menu, file or image attachments          | Composer       | Open         |
| 37  | Icons look heavy; use thin line icons from a library           | Design system  | Open         |
| 38  | Files pane: no markdown preview, file-type icons or editing    | Side panel     | Open         |
| 39  | Terminal tabs cannot be renamed or reordered and look crude    | Terminal       | Open         |

## 1. Thoughts and tool calls cannot be folded together

- **Reported**: 2026-10-21, with a Claude Code session that ran ten commands in a row.
- **Observed**: every thought and every tool call is a row or card of its own, so a turn's intermediate work fills the screen and pushes the conversation apart. There is no way to fold it.
- **Expected**: the intermediate work of a turn, thoughts and tool calls alike, folds into one block that can be collapsed and expanded to show the individual steps.
- **Today**: `buildItems` in `src/renderer/src/features/session/thread-items.ts` groups only consecutive completed `read`, `search` and `fetch` calls. Thoughts, commands, edits and failures always stand alone, as [Interface: tool calls](../design/ui.md#tool-calls) specifies ("Edits, commands and failures are never grouped"), so the fix changes that rule too.
- **Reference**: Claude Desktop folds a run of steps into one summary line, such as "Ran 3 commands, edited m0-feedback.md +3 −0 ›", which expands to the steps (seen in a screenshot sent with problem 6).
- **Fixed**: two or more thoughts and tool calls between messages fold into one summary line after the reference, which expands to the steps; the run a turn is still adding to shows step by step until a message or the turn's end follows it ([Interface: tool calls](../design/ui.md#tool-calls)). The rule that kept a turn's last edit open is gone, since the summary names the edit with its stats.

## 2. Choosing a model does not close the model menu

- **Reported**: 2026-10-21.
- **Observed**: clicking a model in the model menu switches to it, but the menu stays open.
- **Expected**: one click chooses the model and closes the menu.
- **Today**: this is the designed behavior. [Interface: model menu](../design/ui.md#composer) says "a model row checks the model without closing the menu", and the model list in `src/renderer/src/features/session/composer/control-row.tsx` renders `Choices` without `closeOnClick`. The fix changes that rule. To settle when planning: whether a reasoning level or a switch such as Fast mode still keeps the menu open, as all three do today.
- **Fixed** in `b6eac92`: a model row, `Enter` on it or `1` to `4` choose the model and close the menu; a reasoning level and the switches keep it open, as [Interface: model menu](../design/ui.md#composer) now says. Checked on a production build on macOS.

## 3. No switch for Claude Code's ultracode

- **Reported**: 2026-10-21.
- **Observed**: nothing in the model menu or the control row turns ultracode on.
- **Expected**: a switch for ultracode mode.
- **Today**: Claude Code's ACP adapter offers no option for ultracode; it turns on for a message that contains the word. OverBench only shows an **Ultracode** hint in the control row while a Claude Code draft contains `ultracode` ([Interface: ultracode](../design/ui.md#composer)). This was already an open question after the previous acceptance round. A switch either needs the adapter to offer one or has to work through the prompt OverBench sends.
- **Fixed**: an **Ultracode** switch in the model menu for Claude Code, through `_meta.claudeCode.options.settings` and a `session/resume` that restarts Claude Code between turns, as [M0 feedback findings](./m0-feedback-findings.md#3-ultracode) recommended ([Session model: config options](../design/session-model.md#config-options)). Checked in a live session: after the switch, the restarted Claude Code process runs with `"ultracode":true` in its settings, and with `false` after switching back. Not checked: a turn with it on, which would start a workflow on the account's quota. New sessions leave the setting to Claude Code until the switch is used. When the adapter offers its own option (upstream PR #924), OverBench moves to it.

## 4. The model menu does not look polished

- **Reported**: 2026-10-21, with a screenshot of the open menu for Claude Code.
- **Observed**: the menu's presentation is not refined enough.
- **Expected**: the menu reaches the polish of the reference.
- **Today**: the menu holds the model list (shortcuts `1` to `4`, scrolling within 288 px behind fades), the reasoning level as a segmented control with a reset button and a `← →` hint, and switches such as Fast mode ([Interface: model menu](../design/ui.md#composer)). The specific problems are to be agreed when planning.
- **Partly fixed**: the menu follows the refined [menus](../design/design-system.md#menus-and-dialogs) (content-fit width, 12.6 px radius, 6 px padding, the softer popover shadow), model and option names carry weight 500 over their descriptions, the switches are the redesigned [switch](../design/design-system.md#switches-and-selects), and the `← →` hint next to the reasoning level is gone (the arrow keys still step it). What else falls short is for the maintainer to say against the reference.
- **Reported again**: 2026-10-22, with a screenshot of OverBench's open model menu for Claude Code and two of the reference's (Claude Desktop): the model menu with its Effort submenu, and the same menu with its More models submenu. The maintainer finds the reference's model list very finely made and OverBench's rough.
  - **Observed in OverBench**: one tall panel. The models come first, each as a name over its description, seven in view with the list scrolling and its last row fading; after a separator, **Effort** with its current value over a segmented control (Low, Medium, High, Xhigh, Max); then an **Ultracode** row with a two-line description and a switch.
  - **Observed in the reference**: a compact menu of one-line rows. Four models (Opus 5.5, Fable 5.1, Sonnet 5.5 checked in blue, Haiku 5.5) with `1` to `4` at the right; after a hairline, **Effort** with its current value ("Extra") and a chevron into a submenu; after another, **More models** ▸, whose submenu lists the older models, with no accelerators. The Effort submenu opens beside the menu with a muted sentence ("Higher effort means more thorough responses, but takes longer and uses your limits faster."), then Low, Medium with a **Recommended** tag, High, Extra (checked in blue), Max with an info icon, and **Ultracode** last, in purple. The model button reads the model and the level ("Sonnet 5.5 Extra", the level in muted text).
  - **Today**: [Interface: model menu](../design/ui.md#composer) specifies the one 320 px menu on purpose, so "a model and its level are set together": the level and the switches keep the menu open, and a model closes it. The rows show the agent's descriptions and the level names the agent gives.
  - **To settle when planning**:
    - The structure: the reference's short main list with **Effort** and **More models** as submenus, against the one panel that sets a model and its level in one visit. Submenus cost that, and the level then needs its own place to be changed.
    - Which models are the main four and which go under **More models**. The agent supplies an ordered list, from Claude Code's handful to OpenCode's dozens of `provider/model` rows, so the rule cannot name families; a long list may also want a search field, like the project menu's.
    - Whether a model row keeps its description. The reference shows names alone; the descriptions come from the agent, and could move to a tooltip or stay as a second line.
    - The details of the Effort list: the sentence on top, a **Recommended** tag, an info icon on the costly level, and **Ultracode** set apart by colour. A tag and an explanation need the agent's metadata or an OverBench rule; the level names are the agent's own, so showing "Extra" where Claude Code says Xhigh would be a relabel.
    - The check's colour: the reference checks in blue, while [problem 22](#22-the-new-session-project-and-agent-menus-look-crude) kept the menus' neutral check. This ties to the prose palette question in [problem 6](#6-markdown-looks-plain-and-file-references-do-not-stand-out).
    - What the model button shows, and the rule rewritten in [Interface: model menu](../design/ui.md#composer), with before and after screenshots in both themes as in the menus pass.

## 5. Messages have no action row

- **Reported**: 2026-10-21, with screenshots of the reference (Claude Desktop) next to OverBench.
- **Observed**: under an agent's reply OverBench shows only the turn-end marker ("Worked for 1 m 9 s"), and under a user message nothing. There is no way to act on a message.
- **Expected**: an action row under messages, following the reference, with a different set for each side:
  - Agent reply, aligned with its start: copy, a fork-style arrow, pin, a speaker icon, then the relative time ("just now").
  - User message, aligned with its end: the relative time, a double check, copy, a counter-clockwise arrow, then the fork-style arrow.
- **Today**: neither [Interface: thread entries](../design/ui.md#thread) nor the code has message actions. Thread entries carry no time of their own, so the relative time needs one in the thread model. To settle when planning, after reading the reference: what each icon does, whether the row is always shown or only on hover, and which actions M0 can back, since session fork and checkpoints with undo are [out of M0](./m0.md#out-planned-for-later-milestones) and ACP's `session/fork` is still unstable.
- **Fixed**: user messages get a time and **Copy** on hover; each reply gets a row with **Copy**, **Read aloud**, **Fork into a new session** under the latest reply, the turn-end text and the time ([Interface: message actions](../design/ui.md#message-actions)). Messages carry the time they were sent or began, for live messages only. Fork goes through `session/fork` when the agent advertises it; the reference's pin, double check and rewind are left out, since M0 has no pins and no checkpoints.

## 6. Markdown looks plain and file references do not stand out

- **Reported**: 2026-10-21, with a screenshot of an OverBench reply next to one from the reference.
- **Observed**: file paths in a reply, such as `internal/drivers/providers/providers.go:16`, render as the same grey inline code as any identifier, so nothing marks them as files. The markdown as a whole reads as library defaults.
- **Expected**: file references stand out, and the markdown has a designed look of OverBench's own. The reference (Claude Desktop) shows file references as accent-coloured links ("m0-feedback.md", "ui.md") and inline code in a tinted colour; it is a starting point, not something to copy.
- **Today**: `src/renderer/src/features/session/markdown/markdown-impl.tsx` renders replies with Streamdown, and `.markdown` in `src/renderer/src/styles/globals.css` sets spacing, headings and lists, a `--muted` chip for inline code and an underlined link in the text colour. Paths are not recognised, and every link other than a pull request uses Streamdown's default link. [Interface: markdown](../design/ui.md#markdown) does not cover file references. To settle when planning: how a file reference is recognised (markdown links, paths in inline code, `path:line`), what clicking one does, and the markdown look as a whole, written into the design system.
- **Partly fixed**: file references are recognised and open the file in the [Files pane](../design/ui.md#files) at their line: inline code or a link that names a file of the project, relative or absolute inside it, with an optional `:line`, `:line:column` or `#Lline` ([Interface: markdown](../design/ui.md#markdown)). They take the link's underline for now. The markdown's designed look, file references included, is still to be designed.
- **Reported again**: 2026-10-22, with a screenshot of a Codex reply in OverBench and one of the reference's reply (Claude Desktop) with its inline code, file link and bold terms.
  - **Observed**: the body of a reply is black and grey from end to end. Links and file references take the text color with an underline, inline code is black on a `--muted` chip, and bold is only heavier; nothing is coloured or highlighted. The maintainer finds the type untuned as well: the fonts have had no tuning, and the rhythm of lines, paragraphs and headings reads as defaults. Which details are off was not pointed out.
  - **Expected**: the body worked out as a whole, with colour where an element deserves it and highlighting where it helps, and the type tuned. The maintainer judges the current look as clearly not good-looking.
  - **Reference**: in the screenshot of the reference, inline code is set in a warm tint on a light chip, a file reference is a blue underlined link, and bold terms stay in the text color. These are readings of one screenshot, not measurements.
  - **Today**: `.markdown` in `src/renderer/src/styles/globals.css` sets `--font-sans` as Inter Variable with PingFang SC, Microsoft YaHei and Noto Sans CJK SC behind it, 14 px prose at 1.625, headings at 1.36, 1.2 and 1.07 em, semibold `strong`, `color: inherit` links, and inline code in `--font-mono` at 0.86 em on `--muted`. [Design system: typography](../design/design-system.md#typography) keeps a neutral palette and no accent, and [problem 22](#22-the-new-session-project-and-agent-menus-look-crude) notes that the palette has none.
  - **To settle when planning**:
    - The prose palette: which elements take colour (inline code, links and file references, headings, quotes, list markers, tables, bold), the tints in both themes at readable contrast, and whether they come from the existing semantic colours or from new tokens. A colour for prose is not a brand accent, and it must stay apart from the agents' own colours.
    - The type: the Chinese face and its weight and size next to Inter, the spacing where Chinese meets Latin text and digits (CSS `text-autospace` is one route, to check against Electron 44's Chromium), line height, paragraph and list spacing, and the heading scale.
    - Whether the tuning covers only agent replies or also the user's bubbles, tool output and the thinking text.
    - The rule written into [Design system: typography](../design/design-system.md#typography) and [Interface: markdown](../design/ui.md#markdown), with a screenshot comparison in both themes as in the other polish passes.

## 7. The usage popover shows too little and needs a full redesign

- **Reported**: 2026-10-21, with a screenshot of the popover in a Claude Code session on Claude Max, then screenshots of the reference's context and plan usage views.
- **Observed**: the popover shows Context (9%, "91k of 1M tokens · 909k left", the session's input, output and cache totals, **Compact**) and a single plan limit, 5-hour, with an empty bar, "—" for the percentage and a reset time. That is too little to be useful, and the popover's UI is far from release quality.
- **Expected**: the popover redrawn as a whole rather than touched up, showing two things it cannot show today. The reference (Claude Desktop) shows both:
  - **What fills the context**: "23% used · 138.8k / 600k" over a bar stacked by source, then one row per source with its colour, tokens and share of the window: messages, MCP tools, system tools, system prompt, skills, memory files, MCP server instructions, what was added since the last update, the autocompact buffer and free space. Deferred MCP and system tools follow with their tokens but no share, and the MCP tools (165) and memory files (4) expand into lists.
  - **The actual plan usage**: the plan's name ("Max (5x)"), then each limit with a bar, its reset and its percentage: "Session limit · Resets in 1 hr 2 min · 59%" and "Weekly · all models · Resets Sat 6:00 AM · 34%".
- **Today**: `src/renderer/src/features/session/composer/usage.tsx` follows [Interface: usage popover](../design/ui.md#usage-popover). Neither piece has a source yet:
  - From `usage_update` OverBench gets only the context's `used`, `size` and `cost`, with no breakdown ([Session model: mapping ACP v1](../design/session-model.md#mapping-acp-v1-to-patches)). Claude Code works the breakdown out for its own `/context` command; whether the adapter can pass it on is unchecked.
  - A plan-limit window appears only after Claude Code reports it in `usage_update._meta["_claude/rateLimit"]`, which happens when the limit changes, so the weekly windows had not shown up yet, and a window reported without `utilization` shows "—" ([Session model: plan limits](../design/session-model.md#plan-limits)). The current numbers need another source.
- **To settle when planning**: where the context breakdown and the current plan usage come from for each agent, what the popover shows for agents that offer neither, and the new design, written into the design docs before it is built.
- **Partly fixed** in `162ddd7` and `074b216`: both sources exist now, for Claude Code. The plan limits come from Claude Code's `/usage`, read when the popover opens, so every window shows its current use and reset ([Session model: reading the limits from `/usage`](../design/session-model.md#reading-the-limits-from-usage)); what fills the context comes from `/context`, run in a throwaway fork of the session ([Session model: context breakdown](../design/session-model.md#context-breakdown)). Neither costs a model call, and both run in sessions the host deletes afterwards. The popover shows the breakdown as rows in its current layout ([Interface: usage popover](../design/ui.md#usage-popover)). Checked against a live Claude Max session: three windows (5-hour, weekly, weekly Fable) with their resets, and the categories with the memory file and 69 skills, each in 3 to 5 s. Still to do: the popover's redesign, and the plan's tier ("Max (5x)"), which neither report gives. Codex's plan limits now come from its `/status` the same way ([Session model: reading Codex's limits from `/status`](../design/session-model.md#reading-codexs-limits-from-status)); checked against a live ChatGPT Free account, whose one window lasts 30 days although the adapter labels it weekly. OpenCode has no such report, and Codex no context breakdown.

## 8. Session rows show their time badly

- **Reported**: 2026-10-21, with a screenshot of the sidebar.
- **Observed**: the relative time on each session row ("6m", "3h") leaves a wide empty gap before the row's right edge, which looks off, and a time on every row makes the list look busy.
- **Expected**: whether rows show a time at all, and how, is decided by design first.
- **Today**: [Interface: sidebar](../design/ui.md#sidebar) gives every row that is not running or starting a relative time. In `src/renderer/src/features/sidebar/session-indicator.tsx` the time is followed by a 16 px slot (`w-4`) for the status indicator, kept even when the row has no indicator, which is the gap after the time. To settle when planning: whether the time shows always, on hover only or not at all, and how it shares the row's end with the status indicators.
- **Decided**: 2026-10-22, with a screenshot of the sidebar marking the time column: the time goes from every session row, since an always-visible time is not a real need. Only the status indicator stays at the row's end. What changes, when this is fixed:
  - `SessionIndicator` stops rendering `shortAgo`, and the rule "running and starting rows show no time" in [Interface: sidebar](../design/ui.md#sidebar) goes with it, as does "in place of the time" for the attention pill.
  - Titles gain the width the time took. To settle: whether the 16 px indicator slot stays reserved on rows with no status, so a status appearing never moves the title, or the title runs to the row's end and a status takes its place when it appears.
  - The project home's recent sessions list keeps its time column; this decision covers the sidebar only. Whether the time should show somewhere in the sidebar, such as the row's tooltip, was not asked and is left open.

## 9. New session is tied to the selected project

- **Reported**: 2026-10-21, with a screenshot of OverBench after clicking New session, and one of the reference's sidebar.
- **Observed**: New session (`Mod+N`) opens the project home of whichever project is selected (bucky in the screenshot), or starts a session there with the default agent. The project you get depends on what was selected last, and the sidebar has no direct way to start a session in a given project.
- **Expected**: New session is global. It assumes no project; the project is chosen, or a new one added, as part of starting the session. Each project group ends with a small **+** that starts a session in that project, as the reference's sidebar does at the end of its "overbench" group.
- **Today**: [Interface: sidebar](../design/ui.md#sidebar) says New session "starts a session in the selected project", and `newSession` in `src/renderer/src/app/actions.ts` takes the selected project, else the first one, then starts a session with the default agent or opens the [project home](../design/ui.md#project-home). The only **+** in the sidebar is the one after Projects, which opens a project. To settle when planning: what the global New session screen holds (choosing the project and the agent), what `Mod+N` does, and what becomes of the project home.
- **Fixed**: New session (`Mod+N`, the File menu) opens a [New session screen](../design/ui.md#new-session): a composer with a project menu (the projects, then **Open project…**) and an agent menu, starting at the selected project and the default agent. The first send creates the session and sends the message; until then the text is kept as a draft, so a failed start or a sign-in loses nothing. Each project's row shows a **+** on hover that opens the screen in that project, and the project's name still opens its home. Checked in development on macOS in light and dark with the fake agent. The project home's own design stays with [problem 10](#10-the-welcome-screen-and-the-project-home-lack-polish).

## 10. The welcome screen and the project home lack polish

- **Reported**: 2026-10-21, with a screenshot of the project home.
- **Observed**: the project home, and the welcome screen shown when there are no projects, are neither refined nor beautiful enough. They are the first thing a user sees, and an ugly first screen takes away any wish to keep using the app.
- **Expected**: both screens are polished with care, as the app's first impression.
- **Today**: [Interface: welcome](../design/ui.md#welcome) and [project home](../design/ui.md#project-home), built in `src/renderer/src/features/home/welcome.tsx` and `project-home.tsx`. In the screenshot the cards' second lines mix the adapter's version ("v0.94.0") with raw launch commands ("npx -y @agentclientprotocol/…", "opencode acp"); the Fake agent card shows only because the app runs unpackaged. [Problem 9](#9-new-session-is-tied-to-the-selected-project) may change what the project home is for. To settle when planning: the design of both screens, written into the design docs before it is built.

## 11. No steering or queued messages while a turn runs

- **Reported**: 2026-10-21.
- **Observed**: there is no presentation for several messages sent in a row. While a turn runs, the user cannot send another message at all.
- **Expected**: two kinds of follow-up message, clearly told apart and obvious to use:
  - **Steering**: a message that guides the agent within the turn it is running.
  - **Queued**: a message that waits and is sent once the running turn ends.
- **Today**: left out of M0 on purpose. While a turn runs, the send button becomes **Stop** and `Esc` cancels the turn; you can keep writing a draft, and queueing "comes later" ([Interface: composer](../design/ui.md#composer)). Steering and prompt queueing are [out of M0](./m0.md#out-planned-for-later-milestones), and the agents' `_meta` extensions for them are unstable ([Architecture: agents](../architecture.md#agents)). A queue can live in OverBench alone, while steering needs the agent to accept input during a turn. To settle when planning: which agents support steering and how, how each kind is sent and shown in the composer and the thread, and whether this comes into M0.
- **Fixed**: OverBench owns a queue for every agent, shown above the composer, and steers into a running turn where the agent supports `_session/steering` with `idleBehavior` (Claude Code today), as [M0 feedback findings](./m0-feedback-findings.md#11-steering-and-queued-messages) proposed: the send key queues, `Mod+Enter` steers, a queued message can be steered, edited or removed, and the queue pauses after Stop or an error ([Interface: composer](../design/ui.md#composer), [Session model: queue and steering](../design/session-model.md#queue-and-steering)). Still to decide: a setting that makes the send key steer, as Codex CLI and OpenCode do.

## 12. Switching sessions visibly stalls

- **Reported**: 2026-10-21, with a screenshot taken during a switch.
- **Observed**: switching between sessions stalls noticeably. In the screenshot the main area shows the thread skeleton and the session's sidebar row a spinner while the session opens.
- **Expected**: switching feels instant, as the [M0 goal](./m0.md) promises ("Switching between them is instant").
- **Today**: the only measurement, in [M0 performance](../perf/m0.md), is 36 ms to first paint for a live fake-agent session with 1,000 entries. It does not cover what the screenshot shows: a session that is not live and has to be opened again with `session/load`, the wait for its snapshot (`ThreadSkeleton` in `src/renderer/src/features/session/session-view.tsx`), or real threads full of markdown and diffs. Which of these causes the stall is not known yet. To settle when planning: reproduce the switch with real sessions, profile it in the DevTools Performance panel to find where the time goes (starting the agent and `session/load`, the snapshot, or rendering), and add the case to the performance script.
- **Partly fixed**: four of the causes found in [M0 feedback findings](./m0-feedback-findings.md#12-switching-sessions) are dealt with. `7dddd70` replays `session/load` in linear time in the agent host, `1365800` mounts a long history in linear time, and `3e26044` restores the last session at launch without waiting for git tools. In `f28120b`, a session that is not live now shows "Starting Claude Code…" while its agent starts, then "Loading the conversation…" over the skeleton until the replay ends ([Interface: states](../design/ui.md#states)). In `6e961aa`, the performance script measures a 4,000-entry reopen, the settled time and long frames of switches, a switch to an evicted session and back to a 4,000-entry one ([M0 performance](../perf/m0.md#2026-10-21-macos-session-switching)). Keeping recent sessions mounted with `<Activity>` was measured and left out: it took a switch back to 4,000 entries from 38 ms to 147 ms to first paint, a single frame the click waits for, to save the 0.9 s that the history takes to fill in after it. Still to decide: agents starting through `npx -y` on every launch, which costs Claude Code 1.1 to 1.4 s, and needs a managed install of each adapter.

## 13. The git popover only displays, and repeats the terminal toggle

- **Reported**: 2026-10-21, with a screenshot of the branch popover.
- **Observed**: the branch popover shows the branch, its lane against the base, the commits and the changed files, but nothing in it does anything beyond copying the branch name, **Terminal**, and **Fetch** when there is a remote. It is decoration rather than a tool. Its **Terminal** button repeats the terminal toggle right next to it in the top bar.
- **Expected**: git in OverBench designed as a whole: what it can do, its UI and interactions, and how the functions are organised. The popover's **Terminal** and the top bar's terminal are reconciled into one way in.
- **Today**: [Interface: branch popover](../design/ui.md#branch-popover) and [Git](../design/git.md), built in `src/renderer/src/features/git/branch-popover.tsx`. It is read-only on purpose: git actions in the interface (staging, committing, pushing, creating pull requests from a form) are [out of M0](./m0.md#out-planned-for-later-milestones). The footer's **Terminal** "opens a terminal in the project", as the toggle at the right of the top bar does. To settle when planning: which git actions come in and when, where they live (this popover, a Changes panel, the thread), and the one place that opens a terminal.
- **Partly fixed**: the popover's **Terminal** button is gone, so the top bar's toggle is the one way in. Git actions and the popover's design are still to be decided.
- **Reported again**: 2026-10-22, with a screenshot of the open popover for `feat/login`, a branch with one commit not published and no remote. The maintainer finds the content still reads as simple text rendering, without the interactions it needs, and wants every detail polished.
  - **Observed**: the header, the lane, the commit row, the changes line and the footer ("No remote") are text and a static drawing, and nothing in them reacts. Which interactions are wanted was not listed.
  - **Today**: in `src/renderer/src/features/git/branch-popover.tsx` a commit row is a plain list item, with no hover or focus state, no click, no tooltip and no copy of its id. The working tree line is a count with its added and removed lines, not a list of files. The lane is a static SVG (`branch-lane.tsx`). The buttons are the copy of the branch name, "more commits", **Fetch** and the pull request part's links; the footer's text for a repository with no remote has no action. The design ([Interface: branch popover](../design/ui.md#branch-popover)) specifies the content and, by intent, no git actions.
  - **To settle when planning**: the interactions, none of them asked for yet and so only candidates: a commit row that copies its id and shows its full message and author, and opens its diff; a files line that expands to the changed files and opens one in the [Files pane](../design/ui.md#files) or a diff; a lane whose nodes show their commit on hover; and what the footer offers with no remote. They depend on the git design above, which is still open. The polish: row and control states (hover, focus, active, disabled), spacing and type sizes, the loading, no-remote, detached and no-changes states, keyboard use, and both themes, checked against the reference's popovers in the way of the menus pass.

## 14. The terminal panel's own buttons do nothing

- **Reported**: 2026-10-21 on macOS, with a screenshot of the open terminal panel. A bug.
- **Observed**: in the terminal panel's header, **New terminal** (+), a tab's close button, **Maximize** and **Close** do nothing when clicked. Only the terminal toggle in the top bar closes the panel.
- **Expected**: every button in the header works.
- **Today**: likely cause, not yet confirmed in the app: the header in `src/renderer/src/features/terminal/terminal-panel.tsx` is a window drag region (`app-region-drag`), since the panel reaches the window's top edge, but neither its tabs nor its `PanelButton`s set `app-region-no-drag`, so macOS takes the clicks as window drags. The top bar's own controls set `app-region-no-drag` (`src/renderer/src/features/shell/top-bar.tsx`), which is why the toggle works; AGENTS.md lists this rule under gotchas. To check when fixing: the same header on Windows and Linux, and the sidebar toggle that the header shows while maximized with the sidebar collapsed.
- **Fixed** in `5daaea1`: the header's tab list and buttons opt out of the drag region; the sidebar toggle already did. On a production build on macOS every tab and button in the header computes `no-drag`; Windows and Linux are not checked by hand.

## 15. Settings selects show names only and keep the default look

- **Reported**: 2026-10-21, with a screenshot of Default agent open in Settings › General.
- **Observed**: the Default agent select lists "Ask each time", "Claude Code", "Codex" and "OpenCode" as bare names, without the agents' marks. The select itself looks like the library default: it opens over its trigger and covers the row below.
- **Expected**: options show a mark with the name, which is required for agents, so a choice is recognised at a glance; and the select gets a look designed for OverBench.
- **Today**: both selects in Settings, Default agent in General and Automatic updates in About, go through `SettingSelect` in `src/renderer/src/features/settings/controls.tsx`. It takes only a value and a label per option and renders shadcn's `Select` unchanged, which lines the chosen item up with the trigger by default (`alignItemWithTrigger`). The agents' marks already exist ([Design system: agent marks](../design/design-system.md#agent-marks)). To settle when planning: the select's design and whether other selects in the app follow it, and what "Ask each time" and options that are not agents show in place of a mark.
- **Partly fixed**: `SettingSelect` options take an icon, shown in the list and the trigger; Default agent shows each agent's mark and a neutral `CircleHelp` for "Ask each time". The select's look is still to be designed.
- **Fixed**: the select's list is a menu, as [switches and selects](../design/design-system.md#switches-and-selects) describes: it opens below the trigger instead of over it, at least as wide as it, with the menus' surface, radius, padding, labels and `rounded-lg` items.

## 16. Switches keep shadcn's default look

- **Reported**: 2026-10-21, with a screenshot of two switches in Settings › General.
- **Observed**: the switches in Settings are shadcn's stock switch, a black track with a white thumb when on.
- **Expected**: a round of customisation in OverBench's own style.
- **Today**: `src/renderer/src/components/ui/switch.tsx` is unchanged since it was added. The design system only lightens `--input`, the unchecked track, and leaves switches with shadcn's own feedback ([Design system: meaning](../design/design-system.md#meaning)). The same switch appears in Settings (`SettingSwitch` in `src/renderer/src/features/settings/controls.tsx`) and in the model menu, for options such as Fast mode. To settle when planning: the switch's design (size, on and off colours in both themes, thumb, motion), done together with [problem 15](#15-settings-selects-show-names-only-and-keep-the-default-look) so the settings controls match.
- **Fixed**: the switch is redrawn as [switches and selects](../design/design-system.md#switches-and-selects) describes: a 28 × 16 px recessed pill with a lifted 12 px thumb (24 × 14 px in menus), `--checked` blue when on, a slide on `--duration-base` and a stretch while pressed, in both themes.

## 17. Settings › Agents leaves out what matters

- **Reported**: 2026-10-21, with a screenshot of Settings › Agents.
- **Observed**: the page falls well short. Each card shows the agent's status and launch command, and some a version and the account, but the core facts are missing. Claude Code's subscription usage is the clearest case: its card has a single 5-hour row with an empty bar and "—", so how much quota is left cannot be seen. Also in the screenshot: Claude Code's "v0.94.0" is the ACP adapter's version, Codex shows neither a version nor an account, and the footer read "Reading your environment…".
- **Expected**: the page reworked to show each agent's core facts, starting with how much of Claude Code's subscription quota is left.
- **Today**: `src/renderer/src/features/settings/agents-section.tsx` follows [Interface: settings](../design/ui.md#settings): status with its next step, the version from `agentInfo`, the launch command, the Node.js version, the account, and its plan limits when the agent reports them. The plan limits come from the same place as the usage popover's, so they share the gap in [problem 7](#7-the-usage-popover-shows-too-little-and-needs-a-full-redesign): only windows Claude Code has pushed, with "—" when `utilization` is missing. To settle when planning: which facts each card shows and where each comes from (subscription usage, the agent's own version besides the adapter's, the account for Codex and OpenCode), solved together with problem 7.
- **Partly fixed** in `162ddd7`: each Claude Code card shows its plan limits read afresh from `/usage` while it runs, and a stopped one offers **Check plan limits** ([Interface: usage popover](../design/ui.md#usage-popover)). Still to decide with the page's redesign: the other facts each card shows, the agent's own version besides the adapter's, and the account for Codex and OpenCode. The page is now a grouped list with a page per agent ([Interface: Settings › Agents](../design/ui.md#settings--agents)): each row shows the agent's own CLI version, the account or config folder, and its plan windows; each page has Account, Usage, Configuration (where the agent reads its configuration, shown only for now) and a folded Advanced. Still open: which settings each agent's Configuration shows, a Provider fact (the adapters report only the login kind), and OpenCode's version and account before it starts.

## 18. The About page needs redoing

- **Reported**: 2026-10-21, with a screenshot of Settings › About.
- **Observed**: About is one plain card: "OverBench 0.1.0" with a one-line description and the Electron, Chromium and Node.js versions, an Updates row, and a GitHub link for the source code.
- **Expected**: the page redone, with the app's logo, GitHub, a way to send feedback, and the other things an About page usually holds.
- **Today**: built in `src/renderer/src/features/settings/about-section.tsx` and the `about` section of `section-defs.tsx` beside it. [Interface: settings](../design/ui.md#settings) also lists a link to the third-party notices, which the page does not show yet. OverBench has no logo or app icon so far: `build/` holds only the macOS entitlements, `electron-builder.yml` names no icon, and the welcome screen shows a text wordmark. To settle when planning: the logo and app icon, which the packaged app needs too; what the page holds (where feedback goes, such as GitHub issues, the license once it is decided, the notices); and its design.

## 19. Settings leave too much empty space

- **Reported**: 2026-10-21, with a screenshot of Settings › General in a wide window.
- **Observed**: the page's card sits in a narrow column centred in the area right of the section list, with wide empty bands on both sides and most of the window empty below its four rows. The page looks out of balance.
- **Expected**: the Settings layout reworked so the page fills its space in proportion.
- **Today**: `src/renderer/src/features/settings/settings-page.tsx` gives the section list a 244 px column and centres the page in the rest at 700 px at most (`mx-auto max-w-[700px]`), whatever the window's width; [Interface: settings](../design/ui.md#settings) describes the layout. To settle when planning: the layout as a whole (widths, alignment, spacing, how the page grows with the window), done together with the other Settings problems: the controls ([15](#15-settings-selects-show-names-only-and-keep-the-default-look), [16](#16-switches-keep-shadcns-default-look)), Agents ([17](#17-settings--agents-leaves-out-what-matters)) and About ([18](#18-the-about-page-needs-redoing)).

## 20. Collapsing the sidebar is abrupt

- **Reported**: 2026-10-21, with a screenshot pointing at the sidebar toggle.
- **Observed**: collapsing the sidebar, with the toggle or `Mod+B`, removes it in a single frame, and the content jumps to its new width with no transition. Expanding is the same.
- **Expected**: collapsing and expanding animate, so the change reads as a movement instead of a cut.
- **Today**: the sidebar collapses through the `ResizablePanel`'s own collapse ([Interface: layout](../design/ui.md#layout)), and [Interface: motion](../design/ui.md#motion) gives it no animation, so it happens at once. The design system allows the disclosure as the only layout animation ([Design system: patterns](../design/design-system.md#patterns)), and animating the width would lay out a long thread again on every frame. To settle when planning: how the sidebar moves (for example sliding it with `transform` while the content resizes once, or animating the panel's size) and its timing, checked against the frame budget with a long thread, with reduce motion honoured; the design system's rule changes with it.
- **Fixed**: the toggle and `Mod+B` slide the sidebar over `--duration-slow` with `--ease-out-quart`, through a transition on the panels' `flex-grow` that only a toggle sets, so resizing by drag stays immediate; reduce motion keeps it instant. Both panels' contents take their final widths at once against the panel's right edge, so the thread lays out once, as it did, and the sidebar slides in or out with its content intact. Measured on a production build at 120 Hz: with a 1,250-entry thread, with or without the terminal open, neither direction had a task over 15 ms. A single 200 KB message with the terminal open, where the thread column changes width, costs one or two frames of 30 to 55 ms, as the instant toggle did (44 to 56 ms). The design system's [patterns](../design/design-system.md#patterns) name the slide as the one layout animation between panels.

## 21. No file browser or preview

- **Reported**: 2026-10-21, with a screenshot of OverBench's side panel holding the terminal, and one of the reference's Files pane.
- **Observed**: the side panel can hold only the terminal. There is no way to browse the project's files or look at one inside OverBench.
- **Expected**: a Files pane in the side panel, following the reference (Claude Desktop): the project's file tree with a filter field ("Filter, or ? to search in files"), search and a tree or list toggle, beside a preview area that says "Open files appear here" until a file is picked in the tree or a file path is clicked in the conversation; with maximize and close. The reference opens its panes from a row of buttons in the top bar (tasks, terminal, changes, browser, files).
- **Today**: the side panel holds only the terminal, opened by its toggle in the top bar ([Interface: layout](../design/ui.md#layout)), and M0 planned for the Changes panel to share it later ([M0: decisions](./m0.md#decisions)). OverBench has no file tree or viewer, and the `fs` client capabilities are off ([Architecture: client capabilities](../architecture.md#client-capabilities)). Opening a file from a path in the conversation ties in with [problem 6](#6-markdown-looks-plain-and-file-references-do-not-stand-out). To settle when planning: how the side panel hosts several panes (terminal, files, later changes) and how you switch between them, which also settles the duplicate terminal button of [problem 13](#13-the-git-popover-only-displays-and-repeats-the-terminal-toggle); the tree and the preview (Shiki highlighting, large and binary files, following changes on disk); and which process reads the files.
- **Fixed**: a [Files pane](../design/ui.md#files) in the side panel, which now holds one pane at a time with a toggle for each in the top bar (Files, Terminal). It has the project's tree beside a preview, a filter field that filters paths and searches the files' text after `?`, a tree or list toggle, maximize and close. The agent host lists the files with `git ls-files` (a bounded walk outside a repository), reads them with a 1 MB cap and a binary check, and searches them with `git grep`, keeping every path inside the project ([project files](../design/agent-host.md#project-files)). The preview uses the diffs library's `File` on the existing worker pool. File paths in replies open the file there ([problem 6](#6-markdown-looks-plain-and-file-references-do-not-stand-out)).

## 22. The New session project and agent menus look crude

- **Reported**: 2026-10-21, with screenshots of the project and agent menus under the New session composer, and one of the reference's folder menu.
- **Observed**: the project menu is a wide list in which every project takes two lines, its name over its full path in mono, so it reads as a column of paths, and a long path is cut off mid-word ("/private/tmp/claude-501/-Users-am…"). The agent menu beside it has the same generic look. The maintainer asked how the two menus came to look like this; the project menu looks worst.
- **Expected**: both menus reach the reference's polish, the project menu first.
- **Reference**: Claude Desktop's folder menu, opened from the folder under its composer and measured on a 2x screenshot. It is 195 px wide, fitting its longest name. A search field sits on top ("Search folders…" in the muted text color) over a full-width hairline; then **No folder**; then a **Recent** group label in muted text over the folders by name alone, with no path or icon, in rows about 26 px apart with the text inset 14 px, as in OverBench's menus. The chosen folder is checked in blue (`#2a79d7`), 12 px from the right edge. Separators are inset to the text. **Open folder…** follows, and last a **Branch** row (the current branch, with a submenu) and a **Worktree** switch.
- **Today**: nothing in these two menus was designed for them. The screen came with [problem 9](#9-new-session-is-tied-to-the-selected-project) in `8b0008c`: `ProjectMenu` and `AgentMenu` in `src/renderer/src/features/session/new-session.tsx` are generic dropdown menus with fixed widths (288 and 224 px), a group label ("Project", "Agent") and radio items, and each project item stacks its name over its path in `font-mono text-[11.5px]`, as [Interface: new session](../design/ui.md#new-session) asks ("each with its path in mono"). The later changes to every menu, the refined menus (`5529747`) and Inter at 14 px (`d16ce83`), applied to them too, so the two-line rows grew with the text. There is no search: the list, already ordered by last use (`lastOpenedAt`), can only be scrolled, within 288 px. To settle when planning: which parts of the reference to take (the search field; names alone, and how two projects with the same folder name are told apart; a "Recent" label; the check's color, since OverBench's palette has no accent); whether Branch and Worktree belong in this menu, as OverBench has no worktrees yet; and how the agent menu follows.
- **Fixed**: the project menu follows the reference ([Interface: new session](../design/ui.md#new-session)): a search field over a hairline, then **Recent** with the projects by name alone, then **Open project…**, which stays in view while only the projects scroll. It is Base UI's `Combobox` through shadcn's `combobox` component, restyled as a [search menu](../design/design-system.md#menus-and-dialogs); it fits the longest name (about 195 px for names like the reference's, as there) and keeps that width while filtering. Two projects with the same folder name add the fewest parent folders that tell them apart (`nameHints`, with tests). The agent menu lost its fixed width and its "Agent" label. Branch and Worktree are left out, since OverBench has no worktrees; the check keeps the menus' neutral color. Checked on a production build on macOS in both themes, filtering, with no match, and choosing with the keyboard.
- **Fixed** as well, at the maintainer's request: **No project** heads the menu, as the reference's **No folder** does, for work that needs an agent but no folder. The session runs in an empty scratch folder of its own under `<userData>/scratch`, which is not added to the projects, and the sidebar lists such sessions in a last **No project** group ([session model: sessions without a project](../design/session-model.md#sessions-without-a-project)).

## 23. The project chevron sits before the name and always shows

- **Reported**: 2026-10-22, with a screenshot of OverBench's sidebar and two of the reference's (Claude Desktop).
- **Observed**: each project's row starts with a fold chevron before its name, and the chevron is always shown, expanded or collapsed. A column of chevrons in front of every name makes the list look busy and pushes the names off the sidebar's left edge.
- **Expected**: the chevron follows the reference:
  - It stands after the project's name, not before it.
  - On an expanded project it shows only while the row is hovered.
  - On a collapsed project it stays shown, so a folded group is still recognisable without the pointer.
- **Reference**: in the sidebar of Claude Desktop the group "overbench" reads "overbench ⌄" under the pointer and plain "overbench" otherwise, while the collapsed group "This computer" always reads "This computer ›". A **+** sits at the row's end in both states there; OverBench shows its **+** only on hover.
- **Today**: `ProjectGroup` in `src/renderer/src/features/sidebar/app-sidebar.tsx` renders the chevron (`ChevronDownIcon` or `ChevronRightIcon`, in a 14 px slot) as the first child of the row, before the name, with no hover condition. [Interface: sidebar](../design/ui.md#sidebar) does not describe the chevron. The row's `→` and `←` keys still fold and unfold it. To settle when planning: the chevron's direction and slot after the name, how the name's truncation leaves room for it, whether the row's **+** should show without hover as in the reference, the same treatment for the **No project** group, and the rule written into [Interface: sidebar](../design/ui.md#sidebar). The reduced-motion and keyboard-focus states need a visible chevron too, since a focused row has no hover.

## 24. The Projects header row can go; each project gets a +

- **Reported**: 2026-10-22, with a screenshot of the sidebar and an arrow at the **Projects** row.
- **Observed**: a **Projects** label row sits above the project list, with a **+** at its end that opens a folder as a project. It costs a row and adds a second **+** that does something different from a project's own, which shows only on hover.
- **Expected**: the row is removed. Every real project shows a **+** after its name that starts a session in that project. **New session** shows the global session creation screen.
- **Today**:
  - The row is the `SidebarGroupLabel` with a ghost **+** button in `AppSidebar` (`src/renderer/src/features/sidebar/app-sidebar.tsx`); the button calls `openProjectDialog()` ("Open project", `Mod+O`).
  - A project's own **+** exists already, but only on hover (`SidebarMenuAction` with `showOnHover` in `ProjectGroup`), and it calls `newSession(projectPath)`, as [problem 9](#9-new-session-is-tied-to-the-selected-project) built it. In the screenshot no row is hovered, so no project shows one.
  - The **New session** row calls `newSession()`, which opens the [New session screen](../design/ui.md#new-session) already, with the project menu starting at the selected project and the agent at the default.
- **To settle when planning**:
  - Where adding a project lives once the header's **+** is gone. What stays: `Mod+O`, File › Open Project…, **Open project…** in the New session screen's project menu, and the button on the Welcome screen while there are no projects. Whether that is enough or the sidebar needs another entry.
  - Whether a project's **+** shows always or only on hover. The reference's sidebar shows it without hover (see [problem 23](#23-the-project-chevron-sits-before-the-name-and-always-shows)); a hover-only one is what the maintainer did not find.
  - Whether the **No project** group keeps its **+**, since "real projects" were named, and New session's project menu already offers **No project**.
  - Whether New session should still start at the selected project, or at no project chosen, as [problem 9](#9-new-session-is-tied-to-the-selected-project) first asked ("assumes no project").
  - Where the list's empty text, loading skeleton and load error go without the header above them.

## 25. The sidebar footer needs a design of its own

- **Reported**: 2026-10-22, with a screenshot of the sidebar's footer and two arrows: one at the plan usage chips, one at the **Settings** row's shortcut hint (`⌘,`).
- **Observed**: the **Settings** row ends with its shortcut as plain text, which the maintainer does not want there.
- **Expected**: the hint is removed. What takes its place is open: icons for functions, or nothing at all. The footer is a block that needs a design of its own, apart from the sidebar's other rows.
- **Today**: `SidebarFooterContent` in `src/renderer/src/features/sidebar/sidebar-footer.tsx` stacks the sign-in notice, the [update notice](../design/ui.md#updates), the plan usage chips (`PlanUsageStrip`) and a `NavRow` for **Settings** with `shortcut="Mod+,"`. `NavRow` (in `app-sidebar.tsx`) shows the shortcut as a muted `Kbd` unless its `extra` prop replaces it, and the **New session** row at the top uses it the same way (`⌘N`). [Interface: sidebar](../design/ui.md#sidebar) describes the footer as these parts and gives **Settings** `Mod+,`.
- **To settle when planning**:
  - Which functions earn an icon at the row's end, and what each does, or whether the row simply ends after its label. Settings has no other function in the sidebar today.
  - How the footer's parts relate as a whole: the notices, the plan usage chips and the Settings row, in their order and spacing. The arrow at the chips is read as putting them in scope; the maintainer's words named only the hint.
  - Whether the **New session** row's `⌘N` goes as well, for consistency. The shortcuts stay findable in Settings › Keyboard shortcuts and in the app menu.
  - The rule written into [Interface: sidebar](../design/ui.md#sidebar), and into the shortcut table if the hints leave the rows.

## 26. Account details cannot be hidden

- **Reported**: 2026-10-22, with a screenshot of Settings › Agents (arrows at the Claude Code and Codex emails) and two of a reference's account card: "Authenticated as" with the email blurred in one and readable in the other.
- **Observed**: Settings › Agents prints each agent's email in full, so a screenshot or a shared screen leaks it.
- **Expected**: account details can be hidden, as a mask over the text, like the blurred email in the reference.
- **Today**: the email shows in two places in `src/renderer/src/features/settings/agents-section.tsx`: the account line of each agent's row in the list (the email "in a stronger color" after the plan) and the **Email** fact in the Account group of an agent's page ([Interface: Settings › Agents](../design/ui.md#settings--agents)). Nothing hides it, and Settings search matches an agent's row by its account, email included.
- **To settle when planning**:
  - How it is turned on: a setting such as **Hide account details** (where), a toggle beside the values, or both; whether it is remembered and its default.
  - How a hidden value is revealed: not at all, on hover, or on click, and whether it copies while hidden.
  - What counts as account details: the email for sure; the plan label, and paths that carry the user name (OpenCode's config folder in the list), were not named.
  - The mask itself: a blur that stays illegible in screenshots, with the value withheld from the accessibility tree and from search while hidden, not only painted over. It must work in both themes and keep the row's layout.
  - Where else an email may appear later (the usage popover shows the plan only today), so the mask is one shared piece, not a per-screen patch.

## 27. Agent adapters have no update check or one-click update

- **Reported**: 2026-10-22.
- **Observed**: nothing tells the user that a newer version of an agent's ACP adapter exists, and nothing updates one.
- **Expected**: the app detects new adapter versions by itself and says so, so the user can decide whether to update. Updating is one button that does the whole job. The notice shows in Settings › Agents and also on the home screen: a user who opens the Agents page once in a long while would otherwise never learn that an update exists.
- **Today**: [Agent host: installing adapters](../design/agent-host.md#installing-adapters) pins exact adapter versions (`claude-agent-acp` 0.94.0, `codex-acp` 2.2.2), "bumped deliberately, after a pass with the fake agent and the real agent", and installs a pinned version once into `<userData>/agents/<agentId>/<version>/`. A newer adapter reaches users only through an OverBench release that bumps the pin, installed at the agent's first start after that update. No code asks npm or the ACP Registry for a newer version. Settings › Agents shows the CLI version the adapter runs, and has **Reinstall** for a damaged install. OpenCode is no adapter: it is the user's own `opencode` binary, found on `PATH`. The [app's update notice](../design/ui.md#updates) is the existing pattern for "something to decide", and only the app's updater feeds it.
- **To settle when planning**:
  - Where the latest version comes from (the ACP Registry entry or the npm registry through the user's npm) and how often it is checked. The check has to run off the main thread, honour the user's `.npmrc` and proxy, and cost nothing when offline.
  - Whether any newer version is offered or only ones OverBench has verified. The pin exists because an unchecked adapter can break the thread (the SDK validates every `session/update` against its schema), so a one-click update trades that safety for freshness; a version range or a compatibility check could sit between the two.
  - What the update does: install beside the running version and switch once it answers `initialize`, as a pin bump does now, and what happens to sessions running on the old one (wait, ask first as **Reinstall** and the app's **Restart** do, or restart the agent). The old version stays until the new one runs, so a failed update leaves the agent working.
  - What the user sees as the version: for Claude Code the CLI is bundled in the adapter, so the wish is probably "Claude Code 2.1.303 → newer", not the adapter's number. Whether the registry or npm can say which CLI an adapter version carries.
  - Where the notice shows: Settings › Agents (the list row and the agent's page, with an **Update** button and its progress) and the home screens, the [project home](../design/ui.md#project-home)'s agent cards and the [Welcome](../design/ui.md#welcome) screen. Whether the sidebar footer, which already holds the update and sign-in notices, needs one too. It should be quiet and neutral like the app's update notice, with a way to dismiss a version.
  - What OpenCode gets: nothing, or a notice that a newer release exists with a pointer to how the user installed it.
  - The rule changes in [Agent host: installing adapters](../design/agent-host.md#installing-adapters), where pins are "bumped deliberately", and in [Interface: settings](../design/ui.md#settings--agents).

## 28. The Ready label next to the status dot is redundant

- **Reported**: 2026-10-22, with a screenshot of Settings › Agents and an arrow at the **Ready** state of Claude Code.
- **Observed**: every agent's row ends with a green dot and the word "Ready". The page only shows state, so the green dot already says it, and the word beside it gets in the way of the look.
- **Expected**: the dot alone, without the name.
- **Today**: the state is `AgentStateLine` in `src/renderer/src/features/agents/agent-state.tsx`, which draws a `bg-success` dot (hidden from assistive tech) and the text `state.ready`. The same component feeds the list rows in Settings, the agent cards on the [project home](../design/ui.md#project-home) and the [Welcome](../design/ui.md#welcome) screen, so a change reaches all three. The other states carry words too: "Sign in to start", "Installing…", "Starting…", "Restarting…", "Failed", "Not available". [Interface: sidebar](../design/ui.md#sidebar) states a rule for status marks: "Indicators always pair a color with a shape or label, never color alone".
- **To settle when planning**:
  - Whether only **Ready** loses its word, since it is the state that needs no attention, while states that ask something of the user keep theirs.
  - How the bare dot stays readable without color alone: an accessible name on the dot and a tooltip with the word, and the rule above amended for it.
  - Whether the project home's cards and the Welcome screen follow the Settings list. The maintainer pointed at Settings only; the card there shows "Ready" the same way.

## 29. Agents that are not installed cannot be installed from here

- **Reported**: 2026-10-22, with a screenshot of Settings › Agents, where all four agents are installed.
- **Observed**: the list shows the agents that are installed. A mainstream agent the user has not installed does not show up as something to install.
- **Expected**: agents that are not installed are listed too, and can be installed from the list: with Codex not installed, the row says it can be installed here instead of being absent. An installed agent and one that is not installed look clearly different.
- **Today**: [Interface: Settings › Agents](../design/ui.md#settings--agents) already has a **Not installed** group below **Installed** (`section-defs.tsx`, `agents.groups`), but it holds only agents whose prerequisites are missing: OpenCode when `opencode` is not on `PATH`, and the two adapter agents when Node.js is missing or too old. Its row has a muted mark and a **How to install** link to a web page, and no install action. An adapter agent with Node.js present counts as installed from the start: Claude Code and Codex are listed under **Installed** with "Installs on first use", and their adapter installs at the first session ([Agent host: installing adapters](../design/agent-host.md#installing-adapters)), whose CLI the adapter carries. The catalog holds these three agents; custom ACP agents and browsing the ACP Registry are [out of M0](./m0.md#out-planned-for-later-milestones).
- **To settle when planning**:
  - What "not installed" means for the adapter agents: an adapter that is not yet installed, listed apart from the installed ones with an **Install** button that runs the install now and shows its progress, instead of waiting for a first session.
  - What it means for OpenCode, which OverBench does not install: a link to its install instructions, or OverBench running the install for the platform's usual route.
  - Whether "mainstream agents" means only the three the catalog knows, or more from the ACP Registry, which brings back browsing the registry and custom agents, both left out of M0. If more, which come first.
  - How the two kinds look apart: a muted mark exists for the missing ones today, and the maintainer asks for a clear difference. The group, the mark, the state word or dot ([problem 28](#28-the-ready-label-next-to-the-status-dot-is-redundant)) and the button are the parts to design together.
  - The same split in the places that offer agents, the [project home](../design/ui.md#project-home) cards, the [Welcome](../design/ui.md#welcome) screen and the New session agent menu, and its link with the adapter updates of [problem 27](#27-agent-adapters-have-no-update-check-or-one-click-update).

## 30. The session context menu lacks rename, pin and archive

- **Reported**: 2026-10-22, with a screenshot of the context menu on a session row.
- **Observed**: the menu holds **New sub-session** (with a submenu of agents), **Close** and **Delete…**, and nothing else. Common operations are missing, among them archive, rename and pin.
- **Expected**: the menu worked out further, with the operations people expect on a session: at least archive, rename and pin, and others of the same kind.
- **Reference**: the session menu of Claude Desktop, sent as a screenshot the same day. Four groups divided by hairlines, with a one-key accelerator at the right of most rows:
  - **Open in** ▸ with **New window** (`1`), then after a hairline **Cursor** (`2`), **VS Code** (`3`), **Zed** (`4`) and **Finder** (`5`).
  - **Pin** (`P`), **Mark as unread** (`U`), **Rename** (`R`), **Fork** (`F`).
  - **Move to** ▸ and **Move to project** ▸, whose submenus the screenshot does not show.
  - **Archive** (`A`) and **Delete** (`D`), the last in the destructive color.
- **Hover button**: added the same day, with a screenshot of OverBench's hovered row (it shows its time) and one of the reference's, whose hovered row shows a **···** button at its end. The maintainer wants the same: hovering a session row shows a **···** button, and its menu is the one the right-click opens, with the same items. Today the menu opens only by right-click, and the row's end holds the time and the status indicator, of which the time goes under [problem 8](#8-session-rows-show-their-time-badly). To settle: where the button sits against the status indicator at the row's end (in its slot, or beside it); that it also shows on keyboard focus, since a hover-only control is out of reach without a pointer; that the title does not change width when the button appears; and that the context menu and this button's menu share one definition of the items, so the two never differ. It follows the project row's hover **+** ([problem 24](#24-the-projects-header-row-can-go-each-project-gets-a-)).
- **Today**: `SessionMenu` in `src/renderer/src/features/sidebar/session-row.tsx` renders those three items, and the session title menu in the top bar holds the same ones ([Interface: session](../design/ui.md#session)), so the two change together. In the [session lifecycle](../design/session-model.md#session-lifecycle) **Close** drops the live state and keeps the row in the list, and **Delete** removes the session after a confirmation; there is no archive. A [title](../design/session-model.md#titles) comes from the agent's `session_info_update`, else the first line of the first message, and the user cannot change it. Pinned sessions are [out of M0](./m0.md#out-planned-for-later-milestones), together with drag reordering. **Fork** exists, as a message action in the thread, not in this menu.
- **To settle when planning**:
  - **Rename**: where the user's title is kept, and that it wins over later titles from the agent, which keep arriving through `session_info_update`. ACP has no rename call, so the title would live in OverBench's index only.
  - **Pin**: a pinned section above the projects, or pinned rows inside their project, and the pinned sessions' own order. This brings pinned sessions into the work and leaves drag reordering for later.
  - **Archive**: what it means next to **Close**, which already leaves the row listed. Archive would take the session off the list without deleting it; how an archived one is found and restored, whether it ends the live session, and what it does to a running one.
  - The rest of the reference's menu: **Fork** (already a message action, shown only when the agent advertises `session/fork`), **Mark as unread**, **Open in** (an editor or the file manager, which the main process would launch, and **New window**, which is out of M0), and **Move to** and **Move to project**, whose meaning needs the reference's submenus. A session's folder is its ACP `cwd`, so moving it to another project is not something ACP offers.
  - The menu's order and grouping, its destructive item last, and the same set in the top bar's title menu.
  - The rule changes in [Interface: sidebar](../design/ui.md#sidebar), [Interface: session](../design/ui.md#session) and the [session lifecycle](../design/session-model.md#session-lifecycle).

## 31. Earlier replies show actions only on hover, and no Fork

- **Reported**: 2026-10-22, with a screenshot of a thread with two red boxes and a close-up of an earlier reply and the latest one. Only recorded for now; the maintainer asked for no change yet.
- **Observed**: the action row under a reply shows its icons only while the pointer is on that message, and no reply but the last has a Fork. The close-up shows an earlier reply with Copy and Read aloud (Copy highlighted under the pointer) and the latest reply with Copy, Read aloud and Fork. At rest an earlier reply shows an empty band where its row is (the first red box), and the latest reply's row is in view (the second).
- **Expected**: not stated beyond the observation; the maintainer did not say what should change.
- **Today**: this is the behavior [Interface: message actions](../design/ui.md#message-actions) specifies, from [problem 5](#5-messages-have-no-action-row): under the latest reply the buttons stay in view, under earlier ones they show on hover or focus "holding their place so the text does not move". In `src/renderer/src/features/session/entries/message-actions.tsx` an earlier reply's row takes `opacity-0` until hover or focus (`REVEAL`), and `showFork` is `latest && canFork && session.origin === 'user'`. Fork stays off the earlier replies because ACP's `session/fork` takes no message to fork at, so a Fork under an earlier reply would still copy the whole session.
- **To settle when planning**: what the maintainer finds wrong, which could be either or both of:
  - The held space: the empty band under each earlier reply reads as a hole. The row could take no space until hover, at the cost of the text moving, or sit in a smaller reserved height, or show at rest in a quieter state.
  - The missing Fork: whether earlier replies should offer it. Without a partial `session/fork` it could only fork the whole session, or OverBench could build the new session from the history up to that reply, which needs a design of its own; rewinding to a message was left out of M0 with checkpoints ([problem 5](#5-messages-have-no-action-row)).
  - Whether the latest reply's always-visible row against the hover-only rows above it is itself the inconsistency.

## 32. No message outline beside the thread, expanding on hover

- **Reported**: 2026-10-22, with two screenshots of the reference (Claude Desktop): the open list and its collapsed state.
- **Observed**: OverBench has no way to see a session's messages at a glance or to jump between them. In a long thread the only help is the button that jumps to the latest message.
- **Expected**: a message list beside the thread, collapsed by default and expanding when the pointer is on it.
- **Reference**: collapsed, a small rail of short horizontal dashes sits at the thread's left edge, one per message, with the one at the reading position darker and wider than the rest. Hovering it opens a floating list on a menu-like surface: a **Session start** row, then a row per message with a short title ("参考菜单设计确认", "消息操作行组件确认") after its dash, the row under the pointer filled, the title at the reading position darkest and the others lighter. The titles read as short summaries of the turns, not the user's own words; that is a reading of one screenshot.
- **Today**: nothing like it. The thread is `MessageScroller` in a 760 px centred column ([Interface: thread](../design/ui.md#thread)), with the jump-to-latest button as its only navigation.
- **To settle when planning**:
  - What an entry stands for: each user message and its turn, the **Session start** row that returns to the top, and whether plans or sub-sessions get any.
  - Where the titles come from. ACP gives a turn no title. The first line of the user's message, cut short, is what a session title falls back to ([session model: titles](../design/session-model.md#titles)) and costs nothing; a written summary like the reference's would need a model call, which OverBench has avoided elsewhere.
  - What a click does in a long thread: scroll to the turn and keep it there, including turns of a history that is mounted in chunks and so may not exist in the DOM yet, within the performance budget at several thousand entries ([M0 performance](../perf/m0.md)).
  - How the reading position is followed without re-rendering the thread on every scroll, and animation that only moves `transform` and `opacity`, with reduce motion honoured.
  - Room: it needs margin beside the 760 px column, so what happens in a narrow window or with the side panel open, and how it sits against the sidebar and the scroll-edge fades.
  - Opening on hover: the delay before it opens and closes, no shift of the thread, the menu surface and its tokens from the [design system](../design/design-system.md#menus-and-dialogs), a list that scrolls when the turns are many, and keyboard reach (focus opens it, arrow keys move, Enter jumps) with an accessible name.
  - Where the rule is written: [Interface: thread](../design/ui.md#thread).

## 33. Title menu needs polish; agent mark goes before the title

- **Reported**: 2026-10-22, with a screenshot of the reference's session title menu (Claude Desktop) and one of OverBench's.
- **Observed**: the top bar shows the session title as a button with a menu, then the agent's mark and its name ("Claude Code") in muted text. The menu holds **New sub-session** (a submenu of agents), **Close** and **Delete…**, and is plainer than the reference's.
- **Expected**:
  - The panel polished toward the reference.
  - The agent's name removed from the top bar, and its mark moved to before the session title. The mark says which agent it is, so the name is not needed.
- **Reference**: the reference's menu has four groups divided by hairlines, with a one-key accelerator at the right of most rows: **Open in** ▸; **Rename** (`R`) and **Fork** (`F`); **Transcript view** ▸ and **Output style** ▸; **Archive** (`A`) and **Delete** (`D`, in the destructive color). In its top bar, with the menu open, the soft fill sits on the chevron alone and the title stays unfilled, where OverBench fills the whole title button; this is a reading of one screenshot. The set of rows is the same question as [problem 30](#30-the-session-context-menu-lacks-rename-pin-and-archive), since the title menu and the sidebar row's menu share their items.
- **Today**: `SessionHeader` in `src/renderer/src/features/session/session-header.tsx` renders the title in a `DropdownMenu`, and after it a span with the agent's `AgentMark` (13 px) and `agentName`, which hides its name below a 520 px top bar and keeps the full name as its `title`. A sub-agent's session already shows a `Bot` icon before its title; a sub-session's top bar starts with its parent's title as a link. [Interface: session](../design/ui.md#session) says "The title is followed by the agent's mark and name in `--muted-foreground`".
- **To settle when planning**:
  - The panel itself: its width, row height, text size, group spacing and accelerators, taken from the reference's menu in the same way as the earlier [menus](../design/design-system.md#menus-and-dialogs) pass, with the rows from problem 30.
  - The mark before the title: its size, whether it is always in colour, and what names the agent once the text is gone (a tooltip and an accessible name; the mark already has a `title`).
  - How it sits with the `Bot` icon of a sub-agent's session and with the parent link of a sub-session: which comes first, and whether a sub-agent keeps both marks.
  - Whether the title button's hit area and hover fill include the mark, so it reads as one control.
  - The rule changes in [Interface: session](../design/ui.md#session).

## 34. The slash command popover looks crude

- **Reported**: 2026-10-22, with a screenshot of OverBench's popover (the fake agent's commands, in development) and one of the reference's (Claude Desktop). The maintainer finds it too rough to want to use.
- **Observed**: typing `/` opens a wide list. Each row is the command as `/name` in mono, followed by its description in muted text, and most descriptions are cut off with an ellipsis mid-sentence ("A short answer with markdown and one edit …", "Signs the agent out; requests fail until yo…"). It reads as a log rather than a menu.
- **Expected**: the popover reaches the reference's polish.
- **Reference**: a narrow popover of one-line rows. Each row is the command's name alone, in the interface font, with no slash and no description. The row under the pointer or the keyboard takes a fill, and its description shows in a dark tooltip beside the list ("Rewind the session to an earlier message"). The list scrolls behind a fade at its bottom, and the composer shows "Type to filter" after the typed `/`.
- **Today**: `src/renderer/src/features/session/composer/composer.tsx` builds it from Base UI's `Autocomplete`: a popup at most 420 px wide and 320 px high, `rounded-xl` with 4 px padding, so not the refined [menus'](../design/design-system.md#menus-and-dialogs) radius and padding, and rows of `/name` in `font-mono text-xs` over a truncated description. Matching is a substring test on the name, in the agent's order, and the popup stays closed when nothing matches. [Interface: composer](../design/ui.md#composer) specifies it in one line ("a `Command` popover with the agent's `available_commands_update` list, filtered as you type"). The commands in the screenshot are the fake agent's test scenarios; a real agent's list, with its skills, differs in content but not in layout.
- **To settle when planning**:
  - What a row holds: the name alone with the description in a tooltip, as the reference, or the name with a short description kept. Descriptions come from the agent and can be long, so cutting them mid-sentence is what reads badly.
  - Whether the name keeps its `/` and the mono face, and how the typed text shows in the matches.
  - The width: fitted to the longest name, as the menus are, instead of a fixed 420 px.
  - The shared menu tokens: radius, padding, row height, and the fill of the highlighted row, so this popover matches the other menus in both themes.
  - Ranking and grouping: the agent's order is kept today; whether names that start with the query come before those that only contain it, and whether built-in commands and skills are told apart. ACP's list carries no grouping.
  - The empty state when nothing matches, the "Type to filter" hint in the composer, and the input hint a chosen command shows, which exists.
  - A list of hundreds of commands from an agent with many skills, and whether it needs more than scrolling behind the fades.
  - The tooltip's delay and placement, keyboard use (arrows, `Enter`, `Tab`, `Esc` as now), and reduce motion.
  - The rule rewritten in [Interface: composer](../design/ui.md#composer).

## 35. The palette is black and grey and reads as cheap

- **Reported**: 2026-10-22, with a screenshot of the reference (Claude Desktop) showing a session. A direction for the whole system rather than one screen.
- **Observed**: OverBench reads as black and grey from end to end, and next to the reference it has a cheap feel.
- **Expected**: the system's colours stay as low-key and restrained as possible, but that does not mean going all black and grey. The reference's style is restrained too, yet it does not feel cheap; OverBench still needs polishing to get there.
- **Measured** on the reference screenshot (2x, one capture, the display's colour profile not accounted for): sidebar `rgb(250, 251, 248)`, main surface `rgb(252, 251, 252)`, selected row `rgb(240, 240, 238)`, composer `rgb(255, 255, 255)`, inline code chip `rgb(240, 240, 240)`, body text near black (`rgb(6, 6, 6)`). The inline code's text is a dark red (about `rgb(115, 44, 47)` to `rgb(153, 65, 63)`), and the screenshot shows a terracotta spinner and a yellow context ring on the model button. File links in the earlier screenshots are blue.
- **Today**: every neutral token in `src/renderer/src/styles/globals.css` has zero chroma, so they are pure greys: `--sidebar` is `oklch(0.982 0 0)`, about `rgb(249, 249, 249)`, and `--background` `oklch(0.991 0 0)`, about `rgb(252, 252, 252)`. The surfaces are therefore close to the reference's by number, and what separates the two is the small touches of colour. [Design system: design reference](../design/design-system.md#design-reference) keeps "a neutral palette, its own semantic colors and Inter", and the semantic colours (success, attention, destructive, checked blue, merged, the effort gradients) are used for state only. Earlier passes kept the palette neutral on purpose, as in [problem 22](#22-the-new-session-project-and-agent-menus-look-crude).
- **To settle when planning**:
  - What "low-key but not grey" means as a rule: where colour is allowed (the body's code, links and file references of [problem 6](#6-markdown-looks-plain-and-file-references-do-not-stand-out), the checks and selection of [problem 4](#4-the-model-menu-does-not-look-polished), spinners and progress, state), how much chroma, and where it never appears. Both themes, at readable contrast.
  - Whether the surfaces take a slight tint. The reference's sidebar differs from a pure grey by a few levels; one screenshot is too little to decide, so measure more before changing a surface.
  - Where the cheap feel comes from. Colour is one part; weights, borders, shadows, radii, icon strokes and spacing are others. A side-by-side audit of the main screens against the reference, in both themes, belongs before the tokens change, in the way of the [menus pass](../design/design-system.md#menus-and-dialogs), with before and after screenshots.
  - The rule rewritten in [Design system](../design/design-system.md) and the tokens in `globals.css`, including whether the "neutral palette, no accent" statement stands as written.

## 36. The composer has no + menu, file or image attachments

- **Reported**: 2026-10-22, with a screenshot of OverBench's composer and one of the reference's (Claude Desktop) with its **+** menu open.
- **Observed**: the composer is a bare text field: the placeholder ("Ask Fake agent to…"), the send button, and a row below with the mode and the model. Nothing in it adds a file, a photo or a folder.
- **Expected**: the composer supports file upload and the like, as the reference's does.
- **Reference**: a **+** button at the left of the input opens a menu: **Add files or photos** (`Mod+U`), **Add folder**, **Slash commands**, **Connectors** ▸ and **Plugins** ▸. The placeholder reads "Type / for commands".
- **Today**: [M0](./m0.md#out-planned-for-later-milestones) leaves out "`@` file mentions and image attachments in the composer", and the README's roadmap lists "`@` file mentions and images in the composer". The protocol allows it: all three agents advertised prompt `image` and `embeddedContext`, and `additionalDirectories` ([Architecture: capabilities](../architecture.md#agents)). The composer ([Interface: composer](../design/ui.md#composer)) holds text only, with `/` for the agent's commands.
- **To settle when planning**:
  - What the **+** menu holds, by what OverBench can back: files and photos (ACP prompt `image`, and `embeddedContext` or a resource link for a file), a folder (`additionalDirectories`, which is given when a session starts, so whether one can be added to a running session is not known), and **Slash commands** (the `/` popover of [problem 34](#34-the-slash-command-popover-looks-crude), which exists). **Connectors** and **Plugins** need MCP configuration and plugins, which are out of M0 and were not asked for.
  - Other ways in, beyond the menu: dragging onto the composer, pasting an image or a file, and `@` file mentions from the project's file list, which the [Files pane](../design/ui.md#files) already reads.
  - How an attachment is sent: an image as an `image` block, a text file embedded or sent as a link to its path, a binary refused, and a size limit, all gated on what the agent advertised, with the control disabled or explained when it did not.
  - How it shows: thumbnails or chips above the input with a remove button, the same in the sent message and in a replayed one (`session/load`), which needs the thread model's user entries to carry attachments.
  - How it reaches the host safely: the file is read in the main process or the agent host after the path is validated, never by loosening the sandbox; its size and kind are checked there, and nothing is embedded without the user having added it.
  - What it touches in the composer: [drafts](../design/persistence.md#composer-drafts) keep attachments, a queued or steering message carries them, and the placeholder teaches `/` as the reference's does.
  - The rule written into [Interface: composer](../design/ui.md#composer), and M0 and the README's roadmap updated if it comes in.

## 37. Icons look heavy; use thin line icons from a library

- **Reported**: 2026-10-22, with a screenshot of the reference (Claude Desktop) and red arrows at its sidebar icons (Projects, Customize, More) and at the folder icon in its top bar. A direction for the whole system.
- **Observed**: OverBench's icons read as heavy and without beauty.
- **Expected**: the icons across the system are thin line icons. Lucide is fine as the library, or any other suitable one. One rule is firm: icons are never drawn by hand; they come from an established icon library.
- **Reference**: the arrowed icons are thin line icons, with strokes visibly lighter than OverBench's at a similar size. That is a reading of one screenshot, not a measurement.
- **Today**: every UI icon is Lucide (`lucide-react` 1.60.0, imported in 55 files), as [Contributing](../../CONTRIBUTING.md) requires ("Do not mix in other icon sets or inline SVGs for UI icons"). Lucide draws at stroke width 2 by default, and call sites override it one by one: `strokeWidth` is set to 2 in 12 places, 1.8 in 4, 1.5 in 3, 2.25 in 2, and 1.6, 1.4 and 1.2 once each, with no shared rule, so the line weight changes from screen to screen. The size is `--icon-size` (16 px, and 14 px inside cards and controls); [Design system](../design/design-system.md) states no stroke width. A few shapes are solid on purpose (`fill-current` on the stop squares). Inline SVGs remain in `branch-lane.tsx` and the usage pie in `usage.tsx`, which are data graphics, and in `agent-mark.tsx`, whose brand marks come from [`@lobehub/icons`](https://github.com/lobehub/lobe-icons).
- **To settle when planning**:
  - The weight: one stroke width for all Lucide icons, set in one place instead of at each call site (a CSS rule on Lucide's `svg.lucide` or the library's own provider, to check against 1.60), with `absoluteStrokeWidth` or not so that sizes keep the same line. Judged side by side with the reference on 1x and 2x displays in both themes, since a thin stroke at 14 to 16 px can look faint on 1x.
  - Whether Lucide's glyphs read light enough at the chosen weight. If not, another set with a light weight replaces it everywhere, because the stack allows one icon library, and a new dependency needs the maintainer's approval. The maintainer replied on 2026-10-22 that the library is not fixed to Lucide: a shortlist to choose from is welcome, and so is pushback where something better exists. The shortlist is yet to be made, from established libraries only, compared on the weights each offers, the glyph coverage the app needs, the licence, the React package's size and tree-shaking in the renderer bundle, and upkeep, each tried on the sidebar, top bar and composer in both themes.
  - Which icon stands for which concept, picked only from the library and checked screen by screen: the sidebar's rows, the top bar's tools, the composer and the menus. The reference's choices guide what to look for; its drawn icons and brand assets are never copied.
  - The solid shapes (stop squares, status dots): whether they stay.
  - Whether the no-hand-drawing rule covers the existing inline SVGs. The branch lane and the usage pie are data graphics and the agent marks are brand marks from a library, so they are not UI icons in the sense of Contributing, but that is for the maintainer to confirm.
  - The rule written into [Design system](../design/design-system.md), beside the icon size, and into Contributing.

## 38. Files pane: no markdown preview, file-type icons or editing

- **Reported**: 2026-10-22, with a screenshot of the Files pane with `README.md` open.
- **Observed**: three gaps in the pane.
  - A Markdown file shows only as highlighted source, with no way to switch to a rendered preview.
  - Every file in the tree has the same plain file icon, and every folder the same folder icon.
  - A file cannot be edited.
- **Expected**:
  - A Markdown file can be switched between its source and a rendered preview.
  - File icons by type, such as the logo of TypeScript or Go for their files. The maintainer asked that the scheme follow the standard practice, to be looked at before choosing.
  - Files can be edited in the pane.
- **Today**: [Interface: files](../design/ui.md#files) makes the pane read-only. The tree rows use Lucide's `FileIcon` and `FolderIcon` (`files-panel.tsx`), and the preview header has no icon. The preview is the diffs library's `File` on the shared worker pool, virtualized, with highlighting by Shiki. The host reads a file up to 1 MiB as text and has no write request ([Agent host: project files](../design/agent-host.md#project-files)); the ACP `fs` client capabilities are off, so the agent edits files on its own. The list and the open file reload when git status changes or the window gains focus ([Interface: files](../design/ui.md#files)).
- **To settle when planning**: the three differ a lot in size. The preview toggle is small, the icons are a library choice, and editing is large and a product decision about how far OverBench goes as an editor.
  - **Markdown preview**:
    - The toggle's place in the preview header, and whether the choice is remembered.
    - The rendering goes through Streamdown, the markdown renderer the thread already uses, rather than a second one, so the look follows the thread's; this ties to the markdown design of [problem 6](#6-markdown-looks-plain-and-file-references-do-not-stand-out).
    - Relative links and images in the file: the CSP blocks remote images, and a local one would have to come through the host.
  - **File icons**:
    - The standard practice to look at: the file icon themes of editors, which map a file's name and extension to an icon, and folders by name, and the libraries that package such sets for the web. Which one, its licence, and its size need checking.
    - The rule from [problem 37](#37-icons-look-heavy-use-thin-line-icons-from-a-library) holds: icons come from an established library, never drawn by hand.
    - Language logos are coloured, so how they sit with a thin line icon system and with the restrained palette of [problem 35](#35-the-palette-is-black-and-grey-and-reads-as-cheap), as the agent marks do.
    - Cost in a virtualized tree of up to 50,000 rows: icons loaded lazily, nothing parsed per row.
    - Where they show: the tree, the list, the search results, the preview header, and file references in the thread.
  - **Editing**:
    - An editor component. The current preview is not one, so this means a new dependency, which needs the maintainer's approval, loaded lazily like the other heavy modules.
    - A write request in the host, with the containment and symbolic link rules of reads, an atomic write, a size cap, and care for encoding, line endings and file mode.
    - Unsaved state: a dirty mark, `Mod+S`, and a prompt when closing or switching a file or quitting.
    - Conflicts: the open file reloads from disk today, which must not discard unsaved edits, and an agent may edit the same file meanwhile.
    - Whether the agent should be told about a user's edits, and how far editing goes: plain text with highlighting and save, or an editor with search and more.
  - **Where the rule goes**: [Interface: files](../design/ui.md#files) and the [host's project files](../design/agent-host.md#project-files), which both say read-only today.

## 39. Terminal tabs cannot be renamed or reordered and look crude

- **Reported**: 2026-10-22, with a screenshot of the terminal panel holding two tabs, both titled "zsh".
- **Observed**: a tab's title always follows its foreground process, so two shells show the same name and cannot be told apart; the tabs keep the order in which they were opened; and the maintainer finds the tabs' look somewhat ugly.
- **Expected**: tabs can be renamed and dragged into a new order, and the tab strip is redesigned to look better.
- **Today**: [Interface: terminal](../design/ui.md#terminal) describes the tabs: 24 px high, the `SquareTerminal` icon and the foreground process as the title, the active tab raised like a segmented control's thumb, a hovered one on a flat fill, a close button, and **New terminal** after the last tab. `TerminalTab` in `src/renderer/src/features/terminal/terminal-panel.tsx` renders them from the terminal's `title`, which the host sets from the process or the shell ([Terminal](../design/terminal.md)); the user has no title of their own and no way to reorder. `@dnd-kit/react`, the one drag library the stack names, is a dependency already but nothing in `src` uses it yet.
- **To settle when planning**:
  - **Rename**: how it starts (double-click a tab, a context menu item, a key), editing in place with `Enter` to accept and `Esc` to cancel and no send of half-typed text during IME composition, and an empty name returning the tab to its automatic title. A renamed tab stops following the process, so where the process shows (a tooltip) needs deciding. Terminals do not survive a restart in M0, so whether the name needs saving at all follows from that.
  - **Reorder**: sortable tabs through `@dnd-kit/react`, with the row that scrolls when the tabs overflow, keyboard reordering, a drag preview and drop motion that move only `transform`, and the order kept per project.
  - **The design**: what makes the strip ugly was not itemised. In the screenshot the two labels are identical, the close button shows on the active tab only, the raised active tab sits against a flat inactive one, and **New terminal** floats apart from the tabs. A redesign should be drawn against the reference's tabs and checked in both themes, with the palette and icon decisions of [problem 35](#35-the-palette-is-black-and-grey-and-reads-as-cheap) and [problem 37](#37-icons-look-heavy-use-thin-line-icons-from-a-library) applied.
  - A tab's context menu (rename, close and the like) is a candidate that was not asked for.
  - The rule rewritten in [Interface: terminal](../design/ui.md#terminal) and [Terminal](../design/terminal.md).
