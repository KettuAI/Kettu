# Architecture

> Status: Draft for [M0](./milestones/m0.md) · Agent versions and capabilities were observed on 2026-10-20

OverBench is a GUI and nothing more. It does not implement an agent, call a model or store credentials. Every agent runs as its own process, owns its auth, models and history, and talks to OverBench over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). OverBench's job is to make that conversation fast, legible and beautiful.

This keeps the product honest to its philosophy: the agents are the best implementations of agent logic, ACP is the best existing contract for talking to them, and OverBench spends all of its effort on the experience on top.

This document is the overview. Each subsystem has a detailed design:

| Design                                     | Covers                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [Agent host](./design/agent-host.md)       | Startup and supervision, the agent catalog, environments, launching and stopping agents, sign-in, diagnostics, platform differences |
| [Session model](./design/session-model.md) | The thread model, patches and snapshots, the ACP v1 mapping, prompts, permissions, cancellation, session lifecycle                  |
| [Host protocol](./design/host-protocol.md) | The preload API, requests, events and validation between the renderer and the agent host                                            |
| [Persistence](./design/persistence.md)     | What is stored on disk, how it is written, versioned and recovered                                                                  |
| [Git](./design/git.md)                     | Repository status, pull requests through `gh`, and git events in the thread                                                         |
| [Terminal](./design/terminal.md)           | The terminal host, shells, flow control, rendering, and how terminals relate to projects and sessions                               |
| [Interface](./design/ui.md)                | Layout, screens, thread entries, composer, states, motion, typography and shortcuts                                                 |
| [Localization](./design/localization.md)   | English and Simplified Chinese, the Language setting, and how each process translates its own text                                  |
| [Testing](./design/testing.md)             | Unit, integration and process tests, the fake agent, CI, and how performance is measured                                            |

## Process model

```mermaid
flowchart LR
  subgraph app [OverBench]
    R["Renderer<br/>React UI"]
    M["Main process<br/>windows, menus, dialogs"]
    H["Agent host<br/>utility process"]
    T["Terminal host<br/>utility process"]
    R -- "typed IPC" --> M
    M -- "lifecycle, port handoff" --> H
    M -- "lifecycle, port handoff" --> T
    R <-- "MessagePort<br/>session RPC + events" --> H
    R <-- "MessagePort<br/>terminal data" --> T
  end
  T <-- "node-pty" --> S["Shells"]
  H <-- "ACP v1, NDJSON over stdio" --> C["claude-agent-acp"]
  H <-- "ACP v1" --> X["codex-acp"]
  H <-- "ACP v1" --> O["opencode acp"]
```

| Process       | Runs                                | Owns                                                                                                                    |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Main          | Electron main                       | App lifecycle, windows, menus, native dialogs and notifications, agent host supervision, [updates](./design/updates.md) |
| Renderer      | Sandboxed Chromium                  | UI, view state, a replica of each session it shows                                                                      |
| Agent host    | Electron `utilityProcess` (Node.js) | ACP connections, agent processes, live session state, persistence                                                       |
| Terminal host | Electron `utilityProcess` (Node.js) | Pseudo-terminals for the built-in [terminal](./design/terminal.md), started on first use                                |
| Agent process | One per agent, spawned by the host  | The agent itself: model calls, tools, auth, conversation storage                                                        |

**Why a separate agent host.** Main stays thin and never touches agent traffic, so a burst of tool output or a misbehaving adapter can never stall window dragging, menus or other windows. If the host crashes, main restarts it and the UI reconnects; the window survives. This is the same split VS Code uses for its pty host and extension host.

Alternatives considered:

- **ACP in the main process**: simplest, but couples agent traffic to the process every window depends on. Rejected.
- **ACP in the renderer**: would need Node.js in the renderer, which breaks the security model. Rejected.
- **One utility process per agent**: stronger isolation, more processes and more plumbing. Revisit only if measurements show one agent's traffic starving another.

### Channels

