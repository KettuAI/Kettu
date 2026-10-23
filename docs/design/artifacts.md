# Artifacts

> Status: Accepted · Part of the [architecture](../architecture.md) · Issue [#11](https://github.com/overbench/overbench/issues/11), milestone v0.0.3 · Observed on 2026-10-22: claude-agent-acp 0.94.0, codex-acp 2.2.2, opencode 2.0.32, Electron 44.9.2 (Chromium 152)

Agents often answer with a page instead of a paragraph: a report, a slide deck, a set of design directions. An **artifact** is an HTML file an agent wrote or edited in a session. OverBench finds them in the sessions' threads, lists them on one page for the whole app, grouped by project and then by session, and shows each in a viewer that keeps the page away from the app and the machine. A **canvas** is an artifact whose file marks two or more pages; the viewer lays its pages out side by side on a surface that pans and zooms.

The product decisions behind this design were made on [issue #11](https://github.com/overbench/overbench/issues/11#issuecomment-6357688146) on 2026-10-22: local HTML files only (no hosted links), one app-wide page, and pages that may load scripts, styles and fonts from CDNs inside an isolated surface. Word, PowerPoint and PDF files are out of scope.

## Decisions

The maintainer took each of these on 2026-10-23:

| Choice                                                       | Decided                                                                                      | Instead of                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [The surface](#the-surface)                                  | An `<iframe>` per page on an origin of its own, in its own process, inside the app's session | A `<webview>` or `WebContentsView` in a partition of its own, as the issue's wording asked; measured far costlier |
| [The canvas format](#canvas)                                 | `data-page`, `data-page-size` and `data-page-group` attributes in the page's markup          | Other attribute names; a page list built at run time                                                              |
| [The network policy](#network-policy)                        | Scripts, styles, fonts and fetches from a fixed list of CDNs; nothing else leaves the page   | Any `https` host for scripts, styles, fonts and images                                                            |
| [Where a session opens an artifact](#opening-from-a-session) | The side panel, beside the thread, so a live edit shows while the agent works                | The whole main area, with **Back** to the session                                                                 |
| [The page layout](#artifacts-page)                           | Cards under each session's title                                                             | The session's title beside its cards; one row per file                                                            |
| [Downloads](#downloads)                                      | Allowed through the system's save dialog                                                     | Blocked                                                                                                           |

The surface keeps the isolation the issue asked of "its own partition" by other means, because a partition would cost the canvas its frame rate or its memory ([measurements](#the-surface)).

## Artifacts

### What counts

An entry of a session's thread makes its files artifacts when all of these hold:

- it is a [tool entry](./session-model.md#thread-entries) with `status: 'completed'` and `toolKind` `edit` or `move`;
- a path in its `locations`, or the `path` of a `diff` in its `content`, ends in `.html` or `.htm`, in any case.

A relative path is resolved against the session's folder. A read, a search or a failed edit makes nothing an artifact, and neither does a file the user writes; the [Files](./ui.md#files) pane shows those.

How each agent reports a written file, read in the adapters' sources:

| Agent                                     | Tools                                      | Where the path is                                                                                                                              |
| ----------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code (claude-agent-acp 0.94.0)     | `Write`, `Edit`, as `edit`                 | `locations`, the tool's absolute `file_path`, live and in a `session/load` replay; the diff's `path` too                                       |
| Codex (codex-acp 2.2.2)                   | File changes from `apply_patch`, as `edit` | The diff's `path` only; `locations` appear on a permission request alone. A change over 1 MiB carries no diff and so no path, and is not found |
| OpenCode (2.0.32, `packages/cli/src/acp`) | `write`, `edit` and `patch`, as `edit`     | `locations`, made absolute against the session's folder, live and replayed; a patch that moves a file lists both the old and the new path      |

Not found, for every agent: files written by a shell command (`execute` tool calls do not name the files a command writes), and pages a script builds from another file at run time. The design accepts both gaps rather than guess from command lines.

### Lifetime

- **One card per file.** A file several sessions wrote is listed once, under the most recently updated of them; its tooltip names the others. A subagent's writes count for the session that started it, and a fork's copied thread makes the fork one of the writers.
- **Always the latest.** The card and the viewer show the file as it is on disk now, whoever changed it last. There are no versions: the thread's diffs are the history.
- **Deleted or moved.** The index keeps what the agents wrote; whether the file is there is checked each time the list is read. A file no longer at its path stays in its session's group as **Missing**, after the others, with a file icon in place of the thumbnail, and opens nothing. Deleting the session removes it from the list.
- **Outside the project.** A file an agent wrote outside the session's folder, such as in a temporary folder, is listed under the session like any other, with its full path as its folder. It opens without access to the files beside it ([serving](#serving)).
- **Sessions without a project** list their artifacts under **No project**, as the sidebar does; their [scratch folder](./session-model.md#sessions-without-a-project) counts as their project.

### Canvas

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
- **Two or more pages** make the file a canvas. One page, or none, shows the file as a single page.
- **Static markup only.** The marked elements must be in the HTML as written, not created by a script, since OverBench finds them without running the page. What the pages contain may be built by scripts.
- Opened in a browser, the file shows its pages one under another, as written.

The format is OverBench's own, so an agent learns it from the user. The [empty page](#artifacts-page) and the viewer's menu offer **Copy the canvas format**, which copies this text, in the interface language, for a prompt or an instructions file:

> Write the canvas as one HTML file. Put each page in its own element with a `data-page` attribute that names it and a `data-page-size` attribute that gives its size in CSS pixels, such as `<section data-page="Sign in · A" data-page-size="390x844">`. Make the pages children of `<body>`, or group them in children of `<body>` that carry `data-page-group="Group name"`; each group becomes a row. Write the page elements in the markup, not from a script.

### Index

The artifacts are indexed in the [thread database](./persistence.md#threads), in a table the thread worker keeps in step with the entries:

```sql
CREATE TABLE artifacts (
  session_id TEXT NOT NULL REFERENCES threads (session_id) ON DELETE CASCADE,
  path       TEXT NOT NULL,     -- absolute, as resolved against the session's folder
  pos        INTEGER NOT NULL,  -- the position of the latest entry that wrote it
  PRIMARY KEY (session_id, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX artifacts_by_path ON artifacts (path);
```

- **Written with the entries.** Each write the worker runs adds or updates the rows for the tool entries it writes, in the same transaction, so the index never disagrees with the stored thread. Writing a thread whole, as after a replay, rewrites its rows; deleting a session deletes them by cascade.
- **Every source alike.** A live session, a `session/load` replay, an imported session and a fork all reach the index the same way, through the entries the host stores, so the agents' differences end at the [rules above](#what-counts).
- **Schema version 2.** The migration from version 1 creates the table and fills it from the stored tool entries once, in the worker.
- **Why a table.** Finding the files on the fly with SQLite's JSON functions over every tool entry took 380 ms warm and 2.8 s cold on a database of 300 sessions and 450,000 entries (1.6 GB); reading the table took 0.3 ms (synthetic data, `node:sqlite`, 2026-10-22). A live thread reaches the table when it is stored: within 5 s, and at once when a turn ends.

### Listing

- `artifacts.list` returns every artifact with the session it shows under, the other sessions that wrote it, whether the file exists, its size and modification time, and how many page markers it has. The host reads that last from the file's first 2 MiB with a scan for `data-page` attributes on tags, skipping scripts, styles and comments; the viewer parses the file properly when it opens ([viewer](#viewer)).
- The host sends `artifacts.changed` after a write that changed the table; the page lists again. Checking the files runs in the host, off the event loop, one `stat` each.

## Serving

Artifacts are served by main through a custom protocol, never from `file://`, so each page sees only what OverBench gives it.

### The protocol

- **Scheme**: `overbench-artifact`, registered before the app is ready with `standard`, `secure`, `supportFetchAPI`, `stream` and `codeCache`, and none of `bypassCSP`, `corsEnabled` or `allowServiceWorkers`. A standard scheme gives each host its own origin, its own web storage and relative URLs that resolve.
- **One origin per artifact**: `overbench-artifact://<id>/<file name>`, where `<id>` is the first 26 hex characters of the SHA-256 of the file's canonical path. The id is stable, so a page's web storage survives a restart as it would in a browser; two artifacts never share an origin, even in one folder. Main serves only the artifacts opened in its current run and answers any other id with 404.
- **Its folder**: the artifact's origin serves the folder the file is in and the folders below it, when that folder is inside one of the project and scratch folders the agent host relays to main (`host:projects`). Otherwise the origin serves the file alone, so a page an agent left in a home or downloads folder cannot read what lies beside it. A reference above the folder (`../shared.css`) resolves to the folder itself and does not load: an artifact sees only its own folder.
- **Paths**: decoded, then refused (403) when a segment is empty, starts with `.`, or holds `\` or a NUL, which also keeps `.env` and `.git` out; then resolved with `realpath` and refused unless the result lies inside the folder, by the [platform's path rules](./agent-host.md#platform-differences), so a link cannot lead out.
- **Types**: the extension decides the type, from a fixed list: `html`, `htm`, `css`, `js`, `mjs`, `json`, `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `ico`, `woff`, `woff2`, `ttf`, `otf`, `mp4`, `webm`, `mp3`, `wav`, `txt`, `csv`, `md` and `wasm`. Anything else is refused. Media answers range requests, so video seeks.
- **Headers** on every response: the [content security policy](#network-policy), a `Permissions-Policy` that turns every powerful feature off (camera, microphone, geolocation, display capture, USB, serial, HID, Bluetooth, MIDI, payment, clipboard, fullscreen), `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so a reload always reads the disk.
- **One page alone**: `?page=<group>.<index>`, where `<group>` is 0 for a page outside a group, serves the HTML with a style element added at the end of its head that hides everything but that page and puts it at the top left with no body margin. The two numbers are checked integers; nothing else from the URL reaches the style.
- **Main's work is asynchronous**: files are read and streamed with `fs.promises`, never synchronously.
- **Reloading**: main watches every file it served for an open artifact, up to 200, and tells the renderer 150 ms after the last change (`artifact:changed`), which reloads that artifact's frames. A canvas keeps its camera and a focused page stays focused.

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

`<CDNs>` is a fixed list in main: `https://cdnjs.cloudflare.com`, `https://cdn.jsdelivr.net`, `https://unpkg.com`, `https://esm.sh`, `https://cdn.tailwindcss.com`, `https://fonts.googleapis.com` and `https://fonts.gstatic.com`.

- **Inline scripts and `eval` are allowed**: the page is the agent's code to begin with, and in-browser JSX and utility-class compilers need both. The policy is there to keep data in, not to vet the page.
- **Nothing reaches another host.** No fetch, image, WebSocket or form goes anywhere but the artifact's own origin and the CDNs, so a page cannot send what it reads from its folder to a server. A remote image from any other host, such as a stock photo, does not load. Allowing any `https` host for scripts, styles, fonts and images was the alternative: more pages would work as written, and any host could then receive data in a URL.
- **Main enforces it a second time.** `webRequest.onBeforeRequest` cancels every request from an artifact frame that is not for its own origin, `data:`, `blob:` or a listed CDN over `https`, whatever the policy says.
- **Frames inside a page** load only from its own origin, so one artifact can never embed another, and `Cross-Origin-Resource-Policy` keeps one artifact from loading another's files by any route.

## The surface

Each page is an `<iframe>` in the app's renderer, pointed at its artifact's origin:

```html
<iframe
  src="overbench-artifact://…/onboarding.html?page=1.2"
  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
  allow=""
  referrerpolicy="no-referrer"
></iframe>
```

- **Its own process.** The artifact's origin is a different site from the app's, so site isolation runs its frames in a renderer process of their own, sandboxed like the window's: in the prototype, the app's frame and an artifact's ran in different processes, both reported sandboxed. Every page of one artifact shares that one process.
- **No bridge.** The preload runs in the main frame only (`nodeIntegrationInSubFrames` stays off), so a page has no `window.overbench`, no `require` and no `process`, and the app never listens to `message` events from it: there is no channel from a page to the app.
- **`allow-same-origin` keeps the page on its own origin**, which is not the app's, so the page has web storage and can fetch its own files; the classic danger of that flag needs the page and its embedder to share an origin, which they never do. Without `allow-popups`, `allow-top-navigation` or `allow-modals`, a page cannot open windows, move the app's frame or block on `alert()`. `allow-downloads` lets a page offer a [download](#downloads).
- **The app's own policy** changes `frame-src 'none'` to `frame-src overbench-artifact:` in `src/renderer/index.html`, its only change, so the app can frame artifacts and nothing else; `object-src 'none'` stays. Main's [frame guard](#the-frame-guard) learns the same exception.
- **The page's theme** is its own. `prefers-color-scheme` inside the page follows the app's effective theme, so a page that supports both themes follows the app; OverBench injects no colors.

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

| A page tries to                                                       | What stops it                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Reach the app's API or Node                                           | The preload runs in the main frame only; the page is in another process                                                            |
| Read or change the app's DOM, or navigate the app                     | A cross-origin frame; `sandbox` without `allow-top-navigation`                                                                     |
| Read files outside its folder, dotfiles or other artifacts            | The protocol's path rules and `realpath` check; one origin per artifact; `Cross-Origin-Resource-Policy`                            |
| Read the disk directly (`file://`) or the dev server                  | Chromium refuses `file:` from another scheme; the policy and main's request filter                                                 |
| Send data to a server                                                 | `connect-src`, `img-src` and the rest of the [policy](#network-policy), and main's request filter                                  |
| Open windows, or open a link in the browser by itself                 | No `allow-popups`; main's window-open handler denies artifact frames and never opens their URLs                                    |
| Navigate itself to another site                                       | `will-frame-navigate` cancels it; an `http(s)` address is offered in a bar the user can follow ([viewer](#viewer))                 |
| Use the camera, microphone, location, notifications, clipboard or USB | `Permissions-Policy`, an empty `allow`, and main's permission handlers, which deny every request and check from an artifact origin |
| Register a service worker                                             | The scheme has no `allowServiceWorkers`                                                                                            |
| Block the app with `alert()`                                          | No `allow-modals`: the call returns at once                                                                                        |
| Write files                                                           | Only through a [download](#downloads), which asks where                                                                            |

- **Main's handlers** already grant nothing but the clipboard, and that only to the app's own page in its main frame ([security](../architecture.md#security)), so an artifact frame gets nothing without a new rule; the build's tests ask for every permission from an artifact origin, so a later change to the handlers cannot let one through. Where main compares origins, it builds one from a URL's scheme and host itself, because Node's `URL` reports a custom scheme's origin as `"null"`: the prototype's permission handler let a notification request through until it did.
- **Verified** in the prototype on 2026-10-22: a probe page made 27 attempts from inside the surface (the app's API and Node, files above its folder, dotfiles, encoded `..`, `file:`, another artifact's origin, the dev server, other hosts by fetch, image and WebSocket, the app's frame and DOM, `window.open`, notifications, the camera, location, the clipboard, `alert()`, service workers), and each one held; the artifact's frame ran in a sandboxed process of its own. The policy stopped the requests before main's filter saw them, so the build tests the filter on its own, with the policy removed.
- **Keys** typed in a page go to the page, as in a browser, `Esc` included. On Windows and Linux, where the renderer handles the app's shortcuts, main forwards the `Mod` shortcuts of the [shortcut table](./ui.md#keyboard) it sees in `before-input-event` while a page has focus, so they keep working; on macOS the menu's accelerators already do. The build checks that `before-input-event` reports keys typed in a page's frame.

How it keeps the [security rules](../../AGENTS.md#security-rules): the window keeps `sandbox`, `contextIsolation` and no `nodeIntegration`; the preload gains typed methods only; main validates every argument of the new calls ([IPC](#ipc-and-host-protocol)); navigation and new windows stay blocked, and an external link opens only after the user's click and main's `http(s)` check; the app's policy frames `overbench-artifact:` where it framed nothing, and the frame guard accepts those frames alone, for the reasons above and below.

### The frame guard

Since v0.0.2, main stops trusting a window whose page gains a frame: it refuses the page's IPC calls and permission requests and takes its host ports away until the main frame loads a new document ([security](../architecture.md#security)). A frame on the app's own origin could reach the page's `window.overbench`; an artifact's frame cannot, since it is on another origin, in another process. The guard keeps its rule for every other frame and learns one exception:

- **Main knows the origins it opened.** `artifact:open` registers an artifact's origin before the renderer creates a frame for it, and `artifact:close` removes it.
- **A new frame is pending until its first document commits.** Main sees a frame when it is created, before anything in it runs, but learns its origin only at the commit. While a frame of the page is pending, main holds the page's IPC calls and answers its permission requests with a denial; the held calls run once every frame has resolved.
- **A frame whose first document commits on an origin main opened** is an artifact's frame, and the page keeps its access. Frames inside it are the artifact's own, kept on its origin by its [policy](#network-policy).
- **Anything else revokes the page's access, as today**: a first document on the app's origin, `about:srcdoc`, `blob:`, `data:` or an origin main did not open, a frame that has not committed within 5 s, and an artifact's frame that later commits on any other origin, which `will-frame-navigate` cancels before it can.
- **Host ports** go straight to the hosts, so main cannot hold them: a frame that turns out not to be an artifact takes them away at its commit rather than at its creation, and in between its document can run only what the app's policy allows, no inline script and only the app's own files.
- The build tests the guard as a process test: the probe's frames, then a frame on the app's origin, `about:srcdoc` and an origin main did not open, each created while IPC calls are in flight; and it measures how long calls wait while a canvas of 24 pages opens.

### Downloads

A page may offer a file to save, such as an exported image. With `allow-downloads`, a download from an artifact asks where to save it in the system's save dialog, and nothing lands on disk without the user's choice. Blocking downloads, by leaving `allow-downloads` out and cancelling each one in `will-download`, was the alternative.

## Thumbnails

- Main renders each card's thumbnail in an offscreen window (`offscreen: true`, sandboxed, no preload, audio muted) in the `overbench-artifact-thumbnails` partition, which has the same protocol, policy, request filter and handlers, at 1280 × 800 for a page; for a canvas, all its pages laid out and scaled to fit, on a transparent background so the card's surface shows between them. It waits for the load and 400 ms more, at most 5 s, captures the window, scales it to 480 px wide, and closes the window.
- Cards ask for their thumbnails as they scroll into view, one at a time, in that order. They are kept on disk in `artifacts/thumbnails/` under the data folder, named by a hash of the path, the size and the modification time, PNG for a canvas and JPEG for a page, so a changed file gets a new one; the folder is trimmed to the newest 500.
- Measured in the prototype: a card took the page's load (0.1 s, or 1.3 s for a page with web fonts) and the 400 ms wait; main's own work was 4 to 77 ms for the capture and 2 to 4 ms to encode; each thumbnail was 12 to 17 KB. Live scaled frames as thumbnails cost 574 MB and 5 processes for 4 cards, so cards never hold a live page.

## Interface

The rules this follows are the [visual style](./visual-style.md) and the [UX guidelines](./ux-guidelines.md); [Interface](./ui.md#artifacts) points here.

### Artifacts page

```text
 Artifacts                                              ⌕ Filter by name
 9 files from 4 sessions

 acme-web  5
 ✳ Explore onboarding directions  12 min ago
 ┌────────────┐ ┌────────────┐
 │ ▯ ▯ ▯      │ │            │
 │ ▭ ▭        │ │            │
 └────────────┘ └────────────┘
 onboarding.html  trips.html
 design · Canvas, 5 pages     design
```

- **Opening it**: the sidebar's **Artifacts** row (`Shapes`), which stays highlighted while the page shows ([sidebar](./ui.md#sidebar)). The page's code loads with dynamic `import()` the first time it opens.
- **Layout**: a centred column of at most 960 px on surface 1. The header holds the title, a line saying how many files from how many sessions, and a filter field at its end that filters by file name (`Mod+F` focuses it, `Esc` clears it).
- **Groups**: each project is a group label with its count, in the sidebar's project order, then **No project**. Under it, each session that wrote an artifact, most recently updated first: the agent's mark, the session's title at weight 500 and how long ago it was updated, as a row that opens the session. A project or session with nothing to show has no group.
- **Cards**: a grid of cards at least 200 px wide, four across at 960 px. A card is the thumbnail, 16:10 on `--bg-subtle` with a hairline `--border-default` ring and `rounded-xl`, then the file name at weight 500 and, at the caption role, its folder relative to the project and, for a canvas, "Canvas, 5 pages". A card has no shadow and does not rise: on hover its ring turns `--border-strong`. The full path and the other sessions that wrote it are its tooltip.
- **Card states**: a `Skeleton` in the thumbnail's place while it renders; a `File` icon on `--bg-subtle` when it could not render; **Missing** for a file no longer on disk, its name in `--text-disabled`.
- **A card's menu** (right click, `Shift+F10`): **Open**, **Open in browser**, **Show in Finder** (Explorer, the file manager), **Copy path**, then **Open the session**.
- **Keyboard**: the cards are one Tab stop; the arrow keys move through them in reading order and `Enter` opens one.
- **States**: loading shows the header and a row of `Skeleton` cards at their real size; no artifacts shows one `Empty` (`Shapes`, "No artifacts yet", "HTML files your agents write in a session show here, by project and session. A file that marks its pages shows as a canvas.") with **Copy the canvas format**; a filter that matches nothing says "No matching artifacts" in the list's place; a failed read shows an `Alert` with **Retry**.
- **Why cards under each session's title**: group labels introduce their content everywhere else in the app. The alternatives were the session's title in a 200 px column beside its cards, which wastes less height when sessions have one or two files, and one 44 px row per file with a 56 px thumbnail, which fits the most.

### Viewer

Opening a card shows its artifact in the main area, in place of the page, with **Back** (`ArrowLeft`, `Esc` while nothing in the page has focus) to the list.

- **Top bar**: **Back**, the file name at weight 500 and its folder in `--text-secondary`; at the end, for a canvas, the zoom as a stepper (`Minus`, the percentage in `tabular-nums`, `Plus`) and **Zoom to fit** (`Scan`); then **Reload** (`RefreshCw`) and **More** (`Ellipsis`), whose menu holds **Open in browser**, **Show in Finder**, **Copy path**, **Copy the canvas format** and **Open the session**.
- **A single page** fills the area below the top bar, at the area's size, so the page is laid out for the space it has and scrolls itself.
- **The frame appears when it has loaded**, fading in over `--duration-fast`, so a half-drawn page never shows.
- **A blocked navigation** shows a bar over the top of the page: "This page tried to open example.com" with **Open in browser** and a dismiss button. Nothing opens without that click.
- **States**: a file that is gone shows `Empty` ("This file is no longer at ~/acme/design/onboarding.html") with **Back**; a page whose process stopped shows "The page stopped" with **Reload**.
- **Open in browser** opens the file with the system's default browser, where OverBench's isolation no longer applies; it is the user's explicit choice.

### Canvas

```text
 ← onboarding.html  design                       − 37% +  ⛶  ⟳  ⋯
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

- A thread's tool call that wrote an artifact gets **Open** (`Shapes`) at the end of its row, before the status, shown on hover and focus ([tool calls](./ui.md#tool-calls)). A canvas opens fitted.
- **It opens in the side panel**, as a pane beside the [Files](./ui.md#files) and [terminal](./ui.md#terminal) panes, so the page reloads in view while the agent keeps editing it. The pane's header holds the file name, **Reload**, **More**, **Maximize** and **Close**, as the other panes' headers do; it opens at 560 px and keeps its width; it has no toggle in the top bar, since it opens from the thread, and a card's **Open the session** opens the session with the artifact beside it.
- **A canvas in the pane** pans, zooms and takes its keys as in the main area. A focused page puts its name, `ChevronLeft`, the counter, `ChevronRight` and **Back to the canvas** in the pane's header, before **Reload**; `Esc` leaves the focused page and never closes the pane.
- Opening the full viewer in the main area, with **Back** to the session, was the alternative: it adds no pane, but the thread is out of sight while the page shows.

## IPC and host protocol

Agent host requests and events ([host protocol](./host-protocol.md)):

| Method or event     | Params     | Result or payload       | Notes                                                                                                   |
| ------------------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `artifacts.list`    | none       | `ArtifactSummary[]`     | Every artifact, with its session and whether the file exists                                            |
| `artifacts.read`    | `{ path }` | `{ text } \| too-large` | An indexed artifact's text, up to 5 MiB, for the viewer to find its pages; anything else is `not_found` |
| `artifacts.changed` | none       | none                    | Event to all ports after the index changed                                                              |

```ts
interface ArtifactSummary {
  path: string // absolute
  projectPath: string | null // the project it shows under; null for No project
  sessionId: string // the top-level session it shows under
  writers: string[] // the other sessions that wrote it, most recent first
  exists: boolean
  size: number | null
  modifiedAt: number | null
  pages: number // page markers found in its first 2 MiB; two or more is a canvas
}
```

The viewer parses the text with the renderer's `DOMParser`, which builds an inert document that runs no script and loads nothing, and takes the pages from it by the [format's rules](#canvas).

Renderer and main ([adding an IPC call](../../AGENTS.md#adding-an-ipc-call)):

| Channel                  | Arguments                | Result                 | Main checks                                                                                                           |
| ------------------------ | ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `artifact:open`          | `path`                   | `{ url }`              | An absolute path to a regular `.html` or `.htm` file; registers its origin and folder ([the protocol](#the-protocol)) |
| `artifact:close`         | `url`                    | none                   | Stops watching its files and removes its origin from the [frame guard](#the-frame-guard)                              |
| `artifact:thumbnail`     | `path`, `layout?`        | A `data:` URL, or null | As `artifact:open`; a canvas layout is a list of at most 500 pages of checked integers                                |
| `artifact:open-external` | `path`                   | none                   | As `artifact:open`; opens it in the default browser                                                                   |
| `artifact:changed`       | event: `{ origin }`      | —                      | Sent when a file an open artifact loaded changed                                                                      |
| `artifact:blocked`       | event: `{ origin, url }` | —                      | Sent when a page's navigation was cancelled; `url` is shown only when it is `http(s)`                                 |

**Show in Finder** uses the existing `shell:show-item`.

## Building it

The design is larger than one pull request, so the build splits into sub-issues of #11, each useful on its own:

1. The index: schema version 2, the migration, `artifacts.list`, `artifacts.read` and `artifacts.changed`, with tests over each agent's recorded tool calls.
2. The surface: the protocol, the policy, main's request filter, handlers and navigation guard, the frame guard's exception, the single-page viewer, and the probe as a process test, run once more with the policy removed.
3. The Artifacts page and thumbnails, and the sidebar row turned on; the [UX guidelines](./ux-guidelines.md#structure) then lose the disabled row as their example of a feature shown before it is built.
4. The canvas viewer.
5. Opening from a session.

## Alternatives considered

- **Pages named by a manifest or by one file per page**: the decision is one file per canvas, and a manifest is a second file to keep in step.
- **Finding pages without markers**, from sections of a fixed size or a slide deck's script: fragile, and a deck's script shows one slide at a time.
- **Finding pages by running the file**, so script-built pages count: it needs a script in every page that reports to the app, which is the channel this design keeps closed. It can come later as a probe whose messages carry only numbers and names, if agents' canvases need it.
- **Deriving the list on every read** instead of indexing it: hundreds of milliseconds to seconds on a large history ([index](#index)).
- **Serving from `file://`**: the page could then read any file the browser engine lets a local page read, and every artifact would share one origin.
- **`registerSource`** for the protocol: it cannot add headers or refuse dotfiles.
- **Opening artifacts in the system browser only**: no canvas, no reload as the agent edits, and the browser's `file://` rules instead of OverBench's.

## Prototype

A prototype in Electron 44.9.2, outside the repository, built for this design on 2026-10-22: the Artifacts page in its three layouts and both themes, the viewer, the canvas with all four surfaces switchable, thumbnails, live reload and the isolation probe. The numbers in this document come from it.
