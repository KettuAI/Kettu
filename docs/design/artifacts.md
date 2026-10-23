# Artifacts

> Status: Accepted · Core design in [architecture](../architecture.md#artifacts) · Issue [#11](https://github.com/overbench/overbench/issues/11), milestone v0.0.3 · Observed on 2026-10-22: claude-agent-acp 0.94.0, codex-acp 2.2.2, opencode 2.0.32, Electron 44.9.2 (Chromium 152); `@agentclientprotocol/sdk` 2.0.0 checked on 2026-10-23

This document holds the details of artifacts. What an artifact is, its model, its interface, the rules that always hold and the decisions behind them are the [core design](../architecture.md#artifacts), and are not repeated here.

In short: agents create and change artifacts through OverBench's MCP service; OverBench keeps every version on this machine, lists them on one page for the whole app, grouped by project and then by session, and shows each in a viewer that keeps the page away from the app and the machine. A **canvas** is an artifact whose HTML marks two or more pages; the viewer lays its pages out side by side on a surface that pans and zooms.

The product decisions behind this design were made on [issue #11](https://github.com/overbench/overbench/issues/11#issuecomment-6357688146) on 2026-10-22: local pages only (no hosted links), one app-wide page, and pages that may load scripts, styles and fonts from CDNs inside an isolated surface. Word, PowerPoint and PDF files are out of scope.

## Decisions

The core decisions are in the [core design](../architecture.md#artifacts). The maintainer also took each of these on 2026-10-23:

| Choice                                                       | Decided                                                                                      | Instead of                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [The surface](#the-surface)                                  | An `<iframe>` per page on an origin of its own, in its own process, inside the app's session | A `<webview>` or `WebContentsView` in a partition of its own, as the issue's wording asked; measured far costlier |
| [The canvas format](#the-canvas-format)                      | `data-page`, `data-page-size` and `data-page-group` attributes in the page's markup          | Other attribute names; a page list built at run time                                                              |
| [The network policy](#network-policy)                        | Scripts, styles, fonts and fetches from a fixed list of CDNs; nothing else leaves the page   | Any `https` host for scripts, styles, fonts and images                                                            |
| [Where a session opens an artifact](#opening-from-a-session) | The side panel, beside the thread, so a live edit shows while the agent works                | The whole main area, with **Back** to the session                                                                 |
| [The page layout](#artifacts-page)                           | Cards under each session's title                                                             | The session's title beside its cards; one row per artifact                                                        |
| [Downloads](#downloads)                                      | Allowed through the system's save dialog                                                     | Blocked                                                                                                           |

The surface keeps the isolation the issue asked of "its own partition" by other means, because a partition would cost the canvas its frame rate or its memory ([measurements](#the-surface)).

## The artifacts service

### Connecting

- **Where it runs.** The agent host serves the MCP server `overbench` with Node's `http` on `127.0.0.1`, on a port the system picks when the host starts, at `/mcp`. It answers in Streamable HTTP's plain JSON form: every tool call returns at once, so the service opens no event stream. It is built on the official MCP TypeScript SDK's server and transport (`@modelcontextprotocol/sdk`), a new dependency that waits for the maintainer's approval.
- **How a session gets it.** Every request that attaches a session to its agent, `session/new`, `session/load`, `session/resume` and `session/fork`, passes `mcpServers: [{ type: 'http', name: 'overbench', url, headers: [{ name: 'Authorization', value: 'Bearer <token>' }] }]` ([session lifecycle](./session-model.md#session-lifecycle)). An agent that does not advertise `mcpCapabilities.http` gets no service; all three advertise it ([agents](../architecture.md#agents)).
- **Tokens.** Each attach makes a token of 32 random bytes, in base64url, which the host maps to the session and its project. It ends when the session closes or is released or deleted, and when the host stops, so a restarted host hands out new ones as sessions attach again. A request without a known token gets HTTP 401.
- **One connection per session.** An agent process serves many sessions, each with its own token. The build checks, for each agent, that two sessions in two projects keep their own connection; an adapter that registers MCP servers by name for its whole process would mix the tokens, and then gets a name per session (`overbench-` and the first 4 hex characters of the session id).

### Tools

| Tool                       | Arguments                                                                                         | Result                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `create_artifact`          | `title`, `html`, `note?`                                                                          | `{ id, version: 1, pages }`                                           |
| `read_artifact`            | `id`, `version?`                                                                                  | `{ id, title, version, head, pages, updated_at, html }`               |
| `update_artifact`          | `id`, `base_version`, and `html`, or `edits: { old_text, new_text }[]`, or `title` alone; `note?` | `{ id, version, pages }`; a title alone makes no version              |
| `list_artifacts`           | `query?`, `limit?` (1 to 200, 50 by default)                                                      | `{ artifacts: { id, title, version, pages, updated_at, session }[] }` |
| `delete_artifact`          | `id`                                                                                              | `{ id, purge_at }`                                                    |
| `list_artifact_versions`   | `id`                                                                                              | `{ versions: { version, created_at, author, note, size }[] }`         |
| `restore_artifact_version` | `id`, `version`, `base_version`                                                                   | `{ id, version }`                                                     |

- **Schemas.** Each tool declares an input and an output JSON Schema; a result carries the structured value and one line of text that says what happened ("Created art_01J… version 1, a canvas of 5 pages").
- **Annotations.** `read_artifact`, `list_artifacts` and `list_artifact_versions` are marked read-only, `delete_artifact` destructive, so an agent's own permission settings can tell them apart.
- **Edits** apply in order; each `old_text` must occur exactly once in the HTML as the edits before it left it, or the update fails as a whole.
- **Lists** are newest first, without Recently deleted; `query` matches titles, case- and accent-insensitively. `session` and `author` are a session's title, or `"user"`.
- **Limits**: a title of 1 to 120 characters, a note of at most 200, HTML of at most 5 MiB of UTF-8, at most 50 edits, a request body of at most 6 MiB, and 60 writes a minute per session.

Errors come back as tool errors whose text says what to do next, with a `code` in the structured value:

| Code             | When                                            | Text, for example                                                                            |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `not_found`      | No such artifact in this session's project      | "No artifact art_01J… in this project. list_artifacts shows the ones you can use."           |
| `deleted`        | The artifact is in Recently deleted             | "art_01J… was deleted. The user can restore it in OverBench."                                |
| `conflict`       | `base_version` is not the latest                | "art_01J… is at version 5. Read it again and apply your change to version 5."                |
| `edit_not_found` | An `old_text` occurs nowhere, or more than once | "Edit 2: old_text occurs 3 times. Include more of the surrounding text."                     |
| `too_large`      | The HTML or the request is over its limit       | "The HTML is 6.2 MiB; an artifact holds at most 5 MiB. Move images to a CDN or shrink them." |
| `invalid`        | An argument does not fit its schema             | The schema's message                                                                         |
| `rate_limited`   | Over 60 writes in a minute                      | "Too many changes in a minute. Wait 20 s."                                                   |

### What agents are told

The service's `instructions`, which an agent reads when it connects, say when to use it and how to write a page; `create_artifact`'s description repeats the format, for agents that do not read instructions:

> OverBench shows artifacts to the user: HTML pages for them to look at, such as reports, slide decks, design options and prototypes. Use create_artifact for a page the user should see, not for files of the project you are working on. An artifact is one self-contained HTML file: inline its styles and scripts, or load them from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh, cdn.tailwindcss.com, fonts.googleapis.com and fonts.gstatic.com; nothing else loads, files beside it included. To change an artifact, read it, then call update_artifact with the version you read; if it changed since, read it again. For several pages in one file, such as design options or slides, put each page in its own element with a data-page attribute that names it and a data-page-size attribute that gives its size in CSS pixels, such as `<section data-page="Sign in · A" data-page-size="390x844">`, as children of `<body>` or of a `<div data-page-group="Group name">` child of `<body>`; each group becomes a row. Write the page elements in the markup, not from a script.

### The canvas format

A canvas is one HTML file that marks its pages in its markup:

```html
<body>
  <div data-page-group="Sign in">
    <section data-page="A · Dusk" data-page-size="390x844">…</section>
    <section data-page="B · Paper" data-page-size="390x844">…</section>
  </div>
  <div data-page-group="Dashboard">
    <section data-page="Light" data-page-size="1440x900">…</section>
    <section data-page="Dark" data-page-size="1440x900">…</section>
  </div>
</body>
```

- **A page** is an element with a `data-page` attribute that is a child of `<body>`, or a child of an element with `data-page-group` that is itself a child of `<body>`. Its value is the page's name; an empty one becomes "Page" and the page's number, such as "Page 3".
- **Its size** is `data-page-size`, the width and height in CSS pixels, each from 64 to 8,000. Without one, a page is 1280 × 800. The size is the page's viewport: its media queries and viewport units see that width and height, so a phone page renders as a phone page.
- **A group** is a row on the canvas, titled with the group's name. Pages outside a group, one after another, form a row without a title. A row wraps after six pages. Pages are 48 px apart, and rows 220 px, in canvas pixels.
- **Two or more pages** make the artifact a canvas. One page, or none, shows it as a single page.
- **Static markup only.** The marked elements must be in the HTML as written, not created by a script, since OverBench finds them without running the page. What the pages contain may be built by scripts.
- **Counted when written.** The service counts a version's pages when it is written, from its first 2 MiB, with a scan for `data-page` attributes on tags that skips scripts, styles and comments; the viewer parses the HTML properly when it opens ([viewer](#viewer)).
- Opened in a browser, the file shows its pages one under another, as written.

The format is OverBench's own; agents learn it from [what the service tells them](#what-agents-are-told).

## Storage and versions

### Store

The records live in the [thread database](./persistence.md#threads), written by its worker, one transaction per call:

```sql
CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,   -- 'art_' and a ULID
  project    TEXT NOT NULL,      -- the project's folder, or the session's scratch folder
  title      TEXT NOT NULL,
  head       INTEGER NOT NULL,   -- the latest version
  session_id TEXT NOT NULL,      -- the session that created it; kept after that session is deleted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER             -- in Recently deleted since; null otherwise
) STRICT;
CREATE INDEX artifacts_by_project ON artifacts (project, updated_at);

CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  n           INTEGER NOT NULL,
  hash        TEXT NOT NULL,     -- SHA-256 of the HTML, which names its file
  size        INTEGER NOT NULL,
  pages       INTEGER NOT NULL,
  author      TEXT,              -- a session id; null for the user
  note        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, n)
) STRICT, WITHOUT ROWID;
```

- **Each version's HTML** is a file in `artifacts/content/` under the data folder, in a folder named by the hash's first two hex characters, named by the hash with `.html`. The worker writes it to a temporary file, flushes it and renames it into place before its row commits, so a row never names a missing file; a file a crash left without a row, and a temporary file, are removed by the next purge. Since the worker also runs the purge, a purge never meets a file whose row is about to commit. The host reads the files itself, with `fs.promises`.
- **The page count** comes with the HTML from whoever writes the version: the service [counts it when written](#the-canvas-format), and a restore copies it from the version restored.
- **A new schema version** of the thread database creates both tables, empty; its migration changes nothing else.
- Moving a project folder leaves its artifacts under the old path, as its sessions are; they still list under it.

### Versions

- Numbering, authorship and the refusal of a stale `base_version` follow the [core rules](../architecture.md#artifacts). The user's own changes, a restore from the version history or an import, are authored by the user.
- **The title is not versioned**: renaming changes the artifact, not a version, and the history shows the versions under the current title. Nor does renaming change `updated_at`, which is the latest version's time.
- **Restoring** writes the restored version's hash as a new version, so its file is shared, not copied.
- The data folder's space is shown in Settings, with artifacts counted on their own, since every version is kept.

### Recently deleted

- **Deleting**, by an agent or the user, sets `deleted_at`. The artifact leaves the page and the lists; reading it gives `deleted`. The user can restore it, or delete it permanently at once. Deleting it again keeps the first time, so its 30 days do not start over.
- **In Recently deleted** the user still reads an artifact and its versions, and renames it; nobody makes a version of it until it is restored.
- **Deleting permanently** removes the artifact's rows and, at once, every file of its versions that no other version names.
- **The purge** runs when the host starts and every 24 hours: it removes the artifacts deleted more than 30 days ago, their versions by cascade, and then every content file no version names. It touches no file while the database is not open, as when a newer app wrote it, since it cannot tell which files are named, and in the content folder it removes nothing but version files and temporary files. A damaged database takes the content folder aside with it ([recovering](./persistence.md#threads)), so the purge never meets files whose records are gone; when the folder cannot be moved, the purge leaves it alone that run.

### Store API

The host's `ArtifactStore` (`src/agent-host/artifacts/store.ts`) is what the service, the interface's requests and main's protocol call; every call is one request to the thread worker. A call takes `project`, the session's project folder or its scratch folder, for a session's [reach](../architecture.md#artifacts): an artifact of another project is `not_found`, and one in Recently deleted is `deleted`, except that deleting it again returns when it went. A call without it is the user's and reaches every artifact.

| Call                                                              | Result                        | For                                                    |
| ----------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `create({ project, sessionId, title, html, pages, note })`        | `{ id, version: 1 }`          | `create_artifact`; authored by `sessionId`             |
| `read(id, { version?, project? })`                                | `{ artifact, version, html }` | `read_artifact`, `artifacts.read`                      |
| `write({ id, baseVersion, html, pages, author, note, project? })` | `{ version }`                 | `update_artifact`, after applying its edits            |
| `list({ project })`, or `list({ deleted? })` for the user         | `ArtifactSummary[]`           | `list_artifacts`, `artifacts.list`                     |
| `delete(id, { project? })`                                        | `{ deletedAt, purgeAt }`      | `delete_artifact`, `artifacts.delete`                  |
| `versions(id, { project? })`                                      | Version records, newest first | `list_artifact_versions`, `artifacts.versions`         |
| `restore({ id, version, baseVersion, author, note?, project? })`  | `{ version }`                 | `restore_artifact_version`, `artifacts.restoreVersion` |
| `rename(id, title, { project? })`                                 | none                          | `update_artifact` with a title, `artifacts.rename`     |
| `undelete(id)`, `erase(id)`                                       | none                          | The user only                                          |
| `content(id, version?)`                                           | `{ path, version }`           | `artifact.content`, for main                           |

- **Refusals** are `ArtifactError`s: `reason` is `not_found`, `deleted` or `conflict`, the service's codes of the same names, and `state` is `{ version, deleted }` for the last two, so a conflict names the latest version.
- **What the store does not check** is the service's: the limits on titles, notes and HTML, the rate limit, and counting a version's pages. A title alone in `update_artifact` is a `rename` and makes no version.

### Import and export

- **Import**, from the user only: main's open dialog takes one `.html` or `.htm` file of at most 5 MiB that decodes as UTF-8, and the host makes it an artifact in the project the user chose, version 1, authored by the user, titled by its `<title>` or else its file name. Files beside it do not come along, since an artifact is one file; a page that needs them loads them from the CDN list or inlines them.
- **Export** writes a version's HTML, as stored, where the save dialog says.
- **Open in browser** writes the version to `overbench-artifacts/<id>-v<n>.html` in the system's temporary folder and opens it with the default browser, outside OverBench's isolation; it is the user's explicit choice.

## Presence

- **Watching.** Every viewer or pane that shows an artifact watches it with `artifacts.watch`, which also brings its new versions for the live reload; the host counts the watches of each artifact.
- **Editing.** The host serves the tool calls itself, so it knows which session changed what: a session that created, updated or restored an artifact in its running turn is editing it until that turn ends.
- The host sends `artifacts.activity` with both whenever they change; the viewer and the cards show them ([interface](#interface)).

## Privacy

- **Local.** The records and the HTML stay in the data folder; OverBench uploads nothing and counts nothing about them.
- **What leaves**, and only by these roads: what an agent reads or writes through the service goes to its model with the rest of its context; a page loads scripts, styles and fonts from the CDN list, with `Referrer-Policy: no-referrer`; the user exports a version or opens it in the browser.
- **Diagnostics** carry the number of artifacts and versions and their total size, never a title or any HTML.
- **Deleting** keeps nothing past the purge: rows and files go together.
- **The service shows an agent nothing but artifacts**, and only those of its own project.

## Serving

Main serves artifacts through a custom protocol, never from `file://`, so each page sees only what OverBench gives it.

### The protocol

- **Scheme**: `overbench-artifact`, registered before the app is ready with `standard`, `secure`, `supportFetchAPI`, `stream` and `codeCache`, and none of `bypassCSP`, `corsEnabled` or `allowServiceWorkers`. A standard scheme gives each host its own origin and its own web storage.
- **One origin per artifact**: `overbench-artifact://<origin id>/`, where `<origin id>` is the first 26 hex characters of the SHA-256 of the artifact's id. It does not change with new versions, so a page's web storage survives an update and a restart, as it would in a browser; two artifacts never share an origin. Main serves only the artifacts opened in its current run and answers any other origin with 404.
- **What it serves**: `/` and `/index.html` are the latest version's HTML, and `?v=<n>` an earlier one; every other path is 404, since an artifact is one file, and so is a query that names a parameter twice. Main asks the host over its own channel for the version's file ([`artifact.content`](#ipc-and-host-protocol)), checks that it lies in `artifacts/content/`, and streams it with `fs.promises`. A version the host does not know is 404, a host that cannot answer is 503, and any method but `GET` is 405.
- **Headers** on every response: the [content security policy](#network-policy), a `Permissions-Policy` that turns every powerful feature off (camera, microphone, geolocation, display capture, USB, serial, HID, Bluetooth, MIDI, payment, clipboard, fullscreen), `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, with `Content-Type: text/html; charset=utf-8`.
- **One page alone**: `?page=<group>.<index>` serves the HTML with a style element added at the end of its head, or before `<body>` when it has none, that hides everything but that page and puts it at the top left with no body margin. `<group>` counts the body's `data-page-group` children from 1, or is 0 for the pages outside a group, and `<index>` counts the pages in it from 1. The numbers are checked integers; nothing else from the URL reaches the style.
- **Reloading**: a new version reaches the watching viewers as `artifacts.version`, and each reloads that artifact's frames. A canvas keeps its camera and a focused page stays focused. Nothing watches files.

### Network policy

The content security policy, sent as a header, so a page's own `<meta>` policy can only narrow it:

```text
default-src 'none';
script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: <CDNs>;
style-src 'self' 'unsafe-inline' <CDNs>;
font-src 'self' data: <CDNs>;
img-src 'self' data: blob: <CDNs>;
media-src 'self' data: blob:;
connect-src 'self' <CDNs>;
worker-src 'self' blob:;
frame-src 'self';
form-action 'none';
base-uri 'self'
```

`<CDNs>` is a fixed list in main: `https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net`, `https://unpkg.com`, `https://esm.sh`, `https://cdn.tailwindcss.com`, `https://fonts.googleapis.com` and `https://fonts.gstatic.com`. The service's [instructions](#what-agents-are-told) name the same list.

- **Inline scripts and `eval` are allowed**: the page is the agent's code to begin with, and in-browser JSX and utility-class compilers need both. The policy is there to keep data in, not to vet the page.
- **Nothing reaches another host.** No fetch, image, WebSocket or form goes anywhere but the artifact's own origin and the CDNs, so a page cannot send what it holds to a server. A remote image from any other host, such as a stock photo, does not load. Allowing any `https` host for scripts, styles, fonts and images was the alternative: more pages would work as written, and any host could then receive data in a URL.
- **Main enforces it a second time.** `webRequest.onBeforeRequest` cancels every request from an artifact frame that is not for its own origin, `data:`, `blob:` or a listed CDN over `https`, whatever the policy says.
- **Frames inside a page** load only from its own origin, so one artifact can never embed another, and `Cross-Origin-Resource-Policy` keeps one artifact from loading another's by any route.

## The surface

Each page is an `<iframe>` in the app's renderer, pointed at its artifact's origin:

```html
<iframe
  src="overbench-artifact://3f9a…/?page=1.2"
  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
  allow=""
  referrerpolicy="no-referrer"
></iframe>
```

- **Its own process.** The artifact's origin is a different site from the app's, so site isolation runs its frames in a renderer process of their own, sandboxed like the window's: in the prototype, the app's frame and an artifact's ran in different processes, both reported sandboxed. Every page of one artifact shares that one process.
- **No bridge.** The preload runs in the main frame only (`nodeIntegrationInSubFrames` stays off), so a page has no `window.overbench`, no `require` and no `process`, and the app never listens to `message` events from it: there is no channel from a page to the app.
- **`allow-same-origin` keeps the page on its own origin**, which is not the app's, so the page has web storage; the classic danger of that flag needs the page and its embedder to share an origin, which they never do. Without `allow-popups`, `allow-top-navigation` or `allow-modals`, a page cannot open windows, move the app's frame or block on `alert()`. `allow-downloads` lets a page offer a [download](#downloads).
- **The app's own policy** changes `frame-src 'none'` to `frame-src overbench-artifact:` in `src/renderer/index.html`, its only change, so the app can frame artifacts and nothing else; `object-src 'none'` stays. Main's [frame guard](#the-frame-guard) learns the same exception.
- **The page's theme** is its own. `prefers-color-scheme` inside the page follows the app's effective theme, so a page that supports both themes follows the app; OverBench injects no colors. A frame whose process stopped is replaced, never reloaded: Chromium gives a page reloaded into it the light scheme whatever the app's theme (Electron 44.9.2, 2026-10-23).

The options, measured in the prototype on a canvas of 24 pages of 1280 × 720, each drawing a chart with Chart.js from a CDN, on a 4.2 s scripted camera path (fit, zoom to 50% on the first page, pan to the last, fit) on a 120 Hz display; one fresh app per row, Electron 44.9.2 on macOS arm64, 2026-10-22:

| Surface                                                            | Open to loaded | Added processes | Added memory | Frames p50 / p95 / max | Focus a page |
| ------------------------------------------------------------------ | -------------- | --------------- | ------------ | ---------------------- | ------------ |
| **A** · An `<iframe>` per page, all 24 live (chosen)               | 1,014 ms       | 1               | 321 MB       | 8.3 / 13.4 / 48.6 ms   | 45 ms        |
| A, at most 8 live                                                  | 392 ms         | 1               | 241 MB       | 8.3 / 16.1 / 47.0 ms   | 37 ms        |
| **B** · One `<iframe>` with every page laid out by an added style  | 166 ms         | 1               | 172 MB       | 8.4 / 15.8 / 29.0 ms   | 45 ms        |
| **C** · A `<webview>` per page, in a partition of its own          | 1,632 ms       | 24              | 2,538 MB     | 8.4 / 12.6 / 41.3 ms   | 165 ms       |
| **D** · Captured images of the pages, a `WebContentsView` to focus | 15,064 ms      | 0               | 72 MB        | 8.3 / 9.8 / 18.1 ms    | 129 ms       |

- **A** is the choice: one process per artifact, pages live and correct at their own viewport size, and the canvas is ordinary DOM, so it pans and zooms with one transform and menus and dialogs draw over it.
- **B** is the cheapest, since the page's scripts run once, but every page then shares the whole canvas as its viewport: a phone page's media queries see a desktop-wide window and `100vh` is the canvas's height, so responsive pages render wrong.
- **C** gives each page its own partition, as the issue's wording asks, but a process per page: 24 processes and 2.5 GB for this canvas, and pages still blank two seconds after opening.
- **D** keeps pages in a partition of their own too, but a `WebContentsView` is a native layer over the window: it cannot be scaled or transformed, so the canvas shows still images, which took 15 s to capture for 24 pages, and the view hides every menu and dialog that opens over it.

Isolation does not need the partition: the origin, the process, the headers, main's request filter and handlers, and the absent bridge carry it, and the prototype's [probe](#security) held against every attempt. The partition stays where it costs nothing: [thumbnails](#thumbnails) render in offscreen windows in a partition of their own.

A, B and C put frames into the app's page (a `<webview>` is an out-of-process frame too), so each needs the [frame guard](#the-frame-guard)'s exception; D adds none. The prototype predates the guard, so its numbers do not include it.

## Security

What the page may do, and what keeps it there. OverBench treats every artifact as hostile code, since an agent may have written it from content it read on the web.

| A page tries to                                                       | What stops it                                                                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Reach the app's API or Node                                           | The preload runs in the main frame only; the page is in another process                                                                   |
| Read or change the app's DOM, or navigate the app                     | A cross-origin frame; `sandbox` without `allow-top-navigation`                                                                            |
| Read files on disk, or another artifact                               | Its origin serves its own HTML and nothing else; one origin per artifact; `Cross-Origin-Resource-Policy`                                  |
| Read the disk directly (`file://`) or the dev server                  | Chromium refuses `file:` from another scheme; the policy and main's request filter                                                        |
| Send data to a server                                                 | `connect-src`, `img-src` and the rest of the [policy](#network-policy), and main's request filter                                         |
| Call the artifacts service                                            | The service refuses requests that carry an `Origin`, and the page has no token                                                            |
| Open windows, or open a link in the browser by itself                 | No `allow-popups`; main's window-open handler opens nothing while a page has focus, and never an artifact's URL                           |
| Navigate itself to another site                                       | The app's `frame-src` and `will-frame-navigate` ([navigation](#navigation)); an `http(s)` address is offered in a bar ([viewer](#viewer)) |
| Use the camera, microphone, location, notifications, clipboard or USB | `Permissions-Policy`, an empty `allow`, and main's permission handlers, which deny every request and check from an artifact origin        |
| Register a service worker                                             | The scheme has no `allowServiceWorkers`                                                                                                   |
| Block the app with `alert()`                                          | No `allow-modals`: the call returns at once                                                                                               |
| Write files                                                           | Only through a [download](#downloads), which asks where                                                                                   |

- **Main's handlers** already grant nothing but the clipboard, and that only to the app's own page in its main frame ([security](../architecture.md#security)), so an artifact frame gets nothing without a new rule; the build's tests ask for every permission from an artifact origin, so a later change to the handlers cannot let one through. Where main compares origins, it builds one from a URL's scheme and host itself, because Node's `URL` reports a custom scheme's origin as `"null"`: the prototype's permission handler let a notification request through until it did.
- **Verified** in the prototype on 2026-10-22: a probe page made 27 attempts from inside the surface (the app's API and Node, files above its folder, dotfiles, encoded `..`, `file:`, another artifact's origin, the dev server, other hosts by fetch, image and WebSocket, the app's frame and DOM, `window.open`, notifications, the camera, location, the clipboard, `alert()`, service workers), and each one held; the artifact's frame ran in a sandboxed process of its own. The prototype served files from their folders; the store serves less, so the build runs the probe again against it, with the policy removed too, since the policy stopped the requests before main's filter saw them. The build's probe (`src/main/artifacts/isolation.process.test.ts`) makes 30 attempts, adding a beacon, a form, a script, a worker and a shared worker aimed at another host, and on 2026-10-23 each one held, with the policy and without it.
- **Keys** typed in a page go to the page, as in a browser, `Esc` included. Main sees them in `before-input-event` and, while a page has focus, passes the app's shortcuts of the [shortcut table](./ui.md#keyboard) on as `app:shortcut`, which the renderer runs as if typed in the app: on every platform those no menu item carries (`Ctrl+\``, `Mod+L`, `Mod+Shift+[`and`]`), and on Windows and Linux, where the renderer handles them all, the other `Mod` shortcuts too; on macOS the menu's accelerators take the rest. The probe checks that a shortcut typed in a page's frame reaches the app.

How it keeps the [security rules](../../AGENTS.md#security-rules): the window keeps `sandbox`, `contextIsolation` and no `nodeIntegration`; the preload gains typed methods only; main validates every argument of the new calls ([IPC](#ipc-and-host-protocol)); navigation and new windows stay blocked, and an external link opens only after the user's click and main's `http(s)` check; the app's policy frames `overbench-artifact:` where it framed nothing, and the frame guard accepts those frames alone, for the reasons above and below.

### Navigation

Chromium emits `will-frame-navigate` only for a navigation the parent's policy allows, so the app's `frame-src overbench-artifact:` refuses a page's move to any other scheme first, and leaves an error page in its frame:

- **Main reports a move to an `http(s)` address** from `did-start-navigation`: `artifact:blocked` names the page's origin and the address, and says whether the frame that tried was the page's own. The [viewer](#viewer) then loads the page again in that frame, so the page comes back, though its state is gone; a frame inside the page keeps its error page.
- **`will-frame-navigate` cancels the rest**: a move to another artifact's origin, and `about:blank` or `about:srcdoc` in the page's own frame, which would leave a document on no artifact's origin there. Frames inside the page may load `about:blank` and `about:srcdoc`, which take the page's origin.
- **An error page is no commit** for the [frame guard](#the-frame-guard): `did-frame-navigate` does not report one, so a refused navigation costs the window nothing.

### The service

What the artifacts service may be asked, and what keeps it to its job:

| Someone tries to                                             | What stops it                                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Reach it from another machine                                | It listens on `127.0.0.1` only                                                                                                                  |
| Call it from a web page, directly or by DNS rebinding        | Requests that carry an `Origin` header are refused; the `Host` header must be `127.0.0.1:<port>`; a call must be `POST` with `application/json` |
| Call it as another program on the machine                    | It needs a session's token, which exists only in the host and in the request that attached that session; tokens are compared in constant time   |
| Reach another project's artifacts, or anything but artifacts | The token names one session and its project; the seven tools are all the service has                                                            |
| Fill the disk                                                | The size limits and 60 writes a minute per session; Settings shows the space artifacts take                                                     |
| Lose another session's change                                | `base_version`: a write from a stale version is refused                                                                                         |

An artifact's HTML may carry instructions meant for the next agent that reads it, like any file an agent reads; `read_artifact` returns it as data, and what an agent does with what it reads is the agent's own concern.

### The frame guard

Since v0.0.2, main stops trusting a window whose page gains a frame: it refuses the page's IPC calls and permission requests and takes its host ports away until the main frame loads a new document ([security](../architecture.md#security)). A frame on the app's own origin could reach the page's `window.overbench`; an artifact's frame cannot, since it is on another origin, in another process. The guard keeps its rule for every other frame and learns one exception:

- **Main knows the origins it opened.** `artifact:open` registers an artifact's origin for the window that asked, before the renderer creates a frame for it, and `artifact:close` removes it; a window that opened an artifact twice keeps it until both close.
- **A new frame is pending until its first document commits.** Main sees a frame when it is created, before anything in it runs, but learns its origin only at the commit, and judges it by the frame's origin rather than its address. While a frame of the page is pending, main holds the page's IPC calls and answers its permission requests with a denial; the held calls run once every frame has resolved, or has been removed before it committed.
- **A frame whose first document commits on an origin main opened** is an artifact's frame, and the page keeps its access. Frames inside it are the artifact's own, kept on its origin by its [policy](#network-policy).
- **Anything else revokes the page's access, as today**: a first document on the app's origin, `about:srcdoc`, `blob:`, `data:` or an origin main did not open, a frame still in the page that has not committed within 5 s, and an artifact's frame that later commits on any other origin, which [navigation](#navigation) stops before it can.
- **Host ports** go straight to the hosts, so main cannot hold them: a frame that turns out not to be an artifact takes them away at its commit rather than at its creation, and in between its document can run only what the app's policy allows, no inline script and only the app's own files.
- The build tests the guard as a process test: the probe's frames, then a frame on the app's origin, `about:srcdoc`, an origin main did not open and a frame that never commits, each created while IPC calls are in flight; and it measures how long calls wait while a canvas of 24 pages opens: about 30 calls, 42 ms at the median and 102 ms at most (macOS arm64, 2026-10-23).

### Downloads

A page may offer a file to save, such as an exported image. With `allow-downloads`, a download from an artifact asks where to save it in the system's save dialog, and nothing lands on disk without the user's choice. Blocking downloads, by leaving `allow-downloads` out and cancelling each one in `will-download`, was the alternative.

## Thumbnails

- Main renders each card's thumbnail in an offscreen window (`offscreen: true`, sandboxed, no preload, audio muted) in the `overbench-artifact-thumbnails` partition, which has the same protocol, policy, request filter and handlers, at 1280 × 800 for a page; for a canvas, all its pages laid out and scaled to fit, on a transparent background so the card's surface shows between them. It waits for the load and 400 ms more, at most 5 s, captures the window, scales it to 720 px wide, enough for a card two across on a 2x display, and closes the window.
- Cards ask for their thumbnails as they scroll into view, one at a time, in that order. They are kept on disk in `artifacts/thumbnails/` under the data folder, named by the version's hash, PNG for a canvas and JPEG for a page, so a new version gets a new one; the folder is trimmed to the newest 500.
- Measured in the prototype: a card took the page's load (0.1 s, or 1.3 s for a page with web fonts) and the 400 ms wait; main's own work was 4 to 77 ms for the capture and 2 to 4 ms to encode; each thumbnail was 12 to 17 KB at 480 px wide. Live scaled frames as thumbnails cost 574 MB and 5 processes for 4 cards, so cards never hold a live page.

## Interface

The rules this follows are the [visual style](./visual-style.md) and the [UX guidelines](./ux-guidelines.md); [Interface](./ui.md#artifacts) points here. The [hi-fi canvas](https://claude.ai/artifact/WWbEoYtY9zcczsB6tzcQrx) of 2026-10-23 draws every part below, and the maintainer accepted it that day, the parts the service added included: the version history, Recently deleted, importing, presence and the thread's rows for the service.

### Artifacts page

```text
 Artifacts         ▤ Project and session ⌄  ⇅ Newest first ⌄  ⌕ Filter by title  ⇪
 9 artifacts from 4 sessions

 acme-web  5
 Explore onboarding directions  12 min ago
 ┌──────────────────────────┐ ┌──────────────────────────┐
 │ ▯ ▯ ▯                    │ │                          │
 │ ▭ ▭                      │ │                          │
 ├──────────────────────────┤ ├──────────────────────────┤
 │ Onboarding directions    │ │ Trips list               │
 │ v3 · Canvas, 5 pages     │ │ v1                       │
 └──────────────────────────┘ └──────────────────────────┘
```

- **Opening it**: the sidebar's **Artifacts** row (`Shapes`), which stays highlighted while the page shows ([sidebar](./ui.md#sidebar)). The page's code loads with dynamic `import()` the first time it opens.
- **Layout**: a centred column of at most 960 px on surface 1. The header holds the title, a line saying how many artifacts from how many sessions, and at its end the **Group by** and **Sort** buttons and a filter field that filters by title (`Mod+F` focuses it, `Esc` clears it), then **Import an HTML file** (`FileUp`), an icon button whose menu, headed "Import into", lists the projects in the sidebar's order and **No project**; picking one opens the system's open dialog ([import](#import-and-export)). In a narrower main area the filter narrows from 260 to 200 px first, then the two buttons show their icons alone, with the choice in their tooltips.
- **Groups**, by default (**Project and session**): each project is a group label with its count, in the sidebar's project order, then **No project**. Under it, each session, in the chosen sort: the session's title at weight 500 and how long ago it was updated, as a row that opens the session. An artifact shows under the session that made its latest version, or under the one that created it when the user made the latest. The row has no agent mark: the page sorts work by project and session, whichever agent wrote it. A project or session with nothing to show has no group.
- **Grouping and sorting**: **Group by** (`Rows3`) and **Sort** (`ArrowDownUp`) are quiet buttons that show the icon, the current choice and `ChevronDown`. Each opens a menu of radio items under its group label; picking one applies it and closes the menu. An open button keeps the `--accent` fill, as menu triggers do, and its accessible name says the choice ("Group by: Date"). The filter applies first, so groups and counts are of the matching artifacts. The choice is remembered per device in `localStorage` with the other view preferences ([persistence](./persistence.md#what-is-stored-and-where)), for the whole app rather than per project.
- **Group by**: **Project and session**, the default above; **Project**, one grid per project without session rows; **Date**, by the latest version's time in local time, as Today, Yesterday, Previous 7 days, Previous 30 days and Older; **None**, one grid without labels.
- **Sort**: **Newest first**, the default, **Oldest first**, **Name, A to Z** and **Name, Z to A**. Time is the latest version's; the name is the title. Names compare in the interface language's collation with numbers in numeric order, so "Slide 2" comes before "Slide 10". Session rows sort by their last update or their title the same way, and date groups follow the time order, newest first under a name sort; project groups keep the sidebar's order whatever the sort.
- **Cards**: a grid of cards at least 280 px wide with 16 px gaps, three across at 960 px and two in a narrower window, so a canvas's pages still read in its thumbnail. A card is one `rounded-xl` box on `--bg-surface` inside a hairline `--border-default` ring: the thumbnail on top, 16:10 on `--bg-subtle`, then, under a hairline `--border-subtle`, the title at weight 500 and, at the caption role, what the grouping hides and, for a canvas, "Canvas, 5 pages". What the grouping hides is the version, such as "v3", under **Project and session**, the session's title under **Project**, and the project's name under **Date** and **None**. A card has no shadow and does not rise: on hover its ring turns `--border-strong`. Its tooltip gives the project, the session, the version and when it was made.
- **Card states**: a `Skeleton` in the thumbnail's place while it renders; `ImageOff` over "No preview" in `--text-tertiary` on `--bg-subtle` when it could not render; while a session's running turn changes it ([presence](#presence)), a pill at the thumbnail's top left with a 12 px `Spinner` and "Editing" in `--text-secondary`, on `--bg-surface` inside a hairline ring.
- **A card's menu** (right click, `Shift+F10`, or **More**): **Open**, **Open in browser**, **Export…**, **Rename…**, **Version history**, then **Open the session**, then **Delete**, which moves it to Recently deleted and asks nothing, since it can be undone ([destructive actions](./ux-guidelines.md#destructive-actions)). **More** (`Ellipsis`) is a 28 px icon button at the end of the title and caption, shown while the card is hovered or focused and while its menu is open; it takes no Tab stop of its own, since `Shift+F10` opens the same menu.
- **Keyboard**: the cards are one Tab stop; the arrow keys move through them in reading order and `Enter` opens one.
- **States**: loading shows the header and a row of `Skeleton` cards at their real size; no artifacts shows one `Empty` (`Shapes`, "No artifacts yet", "Pages your agents make for you show here, by project and session. Ask an agent for a report, a deck or design options.") with **Import an HTML file…**, which opens the same "Import into" menu under it; a filter that matches nothing says "No matching artifacts" in the list's place; a failed read shows an `Alert` with **Retry**.
- **Recently deleted**: while it holds anything, the list ends, under a hairline `--border-subtle`, with a row of `Trash`, "Recently deleted" and its count. It opens the page's Recently deleted view: **Back**, the title, and "Deleted artifacts stay here for 30 days, then they and every version of them are removed for good."; then the cards, the latest deletion first, each captioned with its project and the days left ("acme-web · 29 days left"). A card opens the artifact in the viewer under a bar, "In Recently deleted · 29 days left" with **Restore**; its menu holds **Restore**, then **Delete permanently…**, which asks in an `AlertDialog`: "Delete “Traffic report, first draft” permanently?", "Its one version will be removed from this computer. This cannot be undone.", with **Cancel** and **Delete** in the `destructive` variant. With nothing in it, the view says "Nothing in Recently deleted".
- **Why cards under each session's title**: group labels introduce their content everywhere else in the app. The alternatives were the session's title in a 200 px column beside its cards, which wastes less height when sessions have one or two artifacts, and one 44 px row per artifact with a 56 px thumbnail, which fits the most.

### Viewer

Opening a card shows its artifact in the main area, in place of the page, with **Back** (`ArrowLeft`, `Esc` while nothing in the page has focus) to the list.

- **Top bar**: **Back**, the title at weight 500 and its version in `--text-secondary`; at the end, [presence](#presence) when there is any, then, for a canvas, the zoom as a stepper (`Minus`, the percentage in `tabular-nums`, `Plus`) and **Zoom to fit** (`Scan`); then **Reload** (`RefreshCw`) and **More** (`Ellipsis`), whose menu holds **Open in browser**, **Export…**, **Rename…**, **Version history**, **Open the session** and **Delete**.
- **A single page** fills the area below the top bar, at the area's size, so the page is laid out for the space it has and scrolls itself.
- **The frame appears when it has loaded**, fading in over `--duration-fast`, so a half-drawn page never shows; a CDN that never answers holds it back 3 s at most. A wait longer than 200 ms shows a `Spinner`.
- **A new version** reloads the frames in place ([reloading](#the-protocol)).
- **A blocked navigation** shows a bar over the top of the page: "This page tried to open example.com" with **Open in browser** and a dismiss button. Nothing opens without that click. When the page's own frame tried, the page loads again under the bar ([navigation](#navigation)).
- **Presence**: while a session's running turn changes the artifact, a quiet button with a 12 px `Spinner` and "Explore onboarding directions is editing" in `--text-secondary`, which opens that session with the artifact beside it; when the artifact is open in more than one place in OverBench, "Open in 2 places" in `--text-tertiary`. A hairline divides them from the zoom.
- **Version history**, from **More** or a card's menu, is a 300 px column on surface 0 at the viewer's right, under the top bar, headed "Version history" with a close button. Every version is a row, the newest first: "Version 3" at weight 500, "Latest" on the newest, its time, its note in `--text-secondary` and its author, a session's title or "You", in `--text-tertiary`. Picking a row shows that version and the top bar's version follows it; an earlier one shows under a bar, "Version 1 of 3 · 52 min ago · Three onboarding directions" with **Restore this version**, which writes it as the newest version, authored by the user ([versions](#versions)). Closing the column returns to the latest.
- **States**: an artifact deleted while it shows becomes `Empty` (`Trash`, "This artifact was deleted", "Explore onboarding directions deleted it just now. It stays in Recently deleted for 30 days.") with **Restore** and **Back**; a page whose process stopped shows "The page stopped" with **Reload**, which shows it in a new frame ([the surface](#the-surface)); main reports it as `artifact:stopped`, from a check of the page's frames once a second. An artifact that cannot be opened shows its error in `Empty` with **Retry**.
- **Open in browser** opens a copy of the version with the system's default browser, where OverBench's isolation no longer applies ([export](#import-and-export)); it is the user's explicit choice.

### Canvas

```text
 ← Onboarding directions  v3                    − 37% +  ⛶  ⟳  ⋯
 ┌─────────────────────────────────────────────────────────────────┐
 │ Sign in                                                         │
 │ A · Dusk  B · Paper  C · Night                                  │
 │ ┌──────┐ ┌──────┐ ┌──────┐                                      │
 │ │      │ │      │ │      │                                      │
 │ └──────┘ └──────┘ └──────┘                                      │
 │ Dashboard                                                       │
 │ Light                   Dark                                    │
 │ ┌──────────────────┐   ┌──────────────────┐                     │
 │ └──────────────────┘   └──────────────────┘                     │
 └─────────────────────────────────────────────────────────────────┘
```

- **The surface** is surface 0 (`--bg-sidebar`), so white pages stand off it in both themes. Each page is a frame at its own size with square corners, so the page's edge shows exactly, and a hairline `--border-default` ring; under the pointer the ring is `--border-strong`. A selected page's ring is 2 px of `--text-primary`, neutral like every selection ([color](./visual-style.md#color)).
- **Labels**: the page's name above it and the group's title above the row, at the caption role, the group's at weight 500 in `--text-primary`. They keep their screen size at every zoom: a page's name hides when the page is narrower than 56 px on screen, and a group's title when its row is narrower than 80 px. A row's labels make room for the row above it: when the gap between the two is under 44 px on screen, the row's page names hide and its group's title moves down to their place, and under 22 px the title hides too.
- **Opening** fits every page in view, never above 100%, and selects the first page.
- **In the overview pages are not interactive**: a pane over them takes the pointer, and their frames take no focus. Their scripts keep running, so animations show.

| Input                           | Does                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Scroll, two-finger swipe        | Pans                                                                                                         |
| Pinch, or `Mod` with the wheel  | Zooms at the pointer                                                                                         |
| Drag                            | Pans; there is nothing to select by dragging, so no `Space` is needed                                        |
| Click, double click             | Selects a page; focuses it                                                                                   |
| `←` `→`, `↑` `↓`                | Selects the next page in reading order, or the nearest page in the row above or below, and pans it into view |
| `Enter`                         | Focuses the selected page                                                                                    |
| `+` or `=`, `-`                 | Zooms in or out one step, around the middle of the view                                                      |
| `Shift+1`, `Shift+2`, `Shift+0` | Fits every page; fits the selected page; zooms to 100%                                                       |
| `Esc`                           | Leaves a focused page, then goes back to the list                                                            |

- The keys work while the canvas has focus, which is one Tab stop; they are the canvas's own and do not join the app's [shortcut table](./ui.md#keyboard). The zoom steps are 5, 10, 25, 50, 100, 200 and 400%, and zooming stops at 5% and 400%.
- **Motion**: the camera moves on its own only for a button or a key, over `--duration-base` with `--ease-out-quart`, interpolating the zoom on a log scale; under reduce motion it jumps. Scrolling, pinching and dragging follow the input directly and never animate.
- **Focusing a page** shows it alone in the area, live and interactive, fitted to the area and never above 100%. The top bar then holds the page's name, `ChevronLeft`, "3 / 5" in `tabular-nums`, `ChevronRight` and **Back to the canvas** (`Minimize2`) in place of the zoom. `←` and `→` move between pages while the page itself does not have focus, and `Esc` returns to the canvas with the camera as it was. A page loaded in 37 to 45 ms in the prototype.

Performance:

- **One transform**: the camera is one `translate` and `scale` on the layer that holds the pages, written in a `requestAnimationFrame` callback straight to the element, never through React state per frame; labels move in the same frame.
- **Crisp after moving**: the layer has `will-change: transform` only while the camera moves, and loses it 160 ms after it stops, so Chromium draws the pages again at the new scale.
- **Live pages are capped**: pages within one and a half views of the visible area stay loaded, nearest first, up to 48; the others unload and show their name on `--bg-subtle`. At most two pages load per frame. A page costs about 5 MB beyond the artifact's process (241 MB with 8 live, 321 MB with 24).
- **Measured** in the prototype ([the surface](#the-surface)): frames took 8.3 ms at the median and 13.4 ms at the 95th percentile on a 120 Hz display while the camera crossed 24 live pages, with 18 frames of 455 over 14 ms. Chromium logged "tile memory limits exceeded" while the camera zoomed out over many pages, with every surface; the build measures it with the [performance script](./testing.md) and resolves it before the canvas ships.

### Opening from a session

- The host links a thread's tool call to the service call behind it: the service records each write with its session and time, and the tool call of that session that names the same tool, while it runs, carries the artifact's id from then on; the build checks how each adapter names MCP tool calls.
- **The row** of a call to the service reads as the work it did, not as a generic tool: `Shapes`, the verb ("Created artifact", "Updated artifact", "Restored version"), the artifact's title in `--text-primary` in place of a path, and its version ("v2") as the summary on the right. A call to `delete_artifact` reads "Deleted artifact" with `Trash`; the calls that only read are rows of the `read` kind with the title, such as "Read artifact Onboarding directions".
- A tool call to `create_artifact`, `update_artifact` or `restore_artifact_version` gets **Open** (`Shapes`) at the end of its row, before the status, shown on hover and focus ([tool calls](./ui.md#tool-calls)). While its artifact is open in the side panel, the button stays shown and [pressed](./design-system.md#toggle-buttons) (`aria-pressed`), so the thread shows which call's artifact is beside it; pressing it again closes the pane, as the pane toggles do. A canvas opens fitted.
- **It opens in the side panel**, as a pane beside the [Files](./ui.md#files) and [terminal](./ui.md#terminal) panes, so the page reloads in view while the agent keeps changing it. The pane's header holds the title, **Reload**, **More**, **Maximize** and **Close**, as the other panes' headers do; it opens at 560 px and keeps its width; it has no toggle in the top bar, since it opens from the thread, and a card's **Open the session** opens the session with the artifact beside it.
- **A canvas in the pane** pans, zooms and takes its keys as in the main area. A focused page puts its name, `ChevronLeft`, the counter, `ChevronRight` and **Back to the canvas** in the pane's header, before **Reload**; `Esc` leaves the focused page and never closes the pane.
- Opening the full viewer in the main area, with **Back** to the session, was the alternative: it adds no pane, but the thread is out of sight while the page shows.

## IPC and host protocol

Agent host requests and events ([host protocol](./host-protocol.md)), for the interface; agents use the [service](#tools) instead:

| Method or event               | Params                            | Result or payload          | Notes                                                                            |
| ----------------------------- | --------------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `artifacts.list`              | `{ deleted? }`                    | `ArtifactSummary[]`        | Every artifact, or those in Recently deleted                                     |
| `artifacts.read`              | `{ id, version? }`                | `{ title, version, html }` | For the viewer to find a canvas's pages                                          |
| `artifacts.versions`          | `{ id }`                          | `VersionSummary[]`         | Newest first                                                                     |
| `artifacts.rename`            | `{ id, title }`                   | none                       | The title's limits as in the service                                             |
| `artifacts.delete`            | `{ id, permanently? }`            | none                       | Permanently only from Recently deleted                                           |
| `artifacts.undelete`          | `{ id }`                          | none                       | Back from Recently deleted                                                       |
| `artifacts.restoreVersion`    | `{ id, version, baseVersion }`    | `{ version }`              | Authored by the user; refused as `conflict` when `baseVersion` is not the latest |
| `artifacts.watch` / `unwatch` | `{ id }`                          | none                       | Counts as a viewer; brings `artifacts.version`                                   |
| `artifacts.changed`           | event                             | none                       | The list changed                                                                 |
| `artifacts.version`           | event: `{ id, version }`          |                            | To the ports that watch it                                                       |
| `artifacts.activity`          | event: `{ id, viewers, editing }` |                            | `editing` holds the session ids changing it now                                  |

```ts
interface ArtifactSummary {
  id: string
  title: string
  project: string // the project's folder, or a scratch folder for No project
  sessionId: string // the session it shows under
  version: number // the latest
  pages: number // two or more is a canvas
  size: number
  updatedAt: number
  deletedAt: number | null
  editing: string[] // session ids
}

interface VersionSummary {
  version: number
  createdAt: number
  author: string | null // a session id; null for the user
  note: string | null
  size: number
}

interface ArtifactState {
  version: number // the latest
  deleted: boolean // in Recently deleted
}
```

- **Validation**: an `id` must be of the `art_` and ULID form, `version` and `baseVersion` whole numbers from 1, and a title 1 to 120 characters and not blank; anything else is `invalid_params`.
- **Refusals**: an id or version the host does not know is `not_found`. A request the artifact's state does not allow is `conflict`, with that `ArtifactState` as the error's data: a `baseVersion` that is not the latest, a restore while the artifact is in Recently deleted, or deleting permanently one that is not there.
- **Viewers** are counted per watch, so one window that shows an artifact in two places counts two; a port that closes takes its watches with it. `artifacts.activity` goes to the watching ports whenever the count changes.

The viewer parses the HTML with the renderer's `DOMParser`, which builds an inert document that runs no script and loads nothing, and takes the pages from it by the [format's rules](#the-canvas-format).

Renderer and main ([adding an IPC call](../../AGENTS.md#adding-an-ipc-call)):

| Channel                  | Arguments                        | Result                 | Main checks                                                                                                             |
| ------------------------ | -------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `artifact:open`          | `id`                             | `{ url }`              | An id of the `art_` form that the host knows; registers its origin for the window ([the protocol](#the-protocol))       |
| `artifact:close`         | `url`                            | none                   | A string of at most 2,048 characters; removes the window's registration from the [frame guard](#the-frame-guard)        |
| `artifact:thumbnail`     | `id`, `version`, `layout?`       | A `data:` URL, or null | As `artifact:open`; a canvas layout is a list of at most 500 pages of checked integers                                  |
| `artifact:open-external` | `id`, `version`                  | none                   | As `artifact:open`; writes the temporary copy and opens it in the default browser                                       |
| `artifact:export`        | `id`, `version`                  | `boolean`              | As `artifact:open`; shows the save dialog                                                                               |
| `artifact:import`        | `project`                        | `{ id }`, or null      | A project the host knows; shows the open dialog and hands the chosen path to the host itself                            |
| `artifact:blocked`       | event: `{ origin, url, reload }` | —                      | Sent when a page tried to leave for an `http(s)` address; `reload` when its own frame tried ([navigation](#navigation)) |
| `artifact:stopped`       | event: `{ origin }`              | —                      | The process of a page's frame ended                                                                                     |
| `app:shortcut`           | event: the key                   | —                      | An app shortcut typed while a page had focus ([keys](#security))                                                        |

Main and the agent host: `artifact.content`, sent as `host:artifact-content-request` with `{ requestId, id, version }` and answered by `host:artifact-content`, returns the version's file path in `artifacts/content/` and its number, the latest when `version` is null, for the protocol and the copies; the host answers `not_found` for an artifact or version it does not know, and main gives up after 10 s. `artifact.import` with `{ path, project }` makes an artifact from a file the user chose in main's dialog, so the renderer never names a path to import.

## Building it

The design is larger than one pull request, so the build splits into sub-issues of #11, each one pull request; the later ones wait on the ones they name:

1. **The store**: the new schema version, the content files, versions and their rules, Recently deleted and the purge, and the host's requests and events for the interface ([IPC](#ipc-and-host-protocol)); unit tests over versions, conflicts, the scope and the purge.
2. **The service**, after 1: the MCP server and its tokens, `mcpServers` on every attach, the seven tools with their errors and limits, and what agents are told; unit tests over every tool and limit, and a process test per agent that creates, updates and reads an artifact from two sessions in two projects.
3. **The surface**, after 1: the protocol from the store, the policy, main's request filter, handlers and navigation guard, the frame guard's exception, the single-page viewer, and the probe as a process test, run once more with the policy removed.
4. **The Artifacts page**, after 3: the cards, grouping and sorting, the filter, thumbnails, the page's states, and the sidebar row turned on; the [UX guidelines](./ux-guidelines.md#structure) then lose the disabled row as their example of a feature shown before it is built.
5. **Managing artifacts**, after 4: rename, delete, Recently deleted with the permanent delete, import, export and open in browser, and with them the viewer's **More** menu and its deleted state.
6. **The canvas and the version history**, after 4: the canvas viewer, focusing a page, and the history column with restoring.
7. **Opening from a session and presence**, after 2 and 3: the thread's rows for the service with **Open**, the side panel pane, and presence on cards and in the viewer.

## Alternatives considered

- **Finding the HTML files in the agents' edit tool calls**, the design before 2026-10-23: it needs nothing from the agents, but has no versions, lists project files such as a web app's `index.html` beside the pages meant for the user, and misses pages a shell command writes.
- **A stdio MCP server that the agent starts**: each session would need a bridge process that calls back into OverBench; the HTTP service needs none, and all three agents take it.
- **Pages named by a manifest or by one file per page**: one file per canvas was decided, and a manifest is a second file to keep in step.
- **Finding pages without markers**, from sections of a fixed size or a slide deck's script: fragile, and a deck's script shows one slide at a time.
- **Finding pages by running the file**, so script-built pages count: it needs a script in every page that reports to the app, which is the channel this design keeps closed. It can come later as a probe whose messages carry only numbers and names, if agents' canvases need it.
- **Serving from `file://`**: the page could then read any file the browser engine lets a local page read, and every artifact would share one origin.
- **`registerSource`** for the protocol: it cannot add headers.
- **Opening artifacts in the system browser only**: no canvas, no reload as the agent changes it, and the browser's `file://` rules instead of OverBench's.

## Prototype

A prototype in Electron 44.9.2, outside the repository, built for this design on 2026-10-22: the Artifacts page in its three layouts and both themes, the viewer, the canvas with all four surfaces switchable, thumbnails, live reload and the isolation probe. The numbers in this document come from it. It found its pages in files, before the service; the surface, canvas and thumbnail numbers do not depend on where the HTML comes from.
