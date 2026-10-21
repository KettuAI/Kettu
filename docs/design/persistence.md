# Persistence

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.4](../milestones/m0.md#work-packages)

OverBench stores as little as it can. Agents already keep transcripts and credentials, so OverBench keeps only what it needs to put its own UI back together.

## What is stored, and where

All files live in `app.getPath('userData')` ([per platform](./agent-host.md#platform-differences)).

| File                  | Owner      | Contents                                                                                                                                           |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/projects.json` | Agent host | Recent project folders                                                                                                                             |
| `state/sessions.json` | Agent host | The session index                                                                                                                                  |
| `settings.json`       | Main       | [Settings](#settings)                                                                                                                              |
| `window-state.json`   | Main       | Window size, position and maximized state                                                                                                          |
| `app-state.json`      | Main       | The last version that ran and the dismissed update notice ([updates](./updates.md#storage))                                                        |
| `localStorage`        | Renderer   | Per-device view preferences, such as panel sizes, collapsed groups and whether the terminal panel is open, and [composer drafts](#composer-drafts) |

```ts
interface ProjectsFile {
  version: 1
  projects: { path: string; name: string; addedAt: number; lastOpenedAt: number }[]
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
    defaultAgent: AgentId | null // null: pick one on the project home each time
    sendKey: 'enter' | 'mod-enter' // the other key inserts a newline
    restoreLastSession: boolean
    confirmQuitWhileRunning: boolean
  }
  appearance: {
    theme: 'system' | 'light' | 'dark'
    textSize: 'small' | 'default' | 'large' // thread prose and the composer: 13, 14 or 15 px
    reduceMotion: 'system' | 'always'
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

- Defaults: no default agent, Enter sends, restore and confirm on, the system theme, the default text size, reduce motion following the system, every notification on except sound, the badge on, no binary overrides, the proxy from the environment, the default shell at 13 px, no background fetch, and updates downloaded and installed automatically.
- The renderer reads them with `settings:get` and changes them with `settings:update`, which takes a partial object (`SettingsPatch`). Main validates it against the schema (`src/main/settings-schema.ts`), rejects unknown keys and values, writes the file and sends `settings:changed` to every window. A patch with any problem is rejected whole, with an error naming each bad key, and changes nothing. Sections merge key by key; `proxy` is replaced whole, and a custom proxy URL must be an `http`, `https` or `socks` URL with a host.
- Executable paths, `agents.<id>.binaryPath` and `terminal.shellPath`, can only be cleared from the renderer, with `null`. Setting one goes through `dialog:choose-agent-binary` or `dialog:choose-shell`, which show a native file dialog in main and store the picked program.
- The renderer applies appearance settings as attributes on `<html>` (`data-theme`, `data-text-size`, `data-reduce-motion`), so tokens switch in CSS without re-rendering components.
- `agents`, `proxy` and `git` go to the agent host in `host:init` and `host:settings` ([agent host](./agent-host.md#main-and-host-messages)); `terminal` goes to the terminal host when it starts and when it changes. `updates` and `proxy` also configure the [updater](./updates.md) in main.
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

- Unsent composer text is stored in `localStorage` under `draft:<sessionId>`, written 300 ms after the last keystroke and when you switch sessions.
- Sending a prompt or deleting the session removes the draft.
- A draft larger than 1 MB, or one whose write fails (for example on the storage quota), stays in memory until the app quits, and the failure is logged.

## What is never stored

- Transcripts. They come back from the agent through `session/load`.
- Credentials, API keys or tokens.
- The resolved environment.
- ACP traffic and diagnostics, which stay in memory until the user exports them.

## Writing safely

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
