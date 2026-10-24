# UX guidelines

> Status: Draft · Part 2 of the design rules, with [visual style](./visual-style.md) · Gate: [design process](./design-process.md) · Screens in [Interface](./ui.md)

How OverBench behaves: where a function lives, how it answers, when it asks for attention, how it fails, how it is reached from the keyboard and how it reads. [Visual style](./visual-style.md) is how it looks; every design passes both through the [design process](./design-process.md). [Interface](./ui.md) applies these rules screen by screen and names any exception, with its reason.

- A case these rules do not cover is decided once and written here first, then built.
- Most rules come from the maintainer's decisions in [M0 feedback](../milestones/m0-feedback.md); the problem number is given where the reason matters.

## Principles

1. **Instant.** A click or a key answers in the next frame. Switching sessions, opening a pane and sending a message never wait for an agent unless the answer can only come from it ([problems 12, 54](../milestones/m0-feedback.md#54-opening-a-session-starts-its-agent-and-keeps-it-running)).
2. **Nothing the user made is lost.** Drafts, unsaved edits, queued messages and settings survive a failed start, a crash, a conflict and a restart. When losing something is the only way forward, the app asks first.
3. **The user stays in charge of the agent.** What the agent is about to do on the machine is shown before it happens, running work can be stopped at once, and nothing the agent did is hidden: its work folds, its messages never do ([problem 1](../milestones/m0-feedback.md#1-thoughts-and-tool-calls-cannot-be-folded-together)).
4. **Calm.** Only what needs the user asks for attention; everything else is quiet and stays quiet. A mark goes once the user has seen what it points at.
5. **In place.** Things happen where the user is looking: a rename in the title, a status in the composer's frame, an error under the message that caused it. Dialogs and full screens are the exception.
6. **One way in.** Each function has one place in each area of the window. A second button for the same action is removed, not styled ([problem 13](../milestones/m0-feedback.md#13-the-git-popover-only-displays-and-repeats-the-terminal-toggle)).
7. **Keyboard and pointer are equal.** Everything the pointer can do, the keyboard can, and the other way round.
8. **Agent-neutral, platform-native.** The same interface for every agent, showing differences only where an agent offers more or less; on each platform, that platform's conventions.

## Structure

Where a function lives. A function goes to the narrowest scope it acts on, and the same object offers the same items wherever its menu appears.

| Scope               | Lives in                                                                                                 | Examples                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| The app             | The app menu (macOS), the sidebar's top rows and footer, Settings                                        | New session, Settings, updates, zoom      |
| A project           | Its group row in the sidebar: name, chevron, **+**, and its menu (context menu and **More**)             | A new session, importing sessions         |
| A session           | Its sidebar row (context menu and **More**) and the top bar's title and title menu, from one shared list | Rename, new sub-session, close, delete    |
| A message or turn   | The message's action row                                                                                 | Copy, fork                                |
| The next prompt     | The composer, its control row and the model menu                                                         | Mode, model, reasoning level, attachments |
| The project's tools | One pane at a time in the side panel, each opened by its toggle in the top bar                           | Files, terminal                           |
| The repository      | The git status in the top bar and its branch popover                                                     | Branch, pull request, fetch               |
| A preference        | Settings, in the section of the thing it changes                                                         | Theme, default agent, proxy               |

- An action that appears in several menus comes from one item list, so the menus never differ ([problem 30](../milestones/m0-feedback.md#30-the-session-context-menu-lacks-rename-pin-and-archive)).
- A feature that is not built does not show. The exceptions are named in [Interface](./ui.md) with their reason, such as the disabled **Artifacts** row.
- Settings holds what the user sets once; what the user changes during work, such as the model, lives where the work is.

## Navigation and focus

- `Esc` closes the topmost layer: a tooltip or menu, then a popover or dialog, then an edit in place, then Settings when no field has focus. In the composer, with nothing open, it cancels the running turn.
- When a layer closes or an edit ends, focus returns to what opened it.
- Opening something puts focus where the user acts next: the composer on a new session, the field with its text selected on a rename, the search field in a search menu.
- A list that acts as one control has one Tab stop and moves with the arrow keys ([layout behavior](./design-system.md#layout-behavior)).
- **Back** returns to where the user was, not to a fixed screen.
- A layout choice the user makes, such as a pane's width, a folded list or the open pane, is kept for when they come back; which of them survive a restart is written in [persistence](./persistence.md).

## Feedback

Every action shows that it was received, scaled to how long it takes:

| Takes           | The user sees                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Under 100 ms    | The result, nothing else                                                                                                                    |
| Up to about 1 s | The user's own part at once (a sent message, a chosen item); a placeholder only after 200 ms, so a quick answer shows no flash              |
| Longer          | What is happening, in words, where the result will appear: "Starting Claude Code…", then the agent's latest line ([states](./ui.md#states)) |
| Minutes         | The work carries on in the background; the sidebar row shows it running and marks it when it ends, so the user can leave and come back      |

- **Show it where the result will be.** A status takes the place of what it is waiting for, at its size, so the result replaces it without a shift ([problem 12](../milestones/m0-feedback.md#12-switching-sessions-visibly-stalls)).
- **Only the part that waits shows waiting.** No spinner over the whole window, no modal wait; the rest stays usable.
- **The change is the confirmation.** A setting that changes, a row that moves or an icon that turns into a `Check` (copy) says it worked; no extra message for what the user can see.
- **Settings apply at once**, with no Save button. A value that must be complete to be valid, such as a proxy URL, applies once it is.

## Attention

Four levels, from quiet to loud. A signal takes the lowest level that is true.

| Level   | Means                              | Shows as                                                                                 |
| ------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Working | A turn is running                  | A muted `Spinner` on its row                                                             |
| New     | A turn finished out of view        | A muted dot on its row, until the session is shown                                       |
| Waiting | The agent needs an answer to go on | `--attention`: the dot on the row, the ring on the card, the count on Settings' **Back** |
| Failed  | Something failed out of view       | The error mark on its row, until the session is shown                                    |

- **A mark goes once its cause is seen** ([problems 46, 57](../milestones/m0-feedback.md#57-a-finished-session-leaves-no-mark-and-the-running-dot-is-loud)); the record of it, such as the error notice in the thread, stays.
- **A signal is never lost by navigating away**: when its source leaves the screen, the way back carries it, as Settings' **Back** carries the waiting count.
- **Only waiting and failure interrupt**, and only through the system notifications the user turned on, and only while no OverBench window is focused ([Settings](./ui.md#settings)). Nothing pops up over the user's work.
- `--attention` is kept for waiting. Using it for anything else teaches the user to ignore it.

## Errors

- **Say what failed in the user's terms, then the next step** as a button: **Retry**, **Sign in…**, **Reconnect**, **Export diagnostics**. An error with no way forward or out is a design bug.
- **Show it where it happened**: under the message, above the composer, in the row or the field; never in a global dialog for a local failure.
- **Recover by itself when it can, and say so** ("Reconnecting…"); ask the user only when it cannot.
- **Keep the user's input** through every failure: a failed send leaves the draft, a failed save leaves the edits.
- **Detail is there, but second.** The agent's stderr, an exit code or a path follows the human sentence, in mono and selectable; it is never the only text.

## Destructive actions

- **Confirm only what cannot be undone**, with an `AlertDialog` that names the thing and what will be lost, and a button that names the action (**Delete**, never **OK**) in the `destructive` variant.
- **What can be undone or recovered does not ask.** Closing a session keeps it in the list, so it needs no confirmation.
- In a menu, the destructive item comes last, after a separator; an item that will ask first ends with an ellipsis (**Delete…**).
- Quitting or restarting while agents work, terminals run or files are unsaved lists what would stop and asks ([updates](./ui.md#updates)).

## Empty and first run

- Every pane, page and list has an empty state. A pane or page shows one centred `Empty` that says what will appear there and, when one exists, offers the action that fills it; a list inside a column, such as the sidebar's, shows one quiet line at its top.
- An empty area shows no controls that have nothing to act on ([problem 56](../milestones/m0-feedback.md#56-the-empty-files-panes-hint-is-not-centred)).
- The first run leads to the first useful action in one step: open a project, then start a session.

## Disclosure

- **Fold the agent's work, never its words.** Everything between two messages folds into one summary line; a message always stays in view ([problem 1](../milestones/m0-feedback.md#1-thoughts-and-tool-calls-cannot-be-folded-together)).
- **Hover reveals actions, never what is needed to choose.** A row's name and state are always shown; its actions may wait for hover. A folded group always shows its chevron, an open one only on hover ([problem 23](../milestones/m0-feedback.md#23-the-project-chevron-sits-before-the-name-and-always-shows)).
- **What hover reveals, focus reveals too**, so the keyboard reaches it, and it holds its place so nothing moves.
- **Tooltips carry the rest**: a truncated name in full, a description too long for its row, the reason a control is disabled, an icon button's name and shortcut.

## Menus and choosing

- Choosing an item closes the menu, unless the item is one of several settings changed together, such as the reasoning level and the switches in the model menu ([problem 2](../milestones/m0-feedback.md#2-choosing-a-model-does-not-close-the-model-menu)).
- Items are ordered by use, grouped by kind with separators, the destructive one last.
- A list that can grow without bound, such as the projects or OpenCode's models, has a search field on top ([search menus](./design-system.md#menus-and-dialogs)).
- A choice among two to six exclusive values is a segmented control; a longer one is a select; an on or off value is a switch.

## Text input

- The send key follows **Send with** in Settings; the other key adds a newline. Nothing sends during IME composition.
- An edit in place saves on `Enter` or when the field loses focus, and `Esc` restores the text it started with. An emptied name returns to the automatic one.
- A field validates when its value is complete, not on every keystroke, and says what is wrong beside itself.

## Keyboard

- Every action can be reached from the keyboard. Frequent ones have a shortcut on `Mod`, which is `Cmd` on macOS and `Ctrl` on Windows and Linux.
- A shortcut shows in the tooltip and the menu that hold its action, and in Settings › Keyboard shortcuts; never as a hint on a row ([problem 25](../milestones/m0-feedback.md#25-the-sidebar-footer-needs-a-design-of-its-own)).
- A new shortcut is checked against the [shortcut table](./ui.md#keyboard) and the platform's own before it is added there.

## Agents

- **Same interface for every agent.** A control the current agent cannot back is hidden, as **Fork** is without `session/fork`; a control that applies but cannot act right now is disabled, with the reason in its tooltip.
- **The agent's names stand.** Models, reasoning levels and commands show as the agent names them; OverBench does not relabel them ([problem 4](../milestones/m0-feedback.md#4-the-model-menu-does-not-look-polished)).
- **Before it acts, show what it will do.** A permission request shows the exact command or change and answers with one key.
- **Stop is always one key away** while a turn runs: `Esc`, or the Stop button.
- **Never spend the user's quota unasked.** What OverBench reads for display, such as usage, limits and titles, comes from what costs no model call. The one exception, accepted on 2026-10-23 ([#143](https://github.com/overbench/overbench/issues/143)), is the title Claude Code's adapter may ask for after a long `/usage` report ([reading the limits from `/usage`](./session-model.md#reading-the-limits-from-usage)).
- **Output streams.** The agent's text and tool calls appear as they arrive, never held back until the turn ends.

## Platforms

- macOS, Windows and Linux are equal targets. Each gets its own window controls, menu conventions, modifier key and names for its tools (Finder, File Explorer, the file manager).
- A behavior that differs by platform is written in [Interface](./ui.md) for each one, never left to whichever platform it was built on.

## Copy

- Every string goes through i18next, in English and Simplified Chinese, and follows the [writing rules](./localization.md#writing-messages) and the Chinese glossary.
- **Plain, short and specific.** Say what happened and what to do next. No blame, no exclamation marks, no filler such as "Please" or "Successfully".
- **Sentence case** for English labels, buttons, menu items and titles: **New session**, not **New Session**.
- A button names its action with a verb. An item that asks for more before it acts ends with an ellipsis: **Open project…**, **Delete…**.
- **No redundant words.** A state that needs nothing from the user can go without one, as the **Ready** dot does; a state that asks something of the user always says it ([problem 28](../milestones/m0-feedback.md#28-the-ready-label-next-to-the-status-dot-is-redundant)).
- Numbers carry their unit, and a time reads the way the user needs it: how long until a reset, how long ago a commit, not a raw timestamp.

## Accessibility

The rules in [Interface: accessibility](./ui.md#accessibility) hold for every design: every control has a name and a visible focus, status is never color alone, contrast meets WCAG AA in both themes, turn ends and permission requests are announced, and reduce motion is honored.

## Checklist

Before a UI change goes up for review, with the [visual checklist](./visual-style.md#checklist):

1. The function lives at its narrowest [scope](#structure), with one way in per area and one shared item list where it repeats.
2. Every action answers in the next frame, and longer waits follow the [feedback](#feedback) table, in place.
3. Its signals take the right [attention](#attention) level, and their marks go once seen.
4. Every error says what failed and what to do next, where it happened, and keeps the user's input.
5. Only what cannot be undone asks first; destructive items come last.
6. Empty, loading, error and first-run states exist.
7. It works from the keyboard: reachable, `Esc` closes it, focus returns, shortcuts are listed.
8. It behaves the same for every agent, gated by capability, and spends no quota unasked.
9. Its copy is in both languages, sentence case, plain.
10. It follows each platform's conventions.
