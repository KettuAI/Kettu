# Renderer and agent host protocol

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.1](../milestones/m0.md#work-packages) and M0.2

The renderer talks to the agent host over a `MessagePort` that main hands out ([agent host](./agent-host.md#startup-and-supervision)). The contract is typed in `src/shared/agent-host.ts`, the same way `IpcInvokeContract` types renderer-to-main calls.

## Preload API

The preload keeps the port in the isolated world and exposes only functions through `contextBridge`, so page scripts never hold a raw channel:

```ts
interface AgentsApi {
  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>>
  onEvent(listener: (event: HostEvent) => void): () => void
  onConnection(listener: (state: 'connected' | 'reconnecting' | 'failed') => void): () => void
  restart(): Promise<void>
}
```

Exposed as `window.overbench.agents`. `src/preload/port-client.ts` implements it, and the same client serves `window.overbench.terminals`.

- `request` accepts only method names from the contract; the preload checks the name against `HOST_METHODS` before posting. Requests made before the first port arrives wait for it, in order.
- `onEvent` and `onConnection` return an unsubscribe function. `onConnection` calls a new listener at once with the current state, if there is one yet, so a late subscriber does not miss `connected`.
- While the port is being replaced after `agent-host:reset`, requests in flight reject with `host_restarted`. After `connected`, the renderer's stores refetch snapshots for the sessions they watch.
- After `failed` ([crash recovery](./agent-host.md#crash-recovery)), requests reject at once with `host_restarted` until `restart()` brings the host back; the state then goes through `reconnecting` to `connected`.
- A failed request rejects with a plain object, `{ name: 'PortRequestError', code, message, data? }`, not an `Error`: `contextBridge` copies an `Error` with its message only and drops `code`. `isPortError` from `src/shared/port-rpc.ts` recognizes the object, and `new PortRequestError(error)` turns it into an `Error` that keeps the code where the renderer wants one. Params that cannot be cloned reject with `invalid_params` without reaching the host.

[Attachments](./session-model.md#only-what-the-user-chose) add `window.overbench.attachments`, two methods that go through main rather than the host's port: `pick(kind, defaultPath)`, which shows the system's file or folder dialog, opening in the session's folder (`dialog:add-attachments`), and `fromFiles(files)`, which turns dropped or pasted `File`s into paths with `webUtils.getPathForFile` inside the preload (`attachments:grant`), at most 20 at a time; the preload refuses anything but a list of `File`s, so a page script cannot hand it a path of its own. Main checks each path with `stat` and grants the files and folders to the host (`host:grant`), waiting until the host holds them, so the renderer never names a grant the host lacks. Both return grant ids with names, kinds and sizes, never a path the renderer could pass back; `fromFiles` answers in the files' order, with null for one that has no file on disk behind it or is neither a file nor a folder. A grant serves one `attachments.add` and goes after 10 minutes unused.

## Envelope

```ts
type ToHost = { type: 'request'; id: number; method: HostMethod; params: unknown }

type FromHost =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'error'; id: number; error: HostError }
  | { type: 'event'; event: HostEvent }

interface HostError {
  code:
    | 'invalid_params'
    | 'unknown_method'
    | 'not_found'
    | 'busy'
    | 'restricted' // not allowed on a subagent session
    | 'agent_unavailable'
    | 'auth_required'
    | 'agent_error'
    | 'git_error'
    | 'conflict' // the file changed since the version given
    | 'host_restarted'
    | 'internal'
  message: string
  data?: unknown
}
```

- Values cross the port by structured clone, and then once more through `contextBridge`. Payloads stay plain data: no class instances, functions or `Map`s.
- Request ids are per port. The host answers every request exactly once.
- A message that is not a request, or a request without a numeric `id`, cannot be answered: the host drops it and logs a warning.

## Requests

| Method                     | Params                                   | Result                                          | Notes                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents.list`              | none                                     | `AgentStatus[]`                                 | Waits for the first detection, which waits for the environment                                                                                                                                                                 |
| `agents.check`             | `{ agentId? }`                           | `AgentStatus[]`                                 | Runs detection again                                                                                                                                                                                                           |
| `agents.reloadEnvironment` | none                                     | `AgentStatus[]`                                 | Resolves the shell environment again, then runs detection                                                                                                                                                                      |
| `agents.environment`       | none                                     | `EnvironmentInfo`                               | Where the agent environment came from, for Settings › Agents                                                                                                                                                                   |
| `agents.authenticate`      | `{ agentId, methodId }`                  | none                                            | `agent`-type methods only                                                                                                                                                                                                      |
| `agents.logout`            | `{ agentId }`                            | none                                            | Only when the agent advertises logout                                                                                                                                                                                          |
| `agents.retry`             | `{ agentId }`                            | none                                            | Clears `failed`; starts the agent if live sessions need it                                                                                                                                                                     |
| `agents.reinstall`         | `{ agentId }`                            | none                                            | Stops the agent, deletes the install a start runs and installs that version again; `busy` while a session uses the agent or an install or update runs ([installing adapters](./agent-host.md#installing-adapters))             |
| `agents.checkUpdates`      | none                                     | `AgentStatus[]`                                 | Asks npm for each package agent's latest adapter and the CLI it carries; rejects only when every check failed, with the reason, or no agent has npm ([checking for updates](./agent-host.md#checking-for-updates))             |
| `agents.update`            | `{ agentId }`                            | none                                            | Installs `update` beside the current install, as `task`; resolves when done or cancelled, rejects with the failure; `invalid_params` without an update, `busy` while an install or update runs                                 |
| `agents.install`           | `{ agentId, method? }`                   | none                                            | A package agent's first-use install, without starting it; a binary agent's by `method` or the first available route, as `task` ([installing binary agents](./agent-host.md#installing-binary-agents))                          |
| `agents.cancelTask`        | `{ agentId }`                            | none                                            | Stops a running install or update and resolves once it has stopped, or clears a failed `task`                                                                                                                                  |
| `agents.start`             | `{ agentId }`                            | none                                            | Starts the agent ahead of a session, then reads its options when none are known ([config options](./session-model.md#config-options)); rejects with `agent_unavailable` when it cannot run                                     |
| `agents.refreshLimits`     | `{ agentId }`                            | none                                            | Reads the plan limits from the agent's report (Claude Code's `/usage`, Codex's `/status`), at most once a minute ([plan limits](./session-model.md#plan-limits))                                                               |
| `agents.details`           | `{ agentId }`                            | `AgentDetails`                                  | The agent's own CLI version and where it reads its configuration, for its page in Settings › Agents ([agent configuration](./agent-host.md#agent-configuration))                                                               |
| `agents.refreshAccount`    | `{ agentId }`                            | none                                            | Brings the account and plan limits up to date for Settings › Agents: starts an agent that reports them (`reportsAccount` in the catalog) unless it would need an install, then reads the limits as `agents.refreshLimits` does |
| `agents.listSessions`      | `{ agentId, projectPath, cursor? }`      | `{ sessions: ImportableSession[], nextCursor }` | The agent's own `session/list`, for import                                                                                                                                                                                     |
| `agents.options`           | none                                     | `AgentOptions[]`                                | Each agent's config options from its last new session and the values last chosen, for New session ([config options](./session-model.md#config-options))                                                                        |
| `projects.list`            | none                                     | `Project[]`                                     |                                                                                                                                                                                                                                |
| `projects.add`             | `{ path }`                               | `Project`                                       | The path comes from main's folder picker                                                                                                                                                                                       |
| `projects.remove`          | `{ path }`                               | none                                            | Removes the project and its index entries, not the agent's sessions                                                                                                                                                            |
| `projects.touch`           | `{ path }`                               | none                                            | Marks the project opened now, for the recent list                                                                                                                                                                              |
| `sessions.list`            | `{ projectPath? }`                       | `SessionSummary[]`                              |                                                                                                                                                                                                                                |
| `sessions.create`          | `{ agentId, projectPath, parentId? }`    | `SessionSummary`                                | Resolves when `session/new` succeeds, or in `auth_required`; `projectPath: null` for a [scratch folder](./session-model.md#sessions-without-a-project); [`options?`](./session-model.md#config-options); `prompt?`: first turn |
| `sessions.import`          | `{ agentId, projectPath, acpSessionId }` | `SessionSummary`                                |                                                                                                                                                                                                                                |
| `sessions.open`            | `{ sessionId }`                          | `SessionSnapshot`                               | The latest page, from the stored thread without the agent; a session with none loads from its agent ([pages](./session-model.md#pages))                                                                                        |
| `sessions.snapshot`        | `{ sessionId, from? }`                   | `SessionSnapshot`                               | For gaps and reconnects; with `from`, every entry from that position on                                                                                                                                                        |
| `sessions.page`            | `{ sessionId, before }`                  | `OlderPage`                                     | The page that ends before the position `before`, a snapshot's or page's `older`                                                                                                                                                |
| `sessions.watch`           | `{ sessionId }`                          | none                                            | Start receiving `session.patches` for it                                                                                                                                                                                       |
| `sessions.show`            | `{ sessionId }`, or `null` for none      | none                                            | The session this port shows in front; only it counts as seen ([unread](./session-model.md#how-the-host-keeps-sessions))                                                                                                        |
| `sessions.unwatch`         | `{ sessionId }`                          | none                                            |                                                                                                                                                                                                                                |
| `sessions.prompt`          | `{ sessionId, content: UserContent[] }`  | none                                            | Resolves once the turn starts; the turn itself arrives as patches                                                                                                                                                              |
| `sessions.cancel`          | `{ sessionId }`                          | none                                            |                                                                                                                                                                                                                                |
| `sessions.retry`           | `{ sessionId }`                          | none                                            | Re-runs what failed ([session model](./session-model.md#how-the-host-keeps-sessions))                                                                                                                                          |
| `sessions.queue`           | `{ sessionId, content: UserContent[] }`  | `{ itemId: string \| null }`                    | Sends at once when free (`null`), else queues ([queue and steering](./session-model.md#queue-and-steering))                                                                                                                    |
| `sessions.unqueue`         | `{ sessionId, itemId }`                  | none                                            |                                                                                                                                                                                                                                |
| `sessions.steer`           | `{ sessionId, itemId }`                  | none                                            | `_session/steering` of a queued prompt into the running turn                                                                                                                                                                   |
| `sessions.resumeQueue`     | `{ sessionId }`                          | none                                            | Unpauses the queue and sends the oldest prompt when free                                                                                                                                                                       |
| `sessions.fork`            | `{ sessionId, entryId? }`                | `SessionSummary`                                | `session/fork` of a `ready` or `closed` session, from the reply whose agent message `entryId` names when given ([session model](./session-model.md#how-the-host-keeps-sessions))                                               |
| `sessions.context`         | `{ sessionId }`                          | `ContextBreakdown \| null`                      | `/context` in a throwaway fork of a `ready` session ([context breakdown](./session-model.md#context-breakdown))                                                                                                                |
| `sessions.setConfigOption` | `{ sessionId, optionId, value }`         | none                                            | The new config arrives as a patch                                                                                                                                                                                              |
| `sessions.rename`          | `{ sessionId, title }`                   | none                                            | An empty or null `title` returns to the agent's; the new title arrives in the summary                                                                                                                                          |
| `sessions.close`           | `{ sessionId }`                          | none                                            |                                                                                                                                                                                                                                |
| `sessions.delete`          | `{ sessionId }`                          | none                                            | The UI confirms first; sub-sessions go with it                                                                                                                                                                                 |
| `sessions.removeEmpty`     | `{ keep }`                               | none                                            | Once per index, the sessions left with no message go, except those in `keep`, which hold a draft ([session model](./session-model.md#how-the-host-keeps-sessions))                                                             |
| `sessions.removeAll`       | none                                     | none                                            | Clears the index; the agents keep their transcripts                                                                                                                                                                            |
| `permissions.respond`      | `{ sessionId, requestId, optionId }`     | none                                            |                                                                                                                                                                                                                                |
| `diagnostics.collect`      | none                                     | `DiagnosticsBundle`                             | Main writes it to disk ([agent host](./agent-host.md#diagnostics))                                                                                                                                                             |
| `git.*`                    |                                          |                                                 | Repository status and pull requests ([git](./git.md#host-protocol))                                                                                                                                                            |
| `usage.*`                  |                                          |                                                 | Token usage: the page's figures, today's total, sync and re-import ([usage](./usage.md#host-protocol))                                                                                                                         |
| `files.list`               | `{ projectPath }`                        | `FileList`                                      | Paths relative to the project, sorted; stops at 50,000 ([project files](./agent-host.md#project-files))                                                                                                                        |
| `files.read`               | `{ projectPath, path }`                  | `FileContent`                                   | `text` with `version` and `editable`; `media` with a [media URL](./media.md#granting-a-file) instead of bytes; `binary`; or `too-large` with its `limit` (1 MiB); a path out of the project is `invalid_params`                |
| `media.open`               | `{ projectPath, path, sessionId }`       | `MediaOpenResult`                               | `granted` with a `MediaGrant` for a media file inside the session's folder or named in its thread; else `not_found`, `forbidden` or `not_media` ([media](./media.md#granting-a-file))                                          |
| `files.search`             | `{ projectPath, query }`                 | `FileSearch`                                    | Literal, case-insensitive; at most 500 matches of 300 characters, then `truncated`                                                                                                                                             |
| `files.write`              | `{ projectPath, path, text, version }`   | `{ version, size }`                             | Replaces an existing file's text, up to 1 MiB; `conflict` when `version` no longer matches the file, unless it is null ([project files](./agent-host.md#project-files))                                                        |
| `attachments.add`          | `{ source, thumb }`                      | `Attachment`                                    | A draft's attachment from `{ grantId }`, `{ projectPath, path }` or `{ bytes, mimeType, name }`, kept until sent or removed, with the renderer's thumbnail, or null ([attachments](./session-model.md#where-the-bytes-live))   |
| `attachments.read`         | `{ id }`                                 | `{ mimeType, bytes }`                           | An image's bytes as an `ArrayBuffer`, up to 20 MB, for its thumbnail and its full view                                                                                                                                         |
| `attachments.update`       | `{ id, thumb, scaled }`                  | `Attachment`                                    | A picked or dropped image's thumbnail, and when it was too large, the copy the renderer scaled, `{ bytes, mimeType }`, in place of its bytes; `scaled` null keeps them                                                         |
| `attachments.remove`       | `{ id }`                                 | none                                            |                                                                                                                                                                                                                                |
| `sessions.blob`            | `{ sessionId, hash }`                    | `{ mimeType, bytes }`                           | A sent image or pasted text from the thread store, for its full view                                                                                                                                                           |
| `artifacts.*`              |                                          |                                                 | The Artifacts page and viewer: list, read, versions, rename, delete, restore, watch ([artifacts](./artifacts.md#ipc-and-host-protocol))                                                                                        |

```ts
interface SessionSummary {
  id: string
  agentId: AgentId
  projectPath: string
  scratch: boolean // started with No project, in its own scratch folder
  title: string | null
  status: SessionStatus
  attention: 'none' | 'permission' | 'unread' | 'error'
  updatedAt: number
  parentId: string | null
  branch: string | null // the branch checked out when its last turn ended
  pr: { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; url: string } | null
}
```

`attention` drives the sidebar: `permission` while a request is pending, `unread` after a turn ended in a session the user is not viewing, `error` after a failure.

```ts
interface AgentStatus {
  id: AgentId
  name: string
  state:
    | 'not-installed'
    | 'node-missing'
    | 'node-outdated'
    | 'available'
    | 'installing'
    | 'starting'
    | 'ready'
    | 'stopping'
    | 'failed'
  version: string | null // from agentInfo, once initialized
  package: { name: string; version: string; installed: boolean } | null // a package agent's adapter: the version a start runs (an older one kept when the pin could not be installed), else the pinned one
  signIn: 'unknown' | 'signed-in' | 'required'
  authMethods: {
    id: string
    name: string
    description?: string
    type: 'agent' | 'terminal'
    command?: string
  }[]
  canLogout: boolean
  account: AgentAccount | null // what the agent reports through `_auth/status_update`, or last reported in an earlier run
  limits: PlanLimit[] // subscription windows, see plan limits in the session model
  detail: string | null // install hint or error message
  progress: string[] // latest npm output or stderr lines while installing or starting
  update: { adapterVersion: string; cliVersion: string | null } | null // from the last update check; null when up to date or unchecked
  updateCheckedAt: number | null // when that check finished; always null for binary agents
  task: AgentTask | null // an install or update the user asked for
  installMethods: { id: 'brew' | 'npm' | 'script'; command: string; available: boolean }[] // a binary agent's routes; empty for the others
  cli: AgentCli | null // which CLI a Claude Code or Codex adapter runs; null for the others and while it cannot run
}

// See using the installed CLI in the agent host design.
interface AgentCli {
  command: string // looked up on PATH: claude or codex
  prefer: 'installed' | 'bundled' // the setting: the installed program when it can run, or always the copy
  runs: 'installed' | 'bundled' // what a start runs now
  active: 'installed' | 'bundled' | null // what the running adapter process uses; null while none runs
  needsCopy: boolean // the copy is to run but is not on disk: the next start downloads it
  copyMegabytes: number // about how much that download is: 256 for Claude Code, 318 for Codex
  installed: {
    path: string // as the adapter runs it, after resolving shims
    version: string | null
    variable: string | null // CLAUDE_CODE_EXECUTABLE or CODEX_PATH when the environment named it, which then decides alone
    problem:
      | { kind: 'unsupported' } // cannot run without a shell
      | { kind: 'failed'; reason: string } // its version could not be read, or a start with it failed
      | { kind: 'too-old'; minimum: string }
      | { kind: 'no-minimum' } // the adapter names no version it needs
      | null
  } | null // null: none found
}

interface AgentTask {
  kind: 'install' | 'update'
  state: 'running' | 'failed'
  command: string // what runs, quoted for the platform
  method: 'brew' | 'npm' | 'script' | null // the route a binary agent's install took, which a retry takes again
  progress: string[] // the latest output lines
  error: string | null // why it failed, in the user's terms
}

interface AgentDetails {
  cliVersion: string | null // the CLI an adapter runs, such as Claude Code inside its ACP adapter; null for the others
  config: AgentConfigItem[] // in the order Settings lists them: folder, settings, instructions
}

interface AgentConfigItem {
  id: 'folder' | 'settings' | 'instructions'
  path: string
  exists: boolean
  env: string | null // the variable that set this path, such as CLAUDE_CONFIG_DIR; null at the default
}

interface Project {
  path: string
  name: string
  missing: boolean // the folder no longer exists
  lastOpenedAt: number
}

interface ImportableSession {
  acpSessionId: string
  title: string | null
  updatedAt: string | null
  imported: boolean // already in the session index
}
```

- `state` follows the [agent process lifecycle](./agent-host.md#agent-process-lifecycle), plus the detection results that come before it.
- Stable ACP v1 has no way to ask whether an agent is signed in, so `signIn` starts as `unknown`. It becomes `required` when a request fails with `auth_required`, and `signed-in` after `authenticate` or any session request succeeds. Agents that push `_auth/status_update` (Claude Code and Codex) set it directly, before any session exists ([plan limits](./session-model.md#plan-limits)).
- For `terminal` methods, `command` is the full command to show, already quoted for the user's platform.
- `update` is decided against what is installed whenever the status is built, from the last check's result, so it shows after a restart without the network and clears once the update is installed. While an update runs, the agent's `state` is unchanged: a running agent keeps running, and `task` carries the progress. A package agent's first-use install shows as `state: 'installing'` with `progress`, not as a `task`, since a start waiting on it shares it ([installing adapters](./agent-host.md#installing-adapters)).
- `agents.update` and `agents.install` resolve once their work is done or cancelled, and reject with its failure; `agents.install` ignores `method` for a package agent. A failed `task` stays until `agents.cancelTask` clears it, the request runs again, or its aim is reached another way (the agent is found installed, or the update is no longer offered), and never changes `state`. A cancelled task leaves no `task`.
- `agents.details` is read when the Agents list or an agent's page shows, and is not pushed: the host looks at the disk for each request and answers without starting the agent. It never returns the contents of the configuration files. Unknown agents are `invalid_params`; the fake agent has no configuration, so its `config` is empty.

## Events

| Event                   | Payload                           | Sent to                                                                                                       |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `session.patches`       | `PatchBatch`                      | Ports watching that session                                                                                   |
| `session.summary`       | `SessionSummary`                  | All ports, whenever a field changes: status, title, attention, `permissionCount`, `updatedAt`, `branch`, `pr` |
| `session.removed`       | `{ sessionId }`                   | All ports                                                                                                     |
| `agent.status`          | `AgentStatus`                     | All ports, also when its account or a plan limit changes                                                      |
| `agent.options`         | `AgentOptions`                    | All ports, when an agent's options or remembered values change                                                |
| `projects.changed`      | `Project[]`                       | All ports, whenever the list or a folder's `missing` changes                                                  |
| `environment.changed`   | `EnvironmentInfo`                 | All ports, after each resolution of the environment                                                           |
| `git.changed`, `git.pr` | See [git](./git.md#host-protocol) | Ports keeping that project live                                                                               |
| `git.tools`             | `GitTools`                        | All ports                                                                                                     |
| `usage.*`               | `UsageStatus` or none             | All ports, when the figures or the scan change ([usage](./usage.md#host-protocol))                            |
| `artifacts.*`           | Per event                         | All ports for `changed`; watching ports for the rest ([artifacts](./artifacts.md#ipc-and-host-protocol))      |

Terminals use a port of their own to the terminal host, with the same envelope ([terminal](./terminal.md#host-protocol)).

Only watched sessions stream patches. Every other session costs the renderer one small summary per change, so ten agents working in the background do not slow down the one in view.

## Flow control

- The host queues patches per session and flushes each queue at most every 16 ms, merging consecutive `entry.appendText` patches for the same entry.
- A session's patches are flushed before its `session.summary`, so the sidebar never shows a state the thread has not reached.
- A watched session that receives patches faster than one batch per 16 ms simply gets larger batches; nothing is dropped.

## Validation

- Every request is validated in `src/agent-host/validate.ts` before the host acts on it: types, required fields, string lengths, and that ids refer to existing agents, sessions and requests.
- `projectPath` must be absolute and canonicalize to an existing directory ([platform rules](./agent-host.md#platform-differences)).
- Prompt content is limited to 10 MB in total, counted as sent, and to 20 attachments; images must have an image MIME type.
- Validators are small hand-written type guards. The contract is small enough that a schema library would cost more than it saves.
- A request that fails validation gets `invalid_params` and changes nothing.
- Validators return fresh params holding only the fields they know; unknown fields are dropped. Methods without params accept nothing, `null` or `{}`.
- An unknown `agentId` is `invalid_params`, since the catalog is fixed. A session or permission request that does not exist is `not_found`. Requests that need a live session (`sessions.prompt`, `sessions.cancel`, `sessions.setConfigOption`) fail with `busy` for one that is not open.
- A prompt holds text, images (base64 data with an `image/*` type), links and attachment refs; an `unsupported` ref cannot be sent, and a prompt with no text and no ref is empty and refused. Of an attachment ref the host reads only `id`, which must name a record it holds, and takes everything else from that record.
- `attachments.add` with `{ projectPath, path }` follows the containment rules of `files.read`; a `grantId` must be one main granted and not yet used, and its path must still be the file or folder it was granted as; `bytes` must be at most 20 MB, with a PNG, JPEG, GIF or WebP type, or `text/plain`; `thumb` must be a WebP, PNG or JPEG `data:` URL of at most 256 KB. `attachments.update` takes only an image's record, and a scaled copy of at most 20 MB in a PNG, JPEG, GIF or WebP type.
- Every `git.*` request answers `git_error` with "Git is not available yet" while the host runs without a git service.
