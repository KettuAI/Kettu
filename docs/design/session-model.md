# Session model

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.2](../milestones/m0.md#work-packages)

This document defines OverBench's own model of a session and its thread, how ACP v1 maps onto it, and the rules for prompts, permissions, cancellation and recovery. The model lives in `src/shared/thread.ts` and is used by both the agent host and the renderer. It never imports ACP types; only the mapper in `src/agent-host/acp/` does.

## Ownership

- The **agent host** holds the authoritative state of every live session. The mapper turns ACP messages into patches, and the host applies them to its copy.
- The **renderer** holds a replica of the sessions it shows. It starts from a snapshot and applies patch batches in sequence order.
- Both sides apply patches with the same rules from `src/shared/thread.ts`, so they cannot drift apart. The renderer uses `applyPatches`, which shares every unchanged object. The host owns its copy alone and uses `applyPatchInPlace`, which writes into its `order` and `byId` instead of copying them per patch: with a copy per patch a `session/load` replay of N entries is O(N^2), 3.1 s of patching at 4,000 entries against about 1 ms in place. Unit tests hold the two equal, and the host's process tests compare a replica built with `applyPatches` with the host's snapshot.

## Types

The TypeScript below is normative: implementation types may add fields, but not change these.

### Session

```ts
type SessionStatus =
  | 'starting' // agent starting, or session/new, load or resume in flight
  | 'auth_required'
  | 'ready'
  | 'running' // a prompt turn is in progress
  | 'awaiting_permission' // running, with at least one unanswered permission request
  | 'failed' // could not start or recover; needs user action
  | 'closed'

interface SessionView {
  id: string // OverBench id; ACP ids are only unique per agent
  agentId: AgentId
  projectPath: string // canonical absolute path
  acpSessionId: string | null
  status: SessionStatus
  title: string | null
  config: ConfigOption[]
  commands: SlashCommand[]
  usage: SessionUsage | null
  error: { message: string; detail?: string } | null
  turnStartedAt: number | null
  createdAt: number
  updatedAt: number
  parentId: string | null // the parent session, for sub-sessions
  origin: 'user' | 'subagent'
  subagent: SubagentInfo | null // set when origin is 'subagent'
  queue: QueuedPrompt[] // prompts waiting for the running turn, oldest first
  queuePaused: boolean // after Stop, a failed turn or a restart, until the user resumes it
}

interface QueuedPrompt {
  id: string
  content: UserContent[]
  at: number
}

interface SessionUsage {
  used: number // tokens in the context window now
  size: number // the context window
  cost: { amount: number; currency: string } | null
  tokens: TokenTotals | null // session totals, summed over its turns, when the agent reports them
}

interface TokenTotals {
  total: number
  input: number
  output: number
  thought: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

interface SubagentInfo {
  description: string | null // the parent's description of the child's purpose
  canCancel: boolean // the child's `capabilities.cancel`
  stateKnown: boolean // false after an `unknown` state, until a known one arrives
  stopReason: string | null // from the last `idle` state
}

interface ConfigOption {
  id: string
  name: string
  description?: string
  category: 'mode' | 'model' | 'model_config' | 'thought_level' | 'other'
  type: 'select' | 'boolean'
  value: string | boolean
  choices?: { value: string; name: string; description?: string; group?: string }[]
}

interface SlashCommand {
  name: string
  description: string
  inputHint?: string
}
```

### Thread entries

```ts
type ThreadEntry =
  // `at`: when a live message was sent or began; a replay carries no times, so it has none.
  // `steered`: sent into a running turn rather than as a turn of its own.
  | { kind: 'user'; id: string; content: UserContent[]; at?: number; steered?: boolean }
  | {
      kind: 'agent'
      id: string
      markdown: string
      attachments: ContentRef[]
      streaming: boolean
      at?: number
    }
  | { kind: 'thought'; id: string; markdown: string; streaming: boolean; durationMs?: number }
  | ToolEntry
  | { kind: 'subagent'; id: string; sessionId: string } // a sub-session the agent started here
  | { kind: 'session_message'; id: string; senderId: string | null; content: UserContent[] }
  | { kind: 'plan'; id: string; items: PlanItem[] }
  | {
      kind: 'notice'
      id: string
      severity: 'info' | 'warning' | 'error'
      title: string
      description?: string
    }
  | {
      kind: 'compaction'
      id: string
      status: 'in_progress' | 'completed' | 'failed' | 'cancelled'
      summary: string
    }
  | { kind: 'turn_end'; id: string; stopReason: StopReason; durationMs: number }
  | GitEntry // OverBench's own observation of the repository, see the git design

type GitEntry =
  | {
      kind: 'git'
      id: string
      event: 'commit'
      commits: { oid: string; subject: string }[]
      more: number
    }
  | { kind: 'git'; id: string; event: 'push'; upstream: string; count: number }
  | { kind: 'git'; id: string; event: 'branch'; branch: string }
  | { kind: 'git'; id: string; event: 'pull_request'; url: string }

interface ToolEntry {
  kind: 'tool'
  id: string
  title: string
  toolKind:
    | 'read'
    | 'edit'
    | 'delete'
    | 'move'
    | 'search'
    | 'execute'
    | 'think'
    | 'fetch'
    | 'switch_mode'
    | 'other'
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' // cancelled is set by the host
  content: ToolContent[]
  locations: { path: string; line?: number }[]
  permission: PendingPermission | null
  permissionResult: { optionId: string; kind: PermissionKind } | 'cancelled' | 'withdrawn' | null
}

type ToolContent =
  | { type: 'markdown'; markdown: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'ref'; ref: ContentRef }

interface PendingPermission {
  requestId: string
  options: { id: string; name: string; kind: PermissionKind }[]
}

type PermissionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
type UserContent = { type: 'text'; text: string } | { type: 'ref'; ref: ContentRef }
type ContentRef =
  | { kind: 'image'; mimeType: string; data: string }
  | { kind: 'link'; uri: string; name: string }
  | { kind: 'unsupported'; label: string }
interface PlanItem {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}
```

- `diff.oldText` is `null` for a new file.
- A thought's `durationMs` is set when it closes: when the next entry arrives, or when the turn ends. It runs from the thought's first chunk, and replayed thoughts have none.
- `ContentRef` with `kind: 'unsupported'` keeps content the UI cannot show yet (audio, embedded resources) visible as a labelled chip instead of dropping it.
- Text from tools is normalized to LF line endings before it enters the model.

### Patches, snapshots and sequence numbers

```ts
type Patch =
  | { op: 'entry.add'; entry: ThreadEntry }
  | { op: 'entry.appendText'; id: string; text: string } // agent and thought markdown, compaction summary
  | { op: 'entry.update'; id: string; changes: EntryChanges }
  | { op: 'session.update'; changes: Partial<SessionView> }
  | { op: 'thread.reset' } // before a session/load replay

interface PatchBatch {
  sessionId: string
  seq: number
  patches: Patch[]
}
interface SessionSnapshot {
  session: SessionView
  entries: ThreadEntry[] // the latest page of the thread, or every entry from `from`
  seq: number
  older: number | null // the cursor for the page before `entries`; null when they start the thread
  plan: PlanEntry | null // the latest plan, when it lies before `entries`
}
interface OlderPage {
  entries: ThreadEntry[]
  older: number | null
}
```

- `seq` increases by one per batch, per session.
- A renderer applies a batch only if its `seq` is exactly one more than the last it applied. On a gap it requests a fresh snapshot and drops batches older than it.
- `applyPatches` returns new objects only for what changed, so a component that selects one entry re-renders only when that entry changes.
- Entries are kept in arrival order. Updates change entries in place; nothing is reordered.
- `entry.update` or `entry.appendText` for an unknown id is a bug: the host logs it to diagnostics, and a renderer that sees one requests a snapshot. A renderer that holds only the latest pages of a thread skips one instead, since the entry may be on a page it has not loaded, which it then reads as patched.

### Pages

A snapshot carries the latest page of the thread, not all of it, and older pages are read on demand, so a session with a long history opens as fast as a short one:

- Entries have positions, their arrival order from 0, which are kept with the [stored thread](./persistence.md#threads). A page reaches back at least 60 entries, then on to the start of their turn, and at most 500 entries in all. The host pages a live thread from memory by the same rules, so a page is the same whether the session is live or not.
- `older` is the position of the page's first entry while entries lie before it, and `null` once the page starts the thread. `sessions.page { sessionId, before }` returns the page that ends before that position, with its own `older`.
- `plan` is the thread's latest plan when it lies before the page, for the plan pinned above the composer.
- `sessions.snapshot` with `from` returns every entry from that position on, so a renderer that refetches after a gap keeps the older pages it had: it passes its `older`, or 0 once it holds the whole thread.
- A live session's patches go out before the answer to `sessions.page`, and a renderer applies the batches it has before it prepends the page, so the page and the patches agree.

### Entry ids

- Messages with an ACP `messageId`: `m:<messageId>`. Agents may reuse one message id for a thought and its answer, so when `m:<messageId>` already names an entry of another kind, the new one is `m:<messageId>#<kind>` (`#agent`, `#thought` or `#user`).
- Tool calls: `t:<toolCallId>`.
- Compactions: `c:<compactionId>`.
- Git events: `g:<n>`, from the same counter as `e:<n>`.
- Subagent announcements: `s:<child session id>`.
- Session messages: `sm:<messageId>`.
- Everything else: `e:<n>`, from a per-session counter in the host. That includes the user entry the host adds when it sends a prompt, and messages without a `messageId`.

## Mapping ACP v1 to patches

Every `session/update` variant in ACP v1, and what the mapper does with it. "Current" means the last entry of that kind in the current turn.

| `sessionUpdate`             | Patches                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message_chunk`        | During a `session/load` replay: append text to the current user entry, or add one. During a live turn it is ignored, because the host already added the user entry when the prompt was sent.                                            |
| `agent_message_chunk`       | Text appends to the agent entry with the same `messageId`, or to the current agent entry if the last entry is that one; otherwise a new agent entry. Images and links become `attachments`; other content becomes an `unsupported` ref. |
| `agent_thought_chunk`       | The same rules, for thought entries.                                                                                                                                                                                                    |
| `tool_call`                 | Adds a tool entry, or updates it if the id already exists, since agents may announce a call twice.                                                                                                                                      |
| `tool_call_update`          | Updates only the fields present. A present `content` or `locations` replaces the whole list, as ACP v1 specifies.                                                                                                                       |
| `plan`                      | Replaces the items of the current plan entry, or adds one.                                                                                                                                                                              |
| `available_commands_update` | `session.update` of `commands`.                                                                                                                                                                                                         |
| `config_option_update`      | `session.update` of `config`.                                                                                                                                                                                                           |
| `current_mode_update`       | Updates the value of the mode option in `config` (see [Config options](#config-options)).                                                                                                                                               |
| `session_info_update`       | `session.update` of `title` and `updatedAt`.                                                                                                                                                                                            |
| `usage_update`              | `session.update` of `usage`'s `used`, `size` and `cost`. A plan limit in the update's `_meta` goes to the agent's account instead ([plan limits](#plan-limits)).                                                                        |
| `notice`                    | Adds a notice entry. Severities other than `info`, `warning` and `error` are shown as `info`.                                                                                                                                           |
| `compaction_update`         | Adds or updates the compaction entry for `compactionId`.                                                                                                                                                                                |
| `compaction_summary_chunk`  | Appends text to that compaction entry's `summary`.                                                                                                                                                                                      |
| `subagent_update`           | Creates or updates a child session ([Sub-sessions](#sub-sessions)); the first update for a child also adds a `subagent` entry to the parent's thread.                                                                                   |
| `session_message`           | Adds or replaces the `session_message` entry for `messageId` in the session it arrives on.                                                                                                                                              |
| `session_message_chunk`     | Appends its content block to the `session_message` entry for `messageId`, or adds that entry.                                                                                                                                           |
| anything else               | Ignored and recorded in diagnostics, so a newer agent never breaks the thread.                                                                                                                                                          |

Content blocks map as follows: `text` to markdown, `image` to an image ref, `resource_link` to a link ref, and `audio` and `resource` to `unsupported` refs. In tool content, `content` blocks map the same way, `diff` maps to a diff, and `terminal` cannot occur while the terminal capability is off.

The mapper is the only code that knows ACP. ACP v2 will add a second mapper onto the same model.

## Prompt turns

1. `sessions.prompt` is accepted only when the session is `ready`; otherwise it fails with `busy`. M0 runs one turn at a time per session; a prompt sent during a turn waits in the [queue](#queue-and-steering).
2. The host adds the user entry, sets `status: 'running'` and `turnStartedAt`, and sends `session/prompt` with the content as ACP content blocks.
3. Updates stream in and become patches ([Keeping streaming smooth](../architecture.md#keeping-streaming-smooth)).
4. When `session/prompt` returns, the host adds a `turn_end` entry with the stop reason and duration, sets `streaming: false` on the turn's messages, and sets `status: 'ready'`. A `usage` field in the response, which is still unstable in ACP, is added to `usage.tokens` when present: the schema calls its fields totals across the session, but claude-agent-acp 0.94, codex-acp 2.2.2 and opencode 2.0.32 all send the turn's own counts (read in their source on 2026-10-22), so the host sums them. Claude Code's `usage` leaves out its subagents' requests, so where the response's `_meta.quota.model_usage` splits the turn by model (Claude Code and Codex), the totals sum that instead, with the reasoning still taken from `usage` ([usage statistics](./usage.md#overbenchs-own-record)). The same counts become the turn's rows in the usage record. A count no turn has reported stays `null`. A fork starts from its source's totals, as it starts from its thread; a fork from an earlier reply starts with none ([fork from a reply](#how-the-host-keeps-sessions)). The host also sends `host:attention` with `turn-ended` so main can notify when no window is focused.
5. If `session/prompt` fails, the error becomes an error notice and the status becomes `ready` or `auth_required` depending on the cause, or `closed` when the agent exited. After an agent error the session's `error` stays set, so its attention is `error`, until the next turn starts. An `auth_required` failure keeps the prompt, and `sessions.retry` sends it again without adding a second user entry.

## Queue and steering

ACP v1 has neither, and the v2 prompt work leaves both out, so the queue is OverBench's own and steering uses the `_session/steering` extension that the Claude Code and Codex adapters share. Observed on 2026-10-21 in claude-agent-acp 0.94.0 and codex-acp 2.2.2 (package sources).

- **Queue**: `SessionView.queue` holds the prompts waiting for the running turn, oldest first, and `queuePaused` whether it waits for the user. `sessions.queue` adds one, or sends it at once when the session is `ready` and nothing waits or only a paused queue does; the composer sends everything through it, so a prompt sent before the renderer heard that a turn started is queued instead of refused. When a turn ends with `end_turn`, the host sends the oldest prompt as the next turn. After any other stop reason or a failed turn, the queue pauses until `sessions.resumeQueue`. OverBench never sends a second `session/prompt` during a turn. The queue is saved in the session index and comes back paused after a close or a restart.
- **Steering**: an agent advertises `_session/steering` in the top-level `_meta.steering.supported` of its `initialize` response. `sessions.steer` sends a queued prompt as `_session/steering` with `{ sessionId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' } } }`. On `injected`, the host adds the user entry with `steered: true` and removes the prompt from the queue; on `promptRequired` the turn is ending, so the prompt stays first in the queue and goes with the next turn. Claude Code's adapter injects the message into the running turn, interrupting the current generation or moving a running tool to the background.
- **Codex** is left out: codex-acp 2.2.2 advertises steering but ignores `idleBehavior` and starts a turn of its own when none runs, which OverBench would not track (its PR #593 would fix it). `AgentStatus.capabilities.steering` is false for Codex until a version honours it. OpenCode advertises none and rejects a second prompt, so it gets the queue only.

## Permissions

- `session/request_permission` carries a tool call and a list of options. The host updates the tool entry, adding it first if the thread has not seen that tool call, and sets its `permission`. While any permission is pending, the session is `awaiting_permission`, and the host sends `host:attention` with `permission`.
- A session can have several pending requests at once, one per tool entry.
- `permissions.respond(sessionId, requestId, optionId)` must name an option of that request, or it fails with `invalid_params`. The host answers the agent with `{ outcome: { outcome: 'selected', optionId } }`, clears `permission` and records `permissionResult`. With nothing else pending, the session goes back to `running`.
- If the agent withdraws a request (the SDK aborts the handler's `signal`), the host clears it with `permissionResult: 'withdrawn'`.
- OverBench passes "always" options through unchanged; remembering them is the agent's job. It never answers a request on the user's behalf.

## Cancellation

1. `sessions.cancel` sends the `session/cancel` notification.
2. The host immediately answers every pending permission request of that session with `{ outcome: { outcome: 'cancelled' } }`, as the protocol requires, and records `permissionResult: 'cancelled'`.
3. The session stays `running` until `session/prompt` returns with `stopReason: 'cancelled'`.
4. If the agent has not returned 10 s later, the host ends the turn itself, adds a warning notice that the agent did not confirm cancellation, and sets `status: 'ready'`.
5. A permission request that arrives after the user cancelled the turn, or while the session is closing, is answered `cancelled` at once; it never becomes pending.
6. However a turn ends, a tool still `pending` or `in_progress` becomes `cancelled`, as ACP asks clients to do, so no tool keeps a spinner after its turn. ACP has no such status; the host sets it, and a later update from the agent still overrides it.

## Session lifecycle

| Action                     | ACP                                               | Result                                                                                               |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Create                     | `session/new` with `cwd` and `mcpServers: []`     | `acpSessionId`, config options and modes; then `ready`. The index entry is saved once this succeeds. |
| Open                       | None                                              | The stored thread's latest page, in `closed`; the agent is not started.                              |
| Open with no stored thread | `session/load`                                    | `thread.reset`, then the replayed history as patches, then `ready`; the thread is then stored.       |
| Open without `loadSession` | `session/resume`                                  | `ready` with an info notice that earlier history is not available.                                   |
| Attach on use              | `session/resume`                                  | A `closed` session that sends a prompt, changes a setting or forks attaches to its agent first.      |
| After a crash              | `session/resume` on the next use                  | The sessions go `closed` with their threads; the agent starts again when one is used.                |
| Close                      | `session/close` when supported                    | Live state dropped; the index entry stays, so it can be reopened.                                    |
| Delete                     | `session/delete` when supported                   | Removed from the agent and from the index, after the user confirms.                                  |
| Import                     | `session/list` with `cwd`, following `nextCursor` | Sessions started elsewhere, such as in the CLI, can be added to the index and opened.                |
| Fork                       | `session/fork`, when the agent advertises it      | A new session in the same project that starts from the whole history, or from a reply; see below.    |

### Recovering after a crash

When an agent process exits unexpectedly, the host does not start it again. Its live sessions, subagents included, go `closed` as a [released](#how-the-host-keeps-sessions) session does: their threads are stored, and a renderer showing one keeps it with a composer. A turn that was running ends with an error notice that the agent stopped, its unfinished tool calls become `cancelled`, and its pending permission requests are cleared as `withdrawn`. The next prompt, setting or fork attaches the session again, which starts the agent; one with no use is never resumed, so a crash of Claude Code's adapter brings back only the CLIs of sessions in use. When the agent exits five times in five minutes it is `failed`, and attaching fails until the user retries ([agent host](./agent-host.md#agent-process-lifecycle)).

### How the host keeps sessions

These details are settled by the implementation in `src/agent-host/sessions.ts`:

- **Live and closed**: a session is live while the host holds its thread in memory. A session that is not live reports `status: 'closed'`, and its snapshot is read from the [thread store](./persistence.md#threads): the index's title, the stored config, commands and usage, and the latest page of entries, settled, as no agent is attached to finish them (nothing streams, an unfinished tool call or compaction is `cancelled`, and a pending permission request is `withdrawn`). A session with no stored thread, such as one just imported, or one whose stored thread belongs to another ACP session, has none of that, and `sessions.open` makes it live with `session/load`, or `session/resume` with the notice above, and stores the thread it gets.
- **Attaching on use**: a closed session takes a prompt, a queued prompt, a setting or a fork. The host first brings it back into memory from the stored thread, still `closed` and without its agent, together with its subagents, so updates about one add to the thread it has. A prompt then shows at once: the user entry is added and the turn starts `running` while the session attaches with `session/resume`, or with `session/load` whose replay is set aside for an agent that cannot resume. A setting or a fork attaches it first and leaves it `ready`; ultracode goes out with the next attach and needs none. A cancel while it attaches ends the turn at once. When the attach fails, the turn ends and the session goes to `failed` (or `auth_required`), and **Retry** sends the prompt again. Claude Code cannot resume a session nothing was sent to (`-32002`, resource not found): when the agent never answered in the thread, the host starts a new ACP session in its place with `session/new` and keeps the thread.
- **Releasing**: an idle session lets its agent go, so a Claude Code CLI runs only for the sessions in use. The host stores its thread, sends `session/close` (closing its subagents with it), sets it `closed`, so a renderer still showing it keeps it with a composer that attaches it again, and drops it from memory. When:
  - 60 s after it left the front, once idle, where the front is the session a port shows with `sessions.show`;
  - 30 min idle in front;
  - 60 s idle, in front or not, when nothing was sent or set since it went live, as for a session opened only to read its history with `session/load`, or one brought back from the store and not used.

  Never while it needs its agent: a status other than `ready` or `closed` (a turn running, a permission waiting, a load, a failure or sign-in for the user to handle), a pending permission, a `/context` report, a subagent that runs, or background work. Claude Code reports when a command it ran with `run_in_background` or its Monitor tool ends only to clients it draws terminals for or that speak JetBrains AIR's async tasks, and OverBench is neither, so a session that started either keeps its agent until it is closed or its agent exits. The timer counts from the later of when it became idle and when it left the front; anything that needs the agent stops it. Sending to a session being released waits for it to go and attaches it again.

- **Checkpoints**: the host stores each live session's thread as it changes. It notes the entries and the parts of the view each patch changes, and writes them at most 5 s after a change, at once when a turn ends, after a replay, when the session closes and when the host shuts down. A write that fails is logged, and the next one writes the whole thread again. A replay that fails partway is not stored.
- **Create**: `sessions.create` sends the session's summary with `starting` at once, and resolves when `session/new` succeeds. When it fails with `auth_required`, it resolves anyway, with the session live in `auth_required` but not yet in the index; signing in, or `sessions.retry`, runs `session/new` again. Any other failure rejects the request and sends `session.removed`. Creating a session also adds its folder to the projects, unless the folder is a [scratch folder](#sessions-without-a-project). The renderer creates a session only to send its first message: [New session](./ui.md#new-session) calls it on the first send, for a sub-session too.
- **Removing sessions with no message, once**: before New sub-session opened New session, it created the session at once, and one left without a message stayed listed as "New session". At the first launch of a version that has `emptySessionsRemovedAt` in the [index](./persistence.md#what-is-stored-and-where), the host removes those from the index with their stored threads, in the background as it starts, without holding back `host:ready`, and logs how many it removed. A session goes only when all of these hold:
  - it was in the index when the host started, and its origin is `user`;
  - it has no title: none from the agent, none from a first message, and no `customTitle` of the user's ([titles](#titles));
  - it has nothing queued;
  - its [stored thread](./persistence.md#threads) belongs to its current ACP session, its latest page is the whole thread, and every entry is a `notice` of OverBench's own: no message of the user's and nothing from the agent. A session with no stored thread, as an imported one not yet opened, stays;
  - it is not live, shown, watched, being brought back or let go, and every sub-session it has goes too.

  The index then records the time in `emptySessionsRemovedAt`, written before the threads are removed, so the removal never runs again; when a thread could not be read, it is not recorded, and the next launch tries again with what is left. The agents' own histories are left alone, since the index does not record whether OverBench created a session or imported it: Claude Code and Codex keep nothing of a session nothing was sent to ([hidden sessions](#hidden-sessions)), and OpenCode keeps it in its own list.

- **Open**: `sessions.open` of a session with a stored thread reads its latest page and starts nothing. Otherwise it waits for the load or resume, so its snapshot already holds the replay. A renderer watches first, so it also receives the replay's patches. When the agent cannot start, or the load fails, the session stays live in `failed` (or `auth_required`) and the snapshot shows it, for **Retry**.
- **Retry**: `sessions.retry` re-runs what failed: `session/new` for a create, the prompt for a prompt that needed sign-in or whose session could not attach, and `session/load` for a failed load or resume. It first clears the agent's `failed` state if needed, as `agents.retry` does. When an agent reports a successful sign-in, every session of it waiting in `auth_required` is retried on its own.
- **Unread**: a session counts as seen only while a port shows it in front (`sessions.show`). A renderer also keeps a few recent sessions watched, so switching back is instant, and those do not count. Showing a session, leaving it, and a turn ending while it is in front set `lastViewedAt`; a turn ending while no port shows it sets `unread`. After a restart a session is unread when `updatedAt` is later than `lastViewedAt`; a session never viewed (`lastViewedAt: null`) is not.
- **Attention** is `permission` while a request is pending, then `error` for a `failed` session or a set `error` the user has not seen, then `unread`. An error is seen once the session is shown, or when it happens while a port shows it; the error notice stays in the thread, and the session keeps `error` set until its next turn. A `failed` session keeps its mark until it recovers, since its **Retry** still waits for the user.
- **Fork**: `sessions.fork` takes a top-level session that is `ready`, or `closed`, which attaches first since not every agent forks a session it does not have open, and calls `session/fork` (ACP's unstable schema, only when `sessionCapabilities.fork` is advertised). The new session has the source's title and usage and shows a copy of the source's thread without its subagent cards, whose sub-sessions stay with the source; its next ids continue after the copied ones. It is `starting` while the host gives it the source's config ([forks keep the source's config](#config-options)), and is saved only after that, then `ready`. So a fork deleted meanwhile, or whose project is removed, is not saved, and the request fails with `not_found`. A later open replays the fork's own history from the agent.
- **Fork from a reply**: with `entryId`, the agent message that ends a reply, the fork holds the conversation up to the end of that reply's turn: its thread is the source's up to the next user message that is not steered. The agents cut their own history differently: codex-acp keeps the whole turn, while Claude Code's adapter cuts at the message itself, so tool calls after that message stay in the fork's thread but not in Claude Code's history. ACP's `session/fork` takes no such place, so the host passes a fork point in `_meta.jetbrains.air.fork`: `version: 1`, the message's ACP `messageId` (its entry id without `m:`), and, for an agent that cannot find the id, the SHA-256 fingerprint of its text (`sha256:<hex>`) with its 1-based occurrence among the agent messages up to it with that text ([protocol version](../architecture.md#protocol-version)). Only an agent with `forkAtMessage` takes one: the adapters seen to honour it are listed by their `agentInfo` name and the first version that does, so any other agent, or an older adapter, would fork the whole session while the thread showed a part. A reply in the latest turn needs no fork point and forks the whole session, so every agent with `session/fork` can fork from it. Since nothing records the context or the totals at an earlier reply, such a fork starts with no usage until its first turn reports it. An entry that is not an agent message, one that another agent message follows in its reply, or one in an earlier turn without a `messageId`, is refused.
- **Sequence numbers** continue across a close and a reopen, so a port still holding an old replica sees a gap and asks for a snapshot instead of mixing two runs.

### Sessions without a project

Some work needs an agent but none of your folders, so New session offers **No project**, as the reference offers **No folder**. An ACP session always has a working directory (`cwd` in `session/new`), so each such session gets a scratch folder of its own, as the reference does (observed 2026-10-21: an empty `scratch-<date>-<6 hex>` folder per session under its data folder):

- `sessions.create` with `projectPath: null` makes an empty folder, `<userData>/scratch/scratch-<YYYY-MM-DD>-<6 hex>` (mode `0700`), and starts the session there. The folder is not added to the projects.
- A session is a scratch session when its folder is inside `<userData>/scratch`, and its summary says so with `scratch: true`. The index stores the path only, as for any session.
- Its sub-sessions and forks share its folder, as sub-sessions share their parent's project.
- The folder serves git, the Files pane and the terminal as a project's folder does: git finds no repository, the Files pane shows what the agent wrote there, and the terminal opens in it, since the host adds the scratch folders of its sessions to the folders it relays to the terminal host (`host:projects`).
- Deleting the session leaves its folder, which may hold the agent's work; nothing removes scratch folders.

### Titles

The title comes from `session_info_update`. Until the agent sends one, the host uses the first line of the first user message, cut to 60 characters. It is persisted in the index.

The user can rename a session (`sessions.rename`). ACP has no rename, so the user's title lives in the index only, as `customTitle`, and wins over the agent's: the summary and notifications show it, while the thread's own `title` keeps following the agent. Renaming to an empty title removes it, and the agent's title shows again.

## Sub-sessions

A session can have sub-sessions, listed under it in the sidebar. They come from two places:

| Origin     | Created by                                                                                                                     | What you can do                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `subagent` | The agent, for a subagent it runs, announced through ACP's subagents RFD                                                       | Watch it, answer its permission requests, and stop it if allowed |
| `user`     | You, with **New sub-session** on a session, created with its first message; an ordinary session in the same project, any agent | Everything you can do in a session; only OverBench links the two |

### Subagents

The subagents RFD ([agent-client-protocol#1992](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992)) is unstable, so it is the one exception to M0's stable-only rule ([architecture](../architecture.md#protocol-version)). Its types come from the SDK's `unstable` v1 schema and stay inside the mapper; if the RFD changes, only the mapper changes. OverBench declares `clientCapabilities.subagents: {}` in `initialize`. `claude-agent-acp` 0.94 and `codex-acp` 2.2.2 implement it; OpenCode does not, so its subagents stay tool calls in the parent.

- The first `subagent_update` for an unknown child `sessionId`, sent on the parent session, creates a `SessionView` with the parent's agent and project, `parentId`, `origin: 'subagent'`, the child id as `acpSessionId`, `title` from `title`, and `subagent` from `description` and `capabilities.cancel`. It also adds a `subagent` entry to the parent's thread at that point. Later updates change only the fields present, and `null` clears one, as the RFD specifies.
- `state` maps to the child's status: `running` to `running`, `requires_action` to `awaiting_permission`, and `idle` to `ready`, keeping `stopReason`. `unknown` keeps the last status and sets `stateKnown: false`, so the UI shows it as last known rather than current.
- Updates that name the child's `sessionId` go through the same mapper into the child's own thread. Its permission requests work as in any session.
- `session_message` adds a `session_message` entry: the parent's instructions to the child, which open the child's thread, and any later messages between them.
- A subagent session is restricted: `sessions.prompt`, `sessions.setConfigOption`, `sessions.close` and `sessions.delete` fail with `restricted`, and `sessions.cancel` sends `session/cancel` for the child only when `canCancel` is true (otherwise `restricted` too). `sessions.retry` on a child does nothing; it recovers with its parent. Opening a child that is not live opens its parent, whose load replays the child.
- While a child has a pending permission request it is `awaiting_permission`, whatever its last state said. Its work runs from the first `running` state to the next `idle`; that `idle` adds a `turn_end` entry to the child's thread with the stop reason and that duration, and its `usage`, the counts of that work, is added to the child's token totals. An `idle` replayed by `session/load` adds nothing, since the stored totals already hold it.
- When the agent reports the child's work ended with an error, the child becomes `failed` with that error.
- Children are saved in the index with the parent, so the sidebar shows them after a restart. Their threads come back with the parent's `session/load`, which replays the children too; a child a successful replay does not mention is marked missing. After a failed load the children simply stay closed.

### Rules for both

- Sub-sessions belong to the parent's project. Closing or deleting the parent closes or deletes its sub-sessions, after one confirmation that names how many there are.
- A parent's attention includes its descendants: its sidebar row shows the number of pending permission requests in it and in every sub-session below it.
- Sub-sessions nest as deep as the agent creates them. The sidebar indents two levels at most and lists deeper ones at the second level.

## Plan limits

Subscription plans cap usage in rolling windows, such as five hours and a week. These limits belong to the agent's account, not to a session, so they live on `AgentStatus` ([host protocol](./host-protocol.md#requests)), next to the account the agent reports. Neither is part of ACP yet; both come from extensions the adapters define, and only the mapper reads them.

| Source                                                          | Claude Code (`claude-agent-acp` 0.94)                                                                            | Codex (`codex-acp` 2.2.2)                                                      | OpenCode |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| The `_auth/status_update` notification: kind, plan label, email | Yes                                                                                                              | Yes                                                                            | No       |
| Plan limits                                                     | `usage_update._meta["_claude/rateLimit"]`, one window per update, whenever Claude Code's rate limit info changes | Not sent; the adapter keeps them for its `/status` command only                | No       |
| Current use of every limit                                      | The `/usage` report, on request ([below](#reading-the-limits-from-usage))                                        | The `/status` report, on request ([below](#reading-codexs-limits-from-status)) | No       |

```ts
interface AgentAccount {
  kind: 'account' | 'api_key' | 'external' | 'gateway' | 'none'
  label: string // "Claude Max", "ChatGPT Plus", "Anthropic API key"
  email: string | null
}

interface PlanLimit {
  window: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | string
  label: string // "5-hour", "Weekly", "Weekly · Opus"
  usedPercent: number | null
  resetsAt: number | null
  state: 'ok' | 'warning' | 'reached' // from `status`: allowed, allowed_warning, rejected
  observedAt: number
}
```

- Each `_claude/rateLimit` value updates the window named by its `rateLimitType` and leaves the others as they are; windows never reported are not shown. A value without `utilization`, which Claude Code often sends, keeps the use already known for the same period, one whose reset is within a minute of it, since `/usage` prints resets to the minute.
- **Units** (checked on 2026-10-20 against the sources, not yet against a live session): `claude-agent-acp` 0.94.0 passes Claude Code's `rate_limit_info` through unchanged, and Claude Code 2.1.304 treats `utilization` as a fraction from 0 to 1 (it shows `Math.round(u * 1000) / 10` percent, capped at 100, and compares it with thresholds of 0.25, 0.5, 0.75 and 0.9) and `resetsAt` as Unix seconds. The host stores `usedPercent = round(utilization × 1000) / 10`, clamped to 0–100, and `resetsAt` in milliseconds; a `resetsAt` that is already in milliseconds (10¹² or more) is kept as is. A live session should confirm this before M0.2 is signed off.
- `rateLimitType` values seen in Claude Code: `five_hour` ("5-hour"), `seven_day` ("Weekly"), `seven_day_opus` ("Weekly · Opus"), `seven_day_sonnet` ("Weekly · Sonnet") and `overage` ("Extra usage"); others, such as `seven_day_overage_included`, get a label made from the name. `status` is `allowed`, `allowed_warning` or `rejected`.
- Limits are kept in memory for the life of the host. After a restart they appear again with the first update.
- An account with `kind: 'none'` sets the agent's `signIn` to `required`; any other kind sets `signed-in`.
- Cost is shown only when the account is not a subscription, because for a plan it is not what the user pays.
- For Codex, the adapter already receives `account/rateLimits/updated` from Codex; forwarding it in `usage_update._meta` the way the Claude adapter does is a small upstream change. Until it lands, Codex's limits come only from `/status`.

### Reading the limits from `/usage`

Rate-limit events arrive only when a window changes, so a window can stay unknown for days, and one may come without `utilization`. Claude Code's `/usage` command reads the current use of every window; it runs in Claude Code itself, with no model call. The adapter formats it as the markdown of an agent message (`formatUsageResponse` in claude-agent-acp 0.94's `usage-markdown.js`), and nothing else exposes it, so the host reads that markdown ([reports](#reports-from-the-agents-own-commands)).

- `agents.refreshLimits` runs it for Claude Code (and the fake agent, which imitates the format), and Codex's [`/status`](#reading-codexs-limits-from-status) for Codex, at most once a minute; OpenCode has no report and the request does nothing. The usage popover and the usage page ask for it when they open, only while the agent runs. Settings › Agents asks through `agents.refreshAccount` whenever its list or an agent's page shows, which starts a stopped agent that can run without an install; an agent's page also offers **Check plan limits**, which starts it and installs its adapter first when needed.
- It runs in a session the host creates for it in `<userData>/agent-reports`, an empty folder, so no project's settings, hooks or memory files load.
- Each `**<label>** — **<n>%** · Resets <time>` line under `### Limits` becomes a window: "5-hour limit" is `five_hour`, "Weekly · all models" `seven_day`, and "Weekly · <model>" `seven_day_<model>`, so Opus and Sonnet merge with the windows the events name. `usedPercent` is `n` as printed (already a percentage), and a window at 100% is `reached`.
- The reset is printed in English without a year, in the zone of the machine (`Oct 24, 6:00 AM PDT`). A `GMT+8` or `UTC` zone is applied as written; a named zone such as `PDT` is the local one it came from. The year is this one, or the next for a reset that would otherwise lie in the past.
- A window read this way replaces the one in memory, except that a `warning` or `reached` state an event set holds until that window's reset passes, since the report has no state of its own.
- Text that is not the structured report, such as Claude Code's own output when the adapter falls back to it, changes nothing and is logged. The adapter falls back when the structured report fails or takes more than 5 s (`STRUCTURED_USAGE_TIMEOUT_MS`). That report took 2.6 s in a running session and 4.9 s in a new one, measured on 2026-10-22 with claude-agent-acp 0.94.0 and seven days of heavy local use, so on a busy machine a `/usage` the user types can show Claude Code's plain text instead; the thread keeps its lines ([Interface: markdown](./ui.md#markdown)).

### Reading Codex's limits from `/status`

codex-acp 2.2.2 sends Codex's limits nowhere but its own `/status` command, which asks Codex's app server for them (`account/rateLimits/read`) and needs no model call. It writes them into the markdown of one agent message (`buildStatusMessage`), lines joined by two spaces and a line break, and the host reads that, in a hidden session as for `/usage`.

- The report is the message with an `**Account:**` line. Each `**<pool> <window>:** <n>% left (resets <time>)` line becomes a window with `usedPercent = 100 − n`, `reached` at 100%. Credits, spend limits and "data not available yet" are not windows; a report with no window gives none, and keeps what the host had.
- The window is the adapter's label: `5h limit` is `five_hour`, `Weekly limit` `seven_day`, and other lengths their own (`2d limit` is `2_day`, "2-day"). The pool is Codex's limit name, `codex` for the plan's own; another pool, such as a model's, gets windows of its own (`gpt_5_3_codex_spark_five_hour`, "5-hour · GPT-5.3-Codex-Spark").
- The adapter labels every window of a week or longer `Weekly limit`; a ChatGPT Free account's only window lasts 30 days (`windowDurationMins` 43200, checked on 2026-10-21 against a live account). So the reset tells them apart, in the tiers of Codex's own status line: a reset more than a week and an hour away is `monthly` ("Monthly"), more than 31 days away `annual` ("Annual").
- The reset is printed in the adapter's locale and the machine's zone: the 24-hour time alone for today (`14:30`), else with the day and short month (`09:12 on Nov 18`, `18 Nov`, `18. Nov.`, `11月18日`). The host reads the time and the day of the month in any locale, and the month where it is a number or an English abbreviation; then the reset is that date this year or next. Without a readable month it is the next such day within 31 days, which no Codex window outlasts. A reset in digits other than ASCII, such as Arabic-Indic, is left unknown.

## Context breakdown

`usage_update` gives only the context's `used` and `size`. Claude Code works out what fills it for its own `/context` command, which also runs without a model call: by category (system prompt, system tools, MCP tools, MCP server instructions, deferred tools, memory files, skills, messages, free space, the autocompact buffer), then lists of the MCP tools, memory files and skills with their tokens. The adapter passes it through as an agent message, so the host reads that markdown too ([reports](#reports-from-the-agents-own-commands)).

```ts
interface ContextBreakdown {
  model: string | null
  used: number
  size: number
  categories: { name: string; tokens: number; share: number | null }[] // in the report's order
  lists: { name: string; items: { name: string; detail: string | null; tokens: string }[] }[]
  observedAt: number
}
```

- `sessions.context` runs it for a `ready` Claude Code session, in a `session/fork` of it, so the session's own thread and history stay as they were. Other agents give `null`, and a running turn fails with `busy`.
- The fork starts like a resumed session, with the model the transcript records, so the totals match the session's.
- Claude Code sends the report twice, under two message ids; the host takes the last message that parses. Token counts such as `32.1k` become numbers; list items keep the text the report shows (`~310`, `< 20`).
- The renderer asks when the usage popover opens and keeps the result for that session until its `used / size` changes.

## Reports from the agents' own commands

`/usage`, `/context` and Codex's `/status` run in a [hidden session](#hidden-sessions). The connection prompts it and collects its agent messages; its other updates are dropped, and updates that arrive after are ignored like those of a closed session. A report that has not finished after 60 seconds is cancelled and fails.

## Hidden sessions

A hidden session is one the host opens for its own use and no thread shows: the [reports](#reports-from-the-agents-own-commands), and the read of an agent's [options](#config-options) before its first session. Each runs in `<userData>/agent-reports`, an empty folder, except `/context`, which forks the session it reports on. Afterwards the host removes it so that nothing of it stays in the agent's own history: not in its session list, not in its resume list, and no transcript on disk. Updates that arrive after are dropped. How it is removed depends on the agent (`removalOf` in `src/agent-host/reports.ts`), as checked on 2026-10-22 on macOS with claude-agent-acp 0.94.0 (Claude Code 2.1.303), codex-acp 2.2.2 (Codex 0.160.1) and opencode 2.0.32:

| Agent       | Removal                                   | What the agent keeps                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `session/delete`, again 1 s and 5 s later | Nothing of the session. Claude Code writes no transcript for a session nothing was sent to. After a report the delete removes the transcript; claude-agent-acp deletes without waiting for Claude Code to exit, and Claude Code writes the title and costs back as it exits, which the repeats remove. The folder's own `~/.claude/projects/<folder>/`, holding an empty `memory/`, stays once for the folder. |
| Codex       | `session/close`                           | Nothing. codex-acp answers `session/delete` with Codex's `thread/archive`, which writes the thread to `~/.codex/archived_sessions` and Codex's thread database; a thread that never reached the model, such as one that only ran `/status`, is never written, so closing it leaves nothing.                                                                                                                    |
| OpenCode    | `session/delete`                          | Nothing of the session: OpenCode stores and lists a session as soon as `session/new` answers, and the delete removes it with its records. The folder's project entry stays once for the folder.                                                                                                                                                                                                                |

An agent missing from this table, or one that does not advertise the request its row names, opens no hidden session: its options are not read early and its reports do not run. There is no fallback to the other request, since that can leave a trace: Codex's delete archives the thread, and OpenCode's close keeps the session in its list. Stopping an agent waits for a hidden session that reads its options to be removed first.

## Config options

- `configOptions` from `session/new`, `session/load` or `session/resume`, and later `config_option_update`, fill `config`.
- If the agent sends only legacy `modes`, the host adds a synthetic option `{ id: '__mode', category: 'mode', type: 'select' }` built from `availableModes`, and sets it with `session/set_mode`.
- `sessions.setConfigOption` calls `session/set_config_option` (or `session/set_mode` for `__mode`). The response's `configOptions` replaces `config`.
- Unknown categories are treated as `other`. Placement in the UI follows `category`; nothing depends on it for correctness.
- **Before a session exists** (decided while the maintainer was away, 2026-10-22; to be reviewed): ACP has no request that lists an agent's options; they come only with `session/new`, `session/load`, `session/resume` and `session/fork`. So [New session](./ui.md#new-session) shows each agent's options as its last new session reported them, read once early for an agent that has none. The host keeps, per agent, in `state/agent-options.json`:
  - `config`: the options of the agent's last `session/new`, with the values the agent chose, as its defaults. Until one is seen, the model, model options and level of the first session the agent loads or resumes stand in for them, with `provisional` set, since they are that session's values, not the agent's defaults; its mode and other options are left out, since they never carry over. New session sends every value of a provisional entry when it starts a session, and still reads the defaults early;
  - `levels`: the `thought_level` option as each model offered it, since an agent's levels can differ by model; a loaded or resumed session adds its model's;
  - `remembered`: the values last set by the user, through `sessions.setConfigOption` in any session or by starting a session with them, for the options in the `model`, `thought_level` and `model_config` categories only. A mode, such as a permissive one, and the other options start at the agent's default in every session.
  - `agents.options` returns every agent's entry, and `agent.options` sends one when it changes.
- **Reading them early** (decided 2026-10-22): `agents.start`, which New session sends for its chosen agent, reads the options of an agent whose defaults are not known from `session/new` in a [hidden session](#hidden-sessions), removed at once without a prompt, and resolves once they are read. The session of a plan limits report gives its options the same way while none are known, and never replaces them after. So the models show before the first message, at the cost of one start of the agent, once, since the entry then stays. A read that fails, finds no options or gets no answer within 30 s is logged, leaves New session without the models, and is not tried again until the agent restarts; a `session/new` that answers after the 30 s is still removed. Options read in the empty folder can differ from a project's, such as a model a project's own settings choose; the project's first session replaces them. Only an agent whose hidden sessions can be removed without a trace is read ([hidden sessions](#hidden-sessions)).
- **Starting with chosen values**: `sessions.create` takes `options`, the values New session shows for the options it knows. After `session/new` the host sets each value that differs from the new session's own, the model first, then `model_config`, `thought_level`, the mode and the rest, so a level is checked against the levels of the model just set. A value the session no longer offers, such as a retired model, is skipped and logged, and the session keeps the agent's value. Ultracode goes out with the `session/new` itself, as the session's `ultracode` setting. A failed set does not fail the start: the session starts with the agent's value and the failure is logged.
- **Forks keep the source's config**: an adapter may start a fork at its defaults instead of the source's values. Checked on 2026-10-22: codex-acp 2.2.2 starts it on Codex's default model, in the default mode and collaboration mode, and lists no reasoning level until a model is set, whatever the source had; Claude Code's adapter 0.94.0 takes the model and permission mode its transcript records, so a model chosen since the last reply and a level set in the session are lost (read in its source); OpenCode 2.0.32 carries all three over. So after `session/fork` answers, the host sets the source's current value of each of its options, the way it sets [start values](#config-options): in the same order, each against the options as they stand after the one before, through `session/set_config_option` or `session/set_mode`. A value the fork already has is not sent, which leaves nothing to do for an agent that carries everything over; the exception is the model, which is sent again when the source has an option the fork does not list yet, since an agent can list one only once a model is set, and a source on Codex's default model with a raised level would otherwise lose it. The mode and the other options are set as well as the model and level, since the fork is the same conversation, and a fork from an earlier reply takes the source's config as it is now. The values are not the user's choice, so they do not change what New session starts from. A value the fork does not offer or its agent refuses is logged, and the fork keeps and shows the value its agent reports. The fork is `starting` until the last of them is answered, then `ready` either way; when the agent exits meanwhile, it is stored `closed` with the values it had by then. Ultracode is not an agent option: the fork gets the source's through `_meta` on `session/fork`.
- **Ultracode**: Claude Code's adapter offers no option for it (observed in 0.94.0 on 2026-10-21), so for Claude Code sessions the host adds a boolean `{ id: '__ultracode', category: 'other', idleOnly: true }` at the end of `config`, kept across `config_option_update`. Ultracode lives in Claude Code's settings, read when its query starts, so the host passes it as `_meta.claudeCode.options.settings.ultracode`, which the adapter hands to the Claude Code SDK as its highest settings layer, on `session/new`, `session/load`, `session/resume` and `session/fork`. Setting the option, which `idleOnly` allows only while no turn runs, calls `session/resume` with the new value; the adapter sees the changed settings, tears its query down and starts Claude Code again with them, and the session shows `starting` meanwhile. The value is kept in the session index. Until it is set from OverBench the host sends no setting, so Claude Code's own settings decide, and the switch shows off.
