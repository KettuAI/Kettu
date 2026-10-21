# Persistence

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.4](../milestones/m0.md#work-packages)

OverBench stores as little as it can. Agents already keep transcripts and credentials, so OverBench keeps only what it needs to put its own UI back together.

## What is stored, and where

All files live in `app.getPath('userData')` ([per platform](./agent-host.md#platform-differences)).

| File                  | Owner      | Contents                                                                                                       |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `state/projects.json` | Agent host | Recent project folders                                                                                         |
| `state/sessions.json` | Agent host | The session index                                                                                              |
| `settings.json`       | Main       | [Settings](#settings)                                                                                          |
| `window-state.json`   | Main       | Window size, position and maximized state                                                                      |
| `localStorage`        | Renderer   | Per-device view preferences, such as panel sizes and collapsed groups, and [composer drafts](#composer-drafts) |

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
  }[]
}
```

- `name` defaults to the folder name.
- `lastViewedAt` decides the `unread` attention state after a restart.

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
}
```

- Defaults: no default agent, Enter sends, restore and confirm on, the system theme, the default text size, reduce motion following the system, every notification on except sound, the badge on, no binary overrides, and the proxy from the environment.
- The renderer reads them with `settings:get` and changes them with `settings:update`, which takes a partial object. Main validates it against the schema, rejects unknown keys and values, writes the file and sends `settings:changed` to every window.
- The renderer applies appearance settings as attributes on `<html>` (`data-theme`, `data-text-size`, `data-reduce-motion`), so tokens switch in CSS without re-rendering components.
- `agents` and `proxy` go to the agent host in `host:init` and `host:settings` ([agent host](./agent-host.md#main-and-host-messages)).
- Missing keys take their defaults, so adding a setting needs no migration.
- **Restore the last session** uses the session id kept in `localStorage` with the other per-device view state.

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

- Writes are debounced by 500 ms per file.
- Each write goes to `<file>.tmp`, is flushed with `fsync`, and is renamed over the original. A crash mid-write leaves the previous version intact.
- Only the agent host writes its files, and the single-instance lock in main guarantees there is one host.
- On quit, pending writes are flushed before the host reports `host:stopped`.

## Reading and recovering

- Files are read once at host startup.
- A missing file means an empty state.
- A file that fails to parse or validate is renamed to `<file>.corrupt-<timestamp>.json`, the host starts from an empty state, and the UI shows a notice. Nothing is silently discarded.
- Index entries whose project folder no longer exists stay listed but are marked missing, so a temporarily unmounted drive does not erase history.

## Versioning

Every file has a `version` field. A newer format comes with a pure migration function from each older version, run at load time and covered by unit tests. A file with a version newer than the app understands is left untouched and treated as read-only for that run, so downgrading never destroys data.
