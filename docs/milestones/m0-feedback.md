# M0 acceptance feedback

> Status: Collecting · [M0](./m0.md) · [All docs](../README.md)

Problems the maintainer found while using M0 by hand. Each one is recorded as reported, with where it lives today; fixes are planned together once the list is complete, and the design docs change with them.

| #   | Problem                                                        | Area           | Status       |
| --- | -------------------------------------------------------------- | -------------- | ------------ |
| 1   | Thoughts and tool calls cannot be folded together              | Thread entries | Fixed        |
| 2   | Choosing a model does not close the model menu                 | Model menu     | Fixed        |
| 3   | No switch for Claude Code's ultracode                          | Model menu     | Fixed        |
| 4   | The model menu does not look polished                          | Model menu     | Open         |
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
| 15  | Settings selects show names only and keep the default look     | Settings       | Partly fixed |
| 16  | Switches keep shadcn's default look                            | Settings       | Open         |
| 17  | Settings › Agents leaves out what matters                      | Settings       | Partly fixed |
| 18  | The About page needs redoing                                   | Settings       | Open         |
| 19  | Settings leave too much empty space                            | Settings       | Open         |
| 20  | Collapsing the sidebar is abrupt                               | Sidebar        | Fixed        |
| 21  | No file browser or preview                                     | Side panel     | Fixed        |
| 22  | The New session project and agent menus look crude             | New session    | Open         |

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
- **Partly fixed** in `162ddd7` and `074b216`: both sources exist now, for Claude Code. The plan limits come from Claude Code's `/usage`, read when the popover opens, so every window shows its current use and reset ([Session model: reading the limits from `/usage`](../design/session-model.md#reading-the-limits-from-usage)); what fills the context comes from `/context`, run in a throwaway fork of the session ([Session model: context breakdown](../design/session-model.md#context-breakdown)). Neither costs a model call, and both run in sessions the host deletes afterwards. The popover shows the breakdown as rows in its current layout ([Interface: usage popover](../design/ui.md#usage-popover)). Checked against a live Claude Max session: three windows (5-hour, weekly, weekly Fable) with their resets, and the categories with the memory file and 69 skills, each in 3 to 5 s. Still to do: the popover's redesign, and the plan's tier ("Max (5x)"), which neither report gives; Codex and OpenCode have no such reports.

## 8. Session rows show their time badly

- **Reported**: 2026-10-21, with a screenshot of the sidebar.
- **Observed**: the relative time on each session row ("6m", "3h") leaves a wide empty gap before the row's right edge, which looks off, and a time on every row makes the list look busy.
- **Expected**: whether rows show a time at all, and how, is decided by design first.
- **Today**: [Interface: sidebar](../design/ui.md#sidebar) gives every row that is not running or starting a relative time. In `src/renderer/src/features/sidebar/session-indicator.tsx` the time is followed by a 16 px slot (`w-4`) for the status indicator, kept even when the row has no indicator, which is the gap after the time. To settle when planning: whether the time shows always, on hover only or not at all, and how it shares the row's end with the status indicators.

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

## 16. Switches keep shadcn's default look

- **Reported**: 2026-10-21, with a screenshot of two switches in Settings › General.
- **Observed**: the switches in Settings are shadcn's stock switch, a black track with a white thumb when on.
- **Expected**: a round of customisation in OverBench's own style.
- **Today**: `src/renderer/src/components/ui/switch.tsx` is unchanged since it was added. The design system only lightens `--input`, the unchecked track, and leaves switches with shadcn's own feedback ([Design system: meaning](../design/design-system.md#meaning)). The same switch appears in Settings (`SettingSwitch` in `src/renderer/src/features/settings/controls.tsx`) and in the model menu, for options such as Fast mode. To settle when planning: the switch's design (size, on and off colours in both themes, thumb, motion), done together with [problem 15](#15-settings-selects-show-names-only-and-keep-the-default-look) so the settings controls match.

## 17. Settings › Agents leaves out what matters

- **Reported**: 2026-10-21, with a screenshot of Settings › Agents.
- **Observed**: the page falls well short. Each card shows the agent's status and launch command, and some a version and the account, but the core facts are missing. Claude Code's subscription usage is the clearest case: its card has a single 5-hour row with an empty bar and "—", so how much quota is left cannot be seen. Also in the screenshot: Claude Code's "v0.94.0" is the ACP adapter's version, Codex shows neither a version nor an account, and the footer read "Reading your environment…".
- **Expected**: the page reworked to show each agent's core facts, starting with how much of Claude Code's subscription quota is left.
- **Today**: `src/renderer/src/features/settings/agents-section.tsx` follows [Interface: settings](../design/ui.md#settings): status with its next step, the version from `agentInfo`, the launch command, the Node.js version, the account, and its plan limits when the agent reports them. The plan limits come from the same place as the usage popover's, so they share the gap in [problem 7](#7-the-usage-popover-shows-too-little-and-needs-a-full-redesign): only windows Claude Code has pushed, with "—" when `utilization` is missing. To settle when planning: which facts each card shows and where each comes from (subscription usage, the agent's own version besides the adapter's, the account for Codex and OpenCode), solved together with problem 7.
- **Partly fixed** in `162ddd7`: each Claude Code card shows its plan limits read afresh from `/usage` while it runs, and a stopped one offers **Check plan limits** ([Interface: usage popover](../design/ui.md#usage-popover)). Still to decide with the page's redesign: the other facts each card shows, the agent's own version besides the adapter's, and the account for Codex and OpenCode.

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
