# Persistence

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.4](../milestones/m0.md#work-packages)

OverBench stores as little as it can. Agents already keep transcripts and credentials, so OverBench keeps only what it needs to put its own UI back together, including its own copy of each thread, so a session opens without starting its agent.

## What is stored, and where

All files live in `app.getPath('userData')` ([per platform](./agent-host.md#platform-differences)).

| File                         | Owner      | Contents                                                                                                                                           |
| ---------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/projects.json`        | Agent host | Recent project folders                                                                                                                             |
| `state/sessions.json`        | Agent host | The session index                                                                                                                                  |
| `state/agent-processes.json` | Agent host | The agent processes running and what they left, until seen gone, for the next host to stop ([process trees](./agent-host.md#process-trees))        |
| `state/agents.json`          | Agent host | The account and plan limits each agent last reported, shown after a restart until it reports again ([sign-in](./agent-host.md#sign-in))            |
| `state/agent-options.json`   | Agent host | Each agent's config options from its last new session, and the values last chosen, for [New session](./session-model.md#config-options)            |
| `state/threads.db`           | Agent host | Every session's thread, read a page at a time ([threads](#threads)), with its `-wal` and `-shm` files while it is open                             |
| `settings.json`              | Main       | [Settings](#settings)                                                                                                                              |
| `window-state.json`          | Main       | Window size, position and maximized state                                                                                                          |
| `app-state.json`             | Main       | The last version that ran and the dismissed update notice ([updates](./updates.md#storage))                                                        |
| `agents/`                    | Agent host | [Installed adapters](./agent-host.md#installing-adapters), one directory per agent and version                                                     |
| `scratch/`                   | Agent host | [Scratch folders](./session-model.md#sessions-without-a-project), one per session started with No project, never removed                           |
| `localStorage`               | Renderer   | Per-device view preferences, such as panel sizes, collapsed groups and whether the terminal panel is open, and [composer drafts](#composer-drafts) |

```ts
interface ProjectsFile {
  version: 1
  projects: { path: string; name: string; addedAt: number; lastOpenedAt: number }[]
}

interface AgentsFile {
  version: 1
  agents: Partial<Record<AgentId, { account: AgentAccount | null; limits: PlanLimit[] }>> // no signed-out accounts
}

interface SessionsFile {
  version: 1
  sessions: {
    id: string
    agentId: AgentId
    acpSessionId: string
    projectPath: string
    title: string | null
    createdAt: number
    updatedAt: number
    lastViewedAt: number | null
    parentId: string | null // for sub-sessions
    origin: 'user' | 'subagent'
    description: string | null // a subagent's purpose, as its parent described it
    branch: string | null // checked out when its last turn ended, for its pull request
    queue?: { id: string; content: UserContent[]; at: number }[] // prompts still waiting
  }[]
}
```

- `name` defaults to the folder name.
- `lastViewedAt` decides the `unread` attention state after a restart.
- A session enters the index once its `session/new` succeeds, when it is imported, or, for a subagent, as soon as its parent is in the index. Its entry is rewritten when its title, `updatedAt`, `lastViewedAt`, description, branch or queue changes.
- A saved `queue` comes back paused ([queue and steering](./session-model.md#queue-and-steering)); one that does not validate is dropped without failing the file.

## Settings

Main owns `settings.json`, because it needs the theme before the first window paints and it shows notifications, the Dock badge and the quit confirmation. It reads the file once at startup, asynchronously, before it creates a window.

```ts
interface SettingsFile {
  version: 1
  general: {
    language: 'system' | 'en' | 'zh-CN' // the interface language; see localization
    defaultAgent: AgentId | null // null: pick one on the New session screen each time
    sendKey: 'enter' | 'mod-enter' // the other key inserts a newline
    restoreLastSession: boolean
    confirmQuitWhileRunning: boolean
  }
  appearance: {
    theme: 'system' | 'light' | 'dark'
    textSize: 'small' | 'default' | 'large' // thread prose and the composer: 13, 14 or 15 px
    reduceMotion: 'system' | 'always'
    zoom: 0.8 | 0.9 | 1 | 1.1 | 1.25 | 1.5 // Chromium's page zoom of the whole window
  }
  notifications: {
    permission: boolean
    turnEnded: boolean
    error: boolean
    sound: boolean
    badge: boolean // the Dock icon on macOS, the taskbar button on Windows
  }
  agents: Partial<Record<AgentId, { binaryPath?: string }>>
  proxy: { mode: 'environment' } | { mode: 'custom'; url: string; noProxy: string }
  terminal: {
    shellPath?: string // picked in a native dialog; the platform default when absent
    fontSize: 12 | 13 | 14
  }
  git: { backgroundFetch: boolean }
  updates: { automatic: 'download' | 'notify' | 'off' }
}
```

- Defaults: the system's language, no default agent, Enter sends, restore and confirm on, the system theme, the default text size, 100% zoom, reduce motion following the system, every notification on except sound, the badge on, no binary overrides, the proxy from the environment, the default shell at 13 px, no background fetch, and updates downloaded and installed automatically.
- The renderer reads them with `settings:get` and changes them with `settings:update`, which takes a partial object (`SettingsPatch`). Main validates it against the schema (`src/main/settings-schema.ts`), rejects unknown keys and values, writes the file and sends `settings:changed` to every window. A patch with any problem is rejected whole, with an error naming each bad key, and changes nothing. Sections merge key by key; `proxy` is replaced whole, and a custom proxy URL must be an `http`, `https` or `socks` URL with a host.
- Executable paths, `agents.<id>.binaryPath` and `terminal.shellPath`, can only be cleared from the renderer, with `null`. Setting one goes through `dialog:choose-agent-binary` or `dialog:choose-shell`, which show a native file dialog in main and store the picked program.
- The renderer applies appearance settings as attributes on `<html>` (`data-theme`, `data-text-size`, `data-reduce-motion`) and the zoom as `--zoom`, so tokens switch in CSS without re-rendering components. Main applies the zoom to every window ([Interface: zoom](./ui.md#zoom)).
- The language resolves against the system's preferred languages in main and in the renderer ([localization](./localization.md#languages-and-the-setting)).
- `agents`, `proxy` and `git`, and the resolved language as `locale`, go to the agent host in `host:init` and `host:settings` ([agent host](./agent-host.md#main-and-host-messages)); `terminal` goes to the terminal host when it starts and when it changes. `updates` and `proxy` also configure the [updater](./updates.md) in main.
- Terminals themselves are not stored: their output and processes end with the app in M0 ([terminal](./terminal.md#terminals-and-projects)).
- Missing keys take their defaults, so adding a setting needs no migration.
- Reading is lenient where writing is strict: a value that does not validate takes its default and the rest of the file is kept, and unknown keys are ignored. Any invalid value, or a file that is not JSON, is logged and the file is first moved aside as `settings.corrupt-<timestamp>.json` (the rule [below](#reading-and-recovering)), so the user's file is kept before the cleaned one is written.
- A file whose `version` is newer than the app knows is read the same way but never written; changes in that run apply in memory only.
- **Restore the last session** uses the session id kept in `localStorage` with the other per-device view state. It opens that session once the settings and the session list are loaded, without waiting for git tools, whose `gh auth status` can take seconds on a slow network: launch to restored thread took 2.6 to 2.8 s when it waited and 1.8 s without (fake agent, production build, 2026-10-21).

## Window and app state

Main's two small files are written like the settings ([writing safely](#writing-safely)).

```ts
interface WindowStateFile {
  version: 1
  bounds: { x: number; y: number; width: number; height: number } // the restored bounds
  maximized: boolean
}

interface AppStateFile {
  version: 1
  lastRunVersion: string | null // the version that ran last, for the notice after an update
  dismissedUpdate: string | null // the version whose update notice was dismissed
}
```

- `window-state.json` is written 500 ms after the window moves, resizes, maximizes or restores, and when it closes; a minimized or full-screen window keeps its last normal state. While maximized, `bounds` are the restored size from `getNormalBounds`.
- On launch the saved position is used only while at least 100 × 20 px of the window's top 40 px, where the title bar is, lies on a display's work area; otherwise the window opens centred on the primary display. The size always fits the display it opens on and never goes below 960 × 600. An invalid `window-state.json` is ignored and the default size used.
- An invalid `app-state.json` is moved aside like the settings and starts empty.

## Composer drafts

- Unsent composer text is stored in `localStorage` under `draft:<sessionId>`, written 300 ms after the last keystroke and when you switch sessions. The [New session](./ui.md#new-session) screen keeps its text the same way under `draft:new`, until the session it starts exists; a first message that session cannot take yet moves to that session's draft.
- Sending a prompt or deleting the session removes the draft.
- A draft larger than 1 MB, or one whose write fails (for example on the storage quota), stays in memory until the app quits, and the failure is logged.

## Threads

OverBench keeps its own copy of every session's thread, the entries it shows, so a session opens from disk without starting its agent, and a long one opens at its latest page. The agent still holds the session's context and continues from it; the copy is only what the thread shows.

> Built so far: sessions store their threads as they change and open from them a page at a time, attaching to their agent only when used and letting it go when idle ([session model](./session-model.md#how-the-host-keeps-sessions); [M0 feedback, problem 54](../milestones/m0-feedback.md#54-opening-a-session-starts-its-agent-and-keeps-it-running)).

- **Engine**: one SQLite database for every session, `state/threads.db`, through Node.js's built-in `node:sqlite` (SQLite 3.53.4 in Electron 44, checked 2026-10-22), in WAL mode with `synchronous = NORMAL` and incremental auto-vacuum. No npm package: `better-sqlite3` would need a native build for each Electron version and platform.
- **Worker**: `node:sqlite` is synchronous, and the largest thread measured (11,262 entries, 20 MB of text) takes 270 ms to write whole and 105 ms to delete, so the database lives in a `worker_threads` thread of the agent host and never blocks the event loop that streams sessions. Main builds the worker with `?modulePath`, as it builds the host, and passes its path as `threadWorkerPath` in `host:init`: electron-vite builds the host's own bundle without its worker plugin. The host uses it through `ThreadStore` (`src/agent-host/threads/store.ts`), a promise API answered in the order asked. Every SQLite call is in `db.ts`, so a change to `node:sqlite`, which Node.js 24 still marks experimental (stability 1.1), touches one file.
- **Schema**:

  ```sql
  CREATE TABLE threads (
    session_id     TEXT PRIMARY KEY,  -- OverBench's session id
    agent_id       TEXT NOT NULL,
    acp_session_id TEXT NOT NULL,
    session_json   TEXT NOT NULL,     -- title, config, commands, usage, subagent
    next_pos       INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE entries (
    session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
    pos        INTEGER NOT NULL,      -- arrival order, from 0
    turn       INTEGER NOT NULL,      -- pos of the entry that opened the entry's turn
    entry_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    json       TEXT NOT NULL,         -- the ThreadEntry, large images replaced by blob refs
    PRIMARY KEY (session_id, pos)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX entries_by_id ON entries (session_id, entry_id);
  CREATE INDEX entries_by_kind ON entries (session_id, kind, pos);
  CREATE TABLE blobs (
    session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
    hash       TEXT NOT NULL,         -- sha256 of the bytes
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    PRIMARY KEY (session_id, hash)
  ) STRICT, WITHOUT ROWID;
  ```

- **Turns**: a turn opens at a prompt of the user's own (not one steered into a running turn) and at the entry after a `turn_end`, which also splits a subagent's thread, since it has no prompts. An entry's `turn` is the position of the entry that opened its turn, so a page that starts at a turn is one range of the primary key.
- **Pages**: a page reaches back at least 60 entries from its cursor, then on to the start of their turn, so the folding of a finished turn's work never sees half a turn; a turn longer than 500 entries is cut. The latest page is read below the end, each earlier one below the first position of the page after it, and `older` is null once a page starts the thread. A page also carries the latest plan when it lies before the page, for the plan above the composer. Measured on 2026-10-22 (Electron 44, macOS arm64, 40 other sessions in the file): 0.3 ms for the latest page of 137, 2,817 or 11,262 entries alike, about 110 KB each.
- **Images**: an image whose base64 data is longer than 32 KB is stored once per session as bytes in `blobs`, a quarter smaller than its base64, and the entry keeps `{ kind: 'image', mimeType, blob }` in its place. Reading puts the data back, for the entries of that page only.
- **Writing**: a write is one transaction of new and changed entries, with the session view when it changed. A changed entry keeps its position and a new one takes the position given; an entry stored at another position, or a position taken by another entry, fails the write with `conflict` and changes nothing, and the caller then writes the thread whole. Writing whole (`replace`), as after a replay from the agent, drops the session's rows and images first. Deleting a session deletes its rows and images by cascade and returns the space with `incremental_vacuum`.
- **When the host writes**: what changed is written at most 5 s after it changed, at once when a turn ends, after a replay, when a session closes and when the host shuts down ([checkpoints](./session-model.md#how-the-host-keeps-sessions)). So a crash loses at most the last 5 s of a running turn, which the thread then shows as cut off.
- **Reading**: every entry read must pass `isThreadEntry` (`src/shared/thread.ts`). A thread with an entry or a session view that does not parse reads as not stored, with an error in the host log, so the session falls back to its agent.
- **Recovering**: when SQLite reports the file damaged (`SQLITE_CORRUPT` or `SQLITE_NOTADB`), at opening or on any request, the file and its `-wal` and `-shm` are renamed together to `threads.db.corrupt-<timestamp>`, an empty database replaces them, and the host log says so as an error; the request that met the damage fails with `corrupt`. If the worker stops, every request in flight and after fails with `unavailable`, and the host log says why.
- **Versioning**: the schema version is SQLite's `user_version`, 1 for this schema. A newer schema gets a migration in `db.ts` from each older version. A database whose version is newer than the app understands is neither read nor written that run, as for the JSON files.
- **Quitting**: after the requests in flight, the worker folds the WAL into the file (`wal_checkpoint(TRUNCATE)`) and closes it; a worker that has not finished after 2 s is stopped.

## What is never stored

- The agents' own transcripts. OverBench's copy of a thread ([threads](#threads)) is what the thread shows; the agent keeps the context a session continues from.
- Credentials, API keys or tokens.
- The resolved environment.
- ACP traffic and diagnostics, which stay in memory until the user exports them.

## Writing safely

These rules are for the JSON files; SQLite writes the [thread database](#threads) in transactions of its own.

- Writes are debounced by 500 ms per file: the first change starts the window, and every change within it shares the one write that ends it, so a steady stream of changes still reaches disk twice a second. The data is serialized when the write happens, so it carries the latest state and a change costs nothing more than scheduling.
- Each write goes to `<file>.tmp`, is flushed with `fsync`, and is renamed over the original. A crash mid-write leaves the previous version intact. On Windows the rename is retried a few times on `EPERM`, `EACCES` and `EBUSY`, which a virus scanner or indexer holding the file causes. Writes to one file are serialized.
- Only the agent host writes its files, and the single-instance lock in main guarantees there is one host.
- On quit, pending writes are flushed before the host reports `host:stopped`.

## Reading and recovering

- Files are read once at host startup.
- A missing file means an empty state.
- A file that fails to parse or validate is renamed to `<file>.corrupt-<timestamp>.json` (for example `sessions.json.corrupt-2026-10-20T12-00-00-000Z.json`, with `:` and `.` replaced so the name is valid on Windows), the host starts from an empty state, and the UI shows a notice. Nothing is silently discarded. The host reports it as an `error` entry in its log, which reaches main as `host:log` and the diagnostics bundle.
- Validation is strict: a file with any malformed entry, or an `agentId` this version does not know, counts as corrupt as a whole, because a partial read would be silently discarding the rest.
- Index entries whose project folder no longer exists stay listed but are marked missing, so a temporarily unmounted drive does not erase history.

## Versioning

Every file has a `version` field. A newer format comes with a pure migration function from each older version, run at load time and covered by unit tests; a migrated file is written back in the new format. Migrations live next to the file's validator in `src/agent-host/storage.ts` (`PROJECTS_MIGRATIONS`, `SESSIONS_MIGRATIONS`), keyed by the version they upgrade from; version 1 is the first, so both are empty. A file with a version newer than the app understands is left untouched and treated as read-only for that run: the host starts from an empty state, logs a warning and saves nothing to that file, so downgrading never destroys data.
