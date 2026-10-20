# Session model

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.2](../milestones/m0.md#work-packages)

This document defines OverBench's own model of a session and its thread, how ACP v1 maps onto it, and the rules for prompts, permissions, cancellation and recovery. The model lives in `src/shared/thread.ts` and is used by both the agent host and the renderer. It never imports ACP types; only the mapper in `src/agent-host/acp/` does.

## Ownership

- The **agent host** holds the authoritative state of every live session. The mapper turns ACP messages into patches, and the host applies them to its copy.
- The **renderer** holds a replica of the sessions it shows. It starts from a snapshot and applies patch batches in sequence order.
- Both sides apply patches with the same pure function, `applyPatches`, so they cannot drift apart.

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
  | 'disconnected' // the agent process exited; recoverable
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
  usage: { used: number; size: number; cost: { amount: number; currency: string } | null } | null
  error: { message: string; detail?: string } | null
  turnStartedAt: number | null
  createdAt: number
  updatedAt: number
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
  | { kind: 'user'; id: string; content: UserContent[] }
  | { kind: 'agent'; id: string; markdown: string; attachments: ContentRef[]; streaming: boolean }
  | { kind: 'thought'; id: string; markdown: string; streaming: boolean }
  | ToolEntry
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
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
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
  entries: ThreadEntry[]
  seq: number
}
```

- `seq` increases by one per batch, per session.
- A renderer applies a batch only if its `seq` is exactly one more than the last it applied. On a gap it requests a fresh snapshot and drops batches older than it.
- `applyPatches` returns new objects only for what changed, so a component that selects one entry re-renders only when that entry changes.
- Entries are kept in arrival order. Updates change entries in place; nothing is reordered.
- `entry.update` or `entry.appendText` for an unknown id is a bug: the host logs it to diagnostics, and a renderer that sees one requests a snapshot.

### Entry ids

- Messages with an ACP `messageId`: `m:<messageId>`.
- Tool calls: `t:<toolCallId>`.
- Compactions: `c:<compactionId>`.
- Everything else: `e:<n>`, from a per-session counter in the host.

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
| `usage_update`              | `session.update` of `usage`.                                                                                                                                                                                                            |
| `notice`                    | Adds a notice entry. Severities other than `info`, `warning` and `error` are shown as `info`.                                                                                                                                           |
| `compaction_update`         | Adds or updates the compaction entry for `compactionId`.                                                                                                                                                                                |
| `compaction_summary_chunk`  | Appends text to that compaction entry's `summary`.                                                                                                                                                                                      |
| anything else               | Ignored and recorded in diagnostics, so a newer agent never breaks the thread.                                                                                                                                                          |

Content blocks map as follows: `text` to markdown, `image` to an image ref, `resource_link` to a link ref, and `audio` and `resource` to `unsupported` refs. In tool content, `content` blocks map the same way, `diff` maps to a diff, and `terminal` cannot occur while the terminal capability is off.

The mapper is the only code that knows ACP. ACP v2 will add a second mapper onto the same model.

## Prompt turns

1. `sessions.prompt` is accepted only when the session is `ready`; otherwise it fails with `busy`. M0 runs one turn at a time per session.
2. The host adds the user entry, sets `status: 'running'` and `turnStartedAt`, and sends `session/prompt` with the content as ACP content blocks.
3. Updates stream in and become patches ([Keeping streaming smooth](../architecture.md#keeping-streaming-smooth)).
4. When `session/prompt` returns, the host adds a `turn_end` entry with the stop reason and duration, sets `streaming: false` on the turn's messages, and sets `status: 'ready'`. It also sends `host:attention` with `turn-ended` so main can notify when no window is focused.
5. If `session/prompt` fails, the error becomes an error notice and the status becomes `ready`, `auth_required` or `disconnected` depending on the cause.

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

## Session lifecycle

| Action                     | ACP                                               | Result                                                                                               |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Create                     | `session/new` with `cwd` and `mcpServers: []`     | `acpSessionId`, config options and modes; then `ready`. The index entry is saved once this succeeds. |
| Open from history          | `session/load`                                    | `thread.reset`, then the replayed history as patches, then `ready`.                                  |
| Open without `loadSession` | `session/resume`                                  | `ready` with an info notice that earlier history is not available.                                   |
| Recover after a crash      | `session/resume` once the agent restarts          | `ready`, with the thread kept from memory.                                                           |
| Close                      | `session/close` when supported                    | Live state dropped; the index entry stays, so it can be reopened.                                    |
| Delete                     | `session/delete` when supported                   | Removed from the agent and from the index, after the user confirms.                                  |
| Import                     | `session/list` with `cwd`, following `nextCursor` | Sessions started elsewhere, such as in the CLI, can be added to the index and opened.                |

### Recovering after a crash

When an agent process exits, its live sessions become `disconnected` and keep their threads. When the agent restarts, the host calls `session/resume` for each; on success they return to `ready`. A turn that was running when the agent died ends with an error notice. If resuming fails, the session becomes `failed` with **Reopen**, which runs `session/load`.

### Titles

The title comes from `session_info_update`. Until the agent sends one, the host uses the first line of the first user message, cut to 60 characters. It is persisted in the index.

## Config options

- `configOptions` from `session/new`, `session/load` or `session/resume`, and later `config_option_update`, fill `config`.
- If the agent sends only legacy `modes`, the host adds a synthetic option `{ id: '__mode', category: 'mode', type: 'select' }` built from `availableModes`, and sets it with `session/set_mode`.
- `sessions.setConfigOption` calls `session/set_config_option` (or `session/set_mode` for `__mode`). The response's `configOptions` replaces `config`.
- Unknown categories are treated as `other`. Placement in the UI follows `category`; nothing depends on it for correctness.
