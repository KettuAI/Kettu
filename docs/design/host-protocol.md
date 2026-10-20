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
}
```

Exposed as `window.overbench.agents`.

- `request` accepts only method names from the contract; the preload checks the name against an allowlist before posting.
- `onEvent` and `onConnection` return an unsubscribe function.
- While the port is being replaced after `agent-host:reset`, requests in flight reject with `host_restarted`. After `connected`, the renderer's stores refetch snapshots for the sessions they watch.

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
    | 'agent_unavailable'
    | 'auth_required'
    | 'agent_error'
    | 'host_restarted'
    | 'internal'
  message: string
  data?: unknown
}
```

- Values cross the port by structured clone, and then once more through `contextBridge`. Payloads stay plain data: no class instances, functions or `Map`s.
- Request ids are per port. The host answers every request exactly once.

## Requests

| Method                     | Params                                   | Result                                          | Notes                                                               |
| -------------------------- | ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `agents.list`              | none                                     | `AgentStatus[]`                                 | Detection state, version, sign-in state, capabilities summary       |
| `agents.check`             | `{ agentId? }`                           | `AgentStatus[]`                                 | Runs detection again                                                |
| `agents.reloadEnvironment` | none                                     | `AgentStatus[]`                                 | Resolves the shell environment again, then runs detection           |
| `agents.authenticate`      | `{ agentId, methodId }`                  | none                                            | `agent`-type methods only                                           |
| `agents.logout`            | `{ agentId }`                            | none                                            | Only when the agent advertises logout                               |
| `agents.listSessions`      | `{ agentId, projectPath, cursor? }`      | `{ sessions: ImportableSession[], nextCursor }` | The agent's own `session/list`, for import                          |
| `projects.list`            | none                                     | `Project[]`                                     |                                                                     |
| `projects.add`             | `{ path }`                               | `Project`                                       | The path comes from main's folder picker                            |
| `projects.remove`          | `{ path }`                               | none                                            | Removes the project and its index entries, not the agent's sessions |
| `sessions.list`            | `{ projectPath? }`                       | `SessionSummary[]`                              |                                                                     |
| `sessions.create`          | `{ agentId, projectPath }`               | `SessionSummary`                                | Resolves when `session/new` succeeds                                |
| `sessions.import`          | `{ agentId, projectPath, acpSessionId }` | `SessionSummary`                                |                                                                     |
| `sessions.open`            | `{ sessionId }`                          | `SessionSnapshot`                               | Loads or resumes as needed; live sessions return at once            |
| `sessions.snapshot`        | `{ sessionId }`                          | `SessionSnapshot`                               | For gaps and reconnects                                             |
| `sessions.watch`           | `{ sessionId }`                          | none                                            | Start receiving `session.patches` for it                            |
| `sessions.unwatch`         | `{ sessionId }`                          | none                                            |                                                                     |
| `sessions.prompt`          | `{ sessionId, content: UserContent[] }`  | none                                            | Resolves once the turn starts; the turn itself arrives as patches   |
| `sessions.cancel`          | `{ sessionId }`                          | none                                            |                                                                     |
| `sessions.setConfigOption` | `{ sessionId, optionId, value }`         | none                                            | The new config arrives as a patch                                   |
| `sessions.close`           | `{ sessionId }`                          | none                                            |                                                                     |
| `sessions.delete`          | `{ sessionId }`                          | none                                            | The UI confirms first                                               |
| `permissions.respond`      | `{ sessionId, requestId, optionId }`     | none                                            |                                                                     |
| `diagnostics.collect`      | none                                     | `DiagnosticsBundle`                             | Main writes it to disk ([agent host](./agent-host.md#diagnostics))  |

```ts
interface SessionSummary {
  id: string
  agentId: AgentId
  projectPath: string
  title: string | null
  status: SessionStatus
  attention: 'none' | 'permission' | 'unread' | 'error'
  updatedAt: number
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
    | 'starting'
    | 'ready'
    | 'stopping'
    | 'crashed'
    | 'failed'
  version: string | null // from agentInfo, once initialized
  signIn: 'unknown' | 'signed-in' | 'required'
  authMethods: {
    id: string
    name: string
    description?: string
    type: 'agent' | 'terminal'
    command?: string
  }[]
  canLogout: boolean
  detail: string | null // install hint or error message
  progress: string[] // latest stderr lines while starting
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
- Stable ACP v1 has no way to ask whether an agent is signed in, so `signIn` starts as `unknown`. It becomes `required` when a request fails with `auth_required`, and `signed-in` after `authenticate` or any session request succeeds.
- For `terminal` methods, `command` is the full command to show, already quoted for the user's platform.

## Events

| Event             | Payload          | Sent to                                                             |
| ----------------- | ---------------- | ------------------------------------------------------------------- |
| `session.patches` | `PatchBatch`     | Ports watching that session                                         |
| `session.summary` | `SessionSummary` | All ports, whenever status, title, attention or `updatedAt` changes |
| `session.removed` | `{ sessionId }`  | All ports                                                           |
| `agent.status`    | `AgentStatus`    | All ports                                                           |

Only watched sessions stream patches. Every other session costs the renderer one small summary per change, so ten agents working in the background do not slow down the one in view.

## Flow control

- The host queues patches per session and flushes each queue at most every 16 ms, merging consecutive `entry.appendText` patches for the same entry.
- A session's patches are flushed before its `session.summary`, so the sidebar never shows a state the thread has not reached.
- A watched session that receives patches faster than one batch per 16 ms simply gets larger batches; nothing is dropped.

## Validation

- Every request is validated in `src/agent-host/validate.ts` before the host acts on it: types, required fields, string lengths, and that ids refer to existing agents, sessions and requests.
- `projectPath` must be absolute and canonicalize to an existing directory ([platform rules](./agent-host.md#platform-differences)).
- Prompt content is limited to 10 MB in total; images must have an image MIME type.
- Validators are small hand-written type guards. The contract is small enough that a schema library would cost more than it saves.
- A request that fails validation gets `invalid_params` and changes nothing.
