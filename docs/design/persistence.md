# Persistence

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.4](../milestones/m0.md#work-packages)

OverBench stores as little as it can. Agents already keep transcripts and credentials, so OverBench keeps only what it needs to put its own UI back together.

## What is stored, and where

All files live in `app.getPath('userData')` ([per platform](./agent-host.md#platform-differences)).

| File                  | Owner      | Contents                                                              |
| --------------------- | ---------- | --------------------------------------------------------------------- |
| `state/projects.json` | Agent host | Recent project folders                                                |
| `state/sessions.json` | Agent host | The session index                                                     |
| `settings.json`       | Agent host | Agent binary overrides                                                |
| `window-state.json`   | Main       | Window size, position and maximized state                             |
| `localStorage`        | Renderer   | Per-device view preferences, such as panel sizes and collapsed groups |

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
  }[]
}

interface SettingsFile {
  version: 1
  agents: Partial<Record<AgentId, { binaryPath?: string }>>
}
```

- `name` defaults to the folder name.
- `lastViewedAt` decides the `unread` attention state after a restart.

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