- **Renderer to main**: the typed `ipcRenderer.invoke` contract in `src/shared/ipc.ts`, for what only main can do: folder and file pickers, saving diagnostics, window controls.
- **Renderer to agent host**: a `MessagePort` per page, created by main. The preload keeps it in the isolated world and exposes `window.overbench.agents`, so session traffic skips main and page scripts never hold a raw channel. See [host protocol](./design/host-protocol.md).
- **Renderer to terminal host**: a second `MessagePort` per page, exposed as `window.overbench.terminals`, so terminal output never shares a queue with session patches. See [terminal](./design/terminal.md#host-protocol).
- **Main to agent host**: `utilityProcess` messages for startup, port handoff, binary overrides, notifications and shutdown. See [agent host](./design/agent-host.md#main-and-host-messages).
- **Agent host to agents**: ACP over each agent's stdin and stdout as newline-delimited JSON-RPC, through the official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk).

### Cross-platform

OverBench treats macOS, Windows and Linux as equals. Electron covers the interface; the differences that remain sit where OverBench meets the operating system: finding executables, the environment of an app launched from a desktop shell, spawning `.cmd` shims, stopping process trees, comparing paths, and window chrome. The [agent host](./design/agent-host.md#platform-differences) and [interface](./design/ui.md#window-and-chrome) designs settle each of them, and [CI](./design/testing.md#continuous-integration) runs the process tests on all three platforms.

## ACP integration

### Protocol version

All three agents speak ACP **v1**, the stable protocol. ACP v2 has been in draft since 2026-07-20, and its announcement advises clients not to enable it by default in production yet. OverBench therefore negotiates v1 and keeps v2 out of M0, but isolates the protocol so that adding v2 later is contained:

- ACP types never leave `src/agent-host/acp/`.
- One mapper turns ACP messages into OverBench's own [session model](./design/session-model.md). v2 becomes a second mapper, selected by the negotiated `protocolVersion`.
- The session model already uses v2's ideas, stable entry IDs and patches, so the renderer will not change when v2 arrives.

M0 uses only stable v1 methods, with two exceptions that the Claude Code and Codex adapters already implement: the subagents RFD, which [sub-sessions](./design/session-model.md#subagents) depend on, and the optional `usage` field of the `session/prompt` response, which fills the [session's token totals](./design/session-model.md#prompt-turns). Their types stay inside the mapper like every other ACP type. Because the SDK validates every `session/update` against its entrypoint's schema and the stable schema drops the subagent updates, the host imports the SDK's `unstable` v1 entrypoint ([agent host](./design/agent-host.md#connecting)); it still calls only the stable methods and these two exceptions. Since M0's acceptance, `session/fork` is a third exception, used only when the agent advertises `sessionCapabilities.fork` ([session model](./design/session-model.md#how-the-host-keeps-sessions)); other unstable features stay off until they stabilize.

The mapper also reads two adapter extensions outside ACP, for the [account and plan limits](./design/session-model.md#plan-limits): the `_auth/status_update` notification and the `_claude/rateLimit` key in `usage_update._meta`. An agent that does not send them simply shows no plan.

### Agents

| Agent       | How it speaks ACP                                       | Sign-in methods it advertises                    | Logout |
| ----------- | ------------------------------------------------------- | ------------------------------------------------ | ------ |
| Claude Code | Official adapter `claude-agent-acp`, installed from npm | terminal: Claude subscription, Anthropic Console | yes    |
| Codex       | Official adapter `codex-acp`, installed from npm        | agent: API key, ChatGPT                          | yes    |
| OpenCode    | Natively, `opencode acp`, from the user's installation  | terminal: Login with opencode                    | no     |

- Claude Code and Codex have no native ACP mode; the official adapters from the [ACP Registry](https://agentclientprotocol.com/get-started/registry) wrap them. Versions are pinned to what the registry lists and bumped deliberately after testing; the exact packages are in the [agent catalog](./design/agent-host.md#agent-catalog).
- The adapters need Node.js 22 or later with npm on the user's machine. OverBench installs the pinned version into its data directory with the user's npm on first use and runs it with the user's Node.js; Electron's bundled Node.js was rejected for them ([installing adapters](./design/agent-host.md#installing-adapters)).
- The registry lists `claude-agent-acp` under a proprietary license. OverBench never bundles it; the user's npm fetches it on the user's machine, the same way other registry clients install it.
- OverBench uses the user's existing `opencode`, so it reuses their configuration and login. The registry's OpenCode build (1.19.3) lags behind current releases (2.0.32 was tested).

What all three advertised in `initialize`:

| Capability                                                          | Claude Code | Codex | OpenCode |
| ------------------------------------------------------------------- | :---------: | :---: | :------: |
| `loadSession`                                                       |      ✓      |   ✓   |    ✓     |
| `session/list`, `session/resume`, `session/close`, `session/delete` |      ✓      |   ✓   |    ✓     |
| `additionalDirectories`                                             |      ✓      |   ✓   |    ✓     |
| Prompt `image` and `embeddedContext`                                |      ✓      |   ✓   |    ✓     |
| MCP over HTTP / SSE                                                 |    ✓ / ✓    | ✓ / – |  ✓ / –   |

Agent-specific extensions (`_meta`) such as steering, prompt queueing and auth status exist but are unstable. Since M0's acceptance OverBench uses one of them, `_session/steering`, where an agent advertises it and honours `idleBehavior` ([queue and steering](./design/session-model.md#queue-and-steering)); the queue itself is OverBench's own.

### Client capabilities

What OverBench advertises in `initialize` for M0, and why:

| Capability                              | M0  | Reason                                                                                                                                            |
| --------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs.readTextFile`, `fs.writeTextFile`   | off | OverBench has no editor buffers yet, so the agents' own file tools are the better implementation. Turned on with change tracking and checkpoints. |
| `terminal`                              | off | Agents run commands themselves and report output in tool calls. The built-in terminal is the user's, not the agents'.                             |
| `auth.terminal`                         | on  | Claude Code and OpenCode only offer sign-in through terminal methods.                                                                             |
| `session.notices`, `session.compaction` | on  | The thread renders notices and compaction markers.                                                                                                |
| `session.configOptions.boolean`         | on  | Boolean options render as switches.                                                                                                               |
| `elicitation`                           | off | Structured questions come later; agents fall back to plain messages.                                                                              |
| `subagents`                             | on  | Subagents the agent runs become [sub-sessions](./design/session-model.md#subagents) the user can watch and answer.                                |

### Agents and sessions at a glance

- An agent process starts with the first session that needs it and then serves all of that agent's sessions, in every project. It stops after 5 idle minutes and at quit. After a crash it is not started again until a session needs it. See [agent host](./design/agent-host.md#agent-process-lifecycle).
- Agents own their credentials. `agent` sign-in methods run through `authenticate`; `terminal` methods run their command in the built-in terminal, or show it to copy. See [sign-in](./design/agent-host.md#sign-in).
- New sessions use `session/new` with the project folder as `cwd`. Opening a session reads its stored thread and starts no agent; using it attaches it with `session/resume`, which replays nothing, also after a crash. A session with no stored thread opens with `session/load`, which replays the conversation. See [session lifecycle](./design/session-model.md#session-lifecycle).

```mermaid
stateDiagram-v2
  [*] --> starting: session/new or load
  [*] --> closed: opened from the store
  starting --> ready
  starting --> auth_required
  auth_required --> starting: signed in
  ready --> running: session/prompt
  running --> awaiting_permission: session/request_permission
  awaiting_permission --> running: user answers
  running --> ready: stop reason
  ready --> closed: session/close, released, or agent exited
  running --> closed: agent exited
  closed --> running: prompt, after session/resume
```

### A prompt turn

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant H as Agent host
  participant A as Agent
  UI->>H: sessions.prompt(id, content)
  H->>A: session/prompt
  loop while the agent works
    A-->>H: session/update (text, thoughts, tool calls, plan, usage)
    H-->>UI: patch batch, at most every 16 ms
  end
  A->>H: session/request_permission
  H-->>UI: tool entry awaiting permission
  UI->>H: permissions.respond(optionId)
  H->>A: outcome selected
  A-->>H: session/prompt result (stopReason)
  H-->>UI: turn ended
```

## State and data flow

The agent host is the source of truth for every live session. Its mapper turns ACP messages into patches against OverBench's own [session model](./design/session-model.md) and applies them to its copy. The renderer holds a replica: it starts from a snapshot and applies patch batches in sequence order, refetching a snapshot on any gap. Both sides apply the same patch rules: the renderer with `applyPatches`, which shares unchanged objects, and the host in place with `applyPatchInPlace`, since it owns its copy alone and copying per patch made replays quadratic. Window reloads, closing and reopening a window on macOS, and future multi-window support all work without special cases.

### Keeping streaming smooth

- **Coalesce in the host.** Patches are queued per session and flushed at most every 16 ms. Consecutive text appends to the same entry merge into one.
- **Only what is on screen streams.** The renderer receives patches only for sessions it watches; every other session sends one small summary per change.
- **One store update per batch.** The renderer applies each batch in a single Zustand update.
- **Normalized state, narrow subscriptions.** Entries are stored by id and each entry component selects only its own entry, so streaming into one message re-renders one component.
- **Cheap off-screen content.** Thread items use CSS `content-visibility: auto`, so the browser skips layout and paint for off-screen entries. A virtualization library is added only if measurements show it is needed.
- **Heavy work off the main thread, and loaded late.** Diff highlighting runs in a worker pool; markdown, Shiki and the diff renderer load the first time a session needs them.

### Persistence

The host keeps a few small JSON files, recent projects and the session index, and main keeps the settings; all are written atomically and versioned. The host also keeps its own copy of every session's thread in a SQLite database, owned by a worker thread and read a page at a time, so a session opens without its agent; the agents keep their transcripts and the context a session continues from. Token usage has a database and worker of its own, which also reads the agents' logs when the user allows it ([usage statistics](./design/usage.md)). Credentials and diagnostics are never written. See [persistence](./design/persistence.md).

## Security

OverBench drives agents that edit files and run commands, so every layer assumes the one next to it can be wrong.

- **Agent output is untrusted.** Markdown is rendered sanitized, without raw HTML. The CSP blocks remote images, so content in a reply cannot load tracking pixels or leak data through image URLs. Links open in the system browser only after the `http(s)` check in main.
- **The renderer cannot run commands, except in the terminal.** The agent host has no API that takes a command line. Agent launch specs come from the catalog, and binary and shell overrides come from a native dialog in main. The built-in terminal is the one deliberate exception: what the user types there runs in a shell, so its safety rests on the renderer's integrity, and no agent output is ever written into a terminal ([terminal security](./design/terminal.md#security)).
- **Git is read-only.** The git service runs status commands and `git fetch` only; it never commits, pushes or rewrites anything, and pull requests come through the user's own `gh` sign-in ([git](./design/git.md)).
- **Every request to the host is validated**, including that a project folder is an absolute path to an existing directory. See [validation](./design/host-protocol.md#validation).
- **Permission requests are shown faithfully.** OverBench never answers one without the user, and never switches an agent into a bypass or full-auto mode by default.
- **No credentials.** OverBench stores no API keys or tokens; agents keep their own.
- **Diagnostics stay local** until the user exports them, and the export leaves out environment variables that could hold secrets.
- The renderer keeps `sandbox`, `contextIsolation` and the narrow preload API, as described in [AGENTS.md](../AGENTS.md#security-rules).

## Directory layout

The layout as M0 built it.

```text
src/
├── main/                  Main process
│   ├── index.ts           App lifecycle, single-instance lock
│   ├── window.ts          Main window, navigation lock
│   ├── ipc.ts             IPC handlers
│   ├── settings.ts        settings.json: validated on every change, written atomically
│   ├── agent-host.ts      Starts and supervises the agent host, hands out ports, shows notifications
│   ├── terminal-host.ts   Starts the terminal host on first use, hands out its ports
│   ├── menu.ts            The application menu
│   ├── i18n.ts            Main's own text: the menu, dialogs, the quit confirmation
│   └── updater.ts         Checks, downloads and installs updates through electron-updater
├── agent-host/            Utility process
│   ├── index.ts           Entry, port wiring
│   ├── host.ts            The host assembled: state, agents, sessions, git and the ports
│   ├── rpc.ts             Requests and events on renderer ports
│   ├── validate.ts        Request validators
│   ├── shell-env.ts       Login shell environment resolution
│   ├── catalog.ts         Built-in agent definitions
│   ├── agents.ts          Supervision: detection, lazy start, crash counting, sign-in state
│   ├── agent-process.ts   Spawning, stopping, stderr capture
│   ├── process-tree.ts    Listing and stopping process trees; main uses it too
│   ├── agent-trees.ts     The agent processes and what they leave, recorded until gone
│   ├── acp/               SDK connection and the v1 mapper; the only place ACP types live
│   ├── sessions.ts        Live session state, prompts, permissions
│   ├── projects.ts        Recent project folders
│   ├── git/               Repository status, watchers, pull requests through gh
│   ├── storage.ts         JSON persistence
│   ├── threads/           The thread database: its worker, SQLite pages, and the host's store
│   ├── usage/             Token usage: the record, the agents' log readers, its database and worker
│   ├── diagnostics.ts     Traffic and stderr ring buffers
│   └── i18n.ts            The text the host writes for the user, in the chosen language
├── terminal-host/         Utility process owning node-pty terminals
├── preload/               window.overbench, with its agents and terminals ports
├── renderer/src/
│   ├── app/               Bootstrap, actions, shortcuts, menu commands
│   ├── features/          agents, home, session (thread, composer, tool calls, permissions), sidebar, git, terminal, settings, updates, usage
│   └── stores/            Zustand stores
└── shared/
    ├── ipc.ts             Renderer to main contract
    ├── agent-host.ts      Renderer to agent host contract
    ├── host-control.ts    Main to agent host messages
    ├── terminal-host.ts   Renderer to terminal host contract
    ├── thread.ts          Session model, applyPatches and applyPatchInPlace
    ├── locale.ts          Interface languages and the Language setting's resolution
    └── locales/           Message catalogs, one folder per language
tools/
├── fake-agent/            Scripted ACP agent for development and tests
├── perf/                  Performance measurement script and its CI runner
├── screenshots/           Screenshot capture of the main screens, run in CI
├── workflow/              The pull request and release checks CI runs, and the commit title parser
└── launch.mjs             Starts a production build for perf and screenshots
```

## What we take from where

In line with the project philosophy, these are the implementations this design draws on:

| Source                                                                                                                           | What OverBench takes                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ACP specification](https://agentclientprotocol.com) and [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | The wire protocol, method semantics and the client connection                                                                                                                                                                                                                                                                                                                 |
| [ACP Registry](https://agentclientprotocol.com/get-started/registry)                                                             | Which adapter and version to launch for each agent, and the Claude Code mark                                                                                                                                                                                                                                                                                                  |
| [Zed](https://zed.dev/docs/ai/external-agents)                                                                                   | External agents as separate processes, thread entries keyed by tool call, an inspectable ACP traffic log; one quiet, dismissible update control that appears only when an update is ready                                                                                                                                                                                     |
| VS Code                                                                                                                          | Hosting heavy work in a utility process; resolving the login shell environment for GUI launches; settings as one searchable page with a table of contents; a separate pty host with flow control and its default ANSI colors (MIT); git status without index locks (`GIT_OPTIONAL_LOCKS=0`) and branch and sync labels; the first update check 30 s after launch, then hourly |
| [xterm.js](https://xtermjs.org)                                                                                                  | The terminal emulator and its GPU renderer, as used by VS Code, Hyper and Tabby                                                                                                                                                                                                                                                                                               |
| GitHub Desktop and the GitHub CLI                                                                                                | "Last fetched" next to Fetch; pull requests through the user's own `gh` sign-in                                                                                                                                                                                                                                                                                               |
| [Harnss](https://github.com/OpenSource03/harnss), [AionUi](https://github.com/iOfficeAI/AionUi)                                  | Per-project workspaces, tool calls as cards with diffs, pending-approval badges and OS notifications                                                                                                                                                                                                                                                                          |
| [OpenCode](https://github.com/sst/opencode)                                                                                      | Subagents as child sessions of the session that started them; the OpenCode mark                                                                                                                                                                                                                                                                                               |
| [LobeHub Icons](https://github.com/lobehub/lobe-icons)                                                                           | The Codex mark in its colors                                                                                                                                                                                                                                                                                                                                                  |
| shadcn/ui chat primitives                                                                                                        | `MessageScroller` for stick-to-bottom, anchoring and jump-to-latest while streaming                                                                                                                                                                                                                                                                                           |
| [i18next](https://www.i18next.com), as AionUi, Cherry Studio and LobeHub use it                                                  | Message catalogs, plurals and switching the language live in the renderer, main and the agent host ([localization](./design/localization.md))                                                                                                                                                                                                                                 |
| [Streamdown](https://streamdown.ai) and [Diffs](https://diffs.com)                                                               | Markdown that renders correctly mid-stream, and diffs highlighted off the main thread                                                                                                                                                                                                                                                                                         |
| Claude Desktop, through the [open-claude-ui](https://github.com/Caho1/open-claude-ui) analysis                                   | The visual and interaction benchmark for the first version: surfaces, density, lines, motion, composer and approvals ([design system](./design/design-system.md#design-reference)); pull request badges on session rows and pull request chips in the thread                                                                                                                  |
