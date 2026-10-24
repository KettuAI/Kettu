# Media

> Status: Accepted 2026-10-24 with option A, built in steps from a [first version](#first-version); the steps after it are refined once it is accepted · Screens in [Interface: media](./ui.md#media) and [files](./ui.md#files) · Types in the [session model](./session-model.md#thread-entries) · Issue [#43](https://github.com/overbench/overbench/issues/43)

How OverBench finds, serves and shows the images, audio and video an agent sends or names: in the thread, in the viewer and in the Files pane. Sending media from the composer is the composer's design ([Interface: composer](./ui.md#composer)); this document covers what comes back and what is on disk.

## Options

Three presentations were offered on 2026-10-22, each on a [page to try](https://claude.ai/artifact/Sv32T9zwbKJbUN9crodw8x), in both themes, with the measurements below. They share everything in this document except how media sits in a reply.

| Option                      | In a reply                                                                                                                  | Players                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **A. In place**, chosen     | Each image, clip and sound shows under the paragraph that names it; a click on an image or **Open larger** opens the viewer | Chromium's own controls, in a hairline frame   |
| B. Gallery strip            | The text stays whole; the message's media gathers into a strip of 96 px tiles at its end                                    | A player bar of our own, drawn from the tokens |
| C. Chips and the side panel | Media stays a file chip in the text; a click shows it big in the side panel beside the conversation                         | Chromium's own controls, in the side panel     |

A was recommended: it plays where the reply names it, as [problem 49](../milestones/m0-feedback.md#49-no-multimodal-support-images-audio-and-video) asks, and the platform's controls bring keyboard, seeking, speed, picture-in-picture, fullscreen and screen reader support that B would have to rebuild. [Interface: media](./ui.md#media) describes A.

> Decided 2026-10-24: the maintainer chose A on the page, and asked for a simple version to accept first and refine step by step after it.

## First version

The first build covers the case that started it, a screenshot an agent saved and named by its path ([#43](https://github.com/overbench/overbench/issues/43#issuecomment-6379889027)):

- **Images in replies, in place.** A Markdown image that names a local file, spaces in its path included ([spaces in a path](#spaces-in-a-path)), loads from the [media scheme](#the-media-scheme) under the grant rules as written; image blocks show from their bytes, as they do today. Images only: the scheme answers a whole file, without ranges.
- **States**: loading, missing, format not supported, read error and remote ([states](#states)), without **Open with default app** and **Show in Finder**.
- **A plain viewer**: a click or `Enter` opens the picture fitted on the dark scrim, with its name and sizes in the bar and **Close**; `Esc` or a click on the scrim closes it, and focus returns to the picture. It fades in and out.
- **Built so far**: the CSP allows the scheme in `img-src` only. A reply asks for its grants as it renders, and the pictures load lazily (`loading="lazy"`); the shared observer that holds back the grants too comes with video. The renderer keeps a grant for the run, up to 500, and asks again once when a picture fails to load, as after a session's grants were dropped.

Later steps, each its own issue once the first version is accepted: video and audio with Chromium's players, and the scheme's range requests; zoom, pan, stepping and the shared-element motion in the viewer; **Copy image**, **Save as…** and **Show in Files**; media in tool calls; media in the Files pane; attached images in the viewer; audio and video bytes carried in the conversation, with their 20 MB cap. The decisions this document marks to be agreed wait for the step that needs them; the grant rules are part of the first version, since nothing is served without them.

## What counts as media

| Kind  | Shown                                                         | Recognised as a file by                                                                                                 |
| ----- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Image | PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG                  | Its name, then its first bytes, as the Files pane reads pictures today ([project files](./agent-host.md#project-files)) |
| Audio | MP3, WAV, AAC (`.m4a`), Ogg Opus and Vorbis, FLAC, WebM audio | `.mp3`, `.wav`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.opus`, `.flac`, `.weba`, then its first bytes                         |
| Video | MP4, WebM, MOV and MKV                                        | `.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv`, then its first bytes                                                           |

- **The bytes decide.** A name only nominates a file; its first 4 KB give the kind and the MIME type the file is served with, never its extension. A file whose bytes are no such format is an ordinary file. An SVG is text whose first element, after an optional XML declaration, comments and a doctype, is `<svg`.
- **Containers are tried, not trusted.** Chromium answers `canPlayType('video/quicktime')` with "no", yet plays H.264 in a `.mov`; and it loads a ProRes `.mov`, plays its sound and reports a picture of 0 × 0 without raising an error. So a video is tried, and one that has no picture after its metadata loads counts as a format Chromium cannot play ([states](#states)).
- Formats Chromium does not decode, such as HEIC, TIFF and ProRes, are still recognised by name, so they get a state that says so with a way out, instead of the binary file notice.

Observed in Electron 44.9.2 (Chromium 152) on macOS arm64 on 2026-10-22, with files made by ffmpeg: H.264 in `.mp4`, `.mov` and `.mkv`, HEVC (`hvc1`), VP9 and AV1 in `.webm`, and AV1 in `.mp4` play; MP3, WAV, AAC, Ogg Opus and FLAC play; HEIC fails to decode.

## Where media comes from

Two sources, kept apart because they differ in who holds the bytes.

### Bytes in the conversation

ACP content blocks that carry their bytes: `image` and `audio` blocks, and `resource` blocks whose blob has an image, audio or video MIME type, in agent messages and in tool call content. The mapper turns them into [content refs](./session-model.md#thread-entries) with their base64 data, and the renderer shows them from `data:` URLs, as it shows images today.

- An `image` block may also carry a `uri`. Codex's image generation sends the picture together with the path it saved it to (codex-acp 2.2.2, observed 2026-10-22), which **Show in Files** then uses.
- An `image` block with no data and an `http(s)` `uri`, which claude-agent-acp 0.94.0 sends for an image given by URL, becomes a link and is never loaded ([remote media](#remote-media)).
- A block whose data is over 20 MB of base64 becomes an `unsupported` ref that names its kind and size, so one block cannot swell the thread store or every snapshot of the session.

### Files on disk the conversation names

Files an agent wrote, such as a video it rendered into an output folder, are read where they lie. A file counts when the session's thread names it in one of these places:

- a Markdown image in a reply, `![alt](out/chart.png)`, shown where it is written ([spaces in a path](#spaces-in-a-path));
- a [file reference](./ui.md#markdown) in a reply that names a media file, shown under the block that names it;
- a `resource_link` whose URI is a local path or a `file:` URI, such as Codex's `view_image` and the attachments it replays, and an `image` block's local `uri`;
- the `locations` and diff paths of a tool call, shown in its details.

A path in a command line or in a tool's text output is not recognised: output is full of paths, and the reply names what matters. A path is relative to the session's folder, absolute, or starts with `~/` for the home folder. The session's folder is its project, or for a session started with No project its [scratch folder](./session-model.md#sessions-without-a-project), where agents often save what they make, such as a screenshot. Unlike a reference to a text file, it need not be in the project's file list, which leaves out git-ignored folders such as `out/` or `dist/`: the host checks it on disk instead ([granting](#granting-a-file)).

The renderer finds these files in the entries it already has; they add nothing to the session model.

#### Spaces in a path

Agents write absolute paths as they are, spaces included: OpenCode, asked for a screenshot on 2026-10-24, replied `![desktop](/Users/…/Application Support/OverBench Dev/scratch/…/desktop-shot.png)` ([#43](https://github.com/overbench/overbench/issues/43#issuecomment-6379889027)). CommonMark ends a link destination at its first space unless it is written `<…>`, so that line renders as text. Before a reply is parsed, a remark step takes `![alt](` followed by a path that starts with `/`, `~/`, `./`, `../` or a drive letter, holds no `(`, `)` or line break, ends in a media file's extension and is followed by `)`, and reads it as if the destination were written `<…>`. Anything else keeps CommonMark's reading, so code spans and blocks, where Markdown is not parsed, and prose that only looks like an image stay text.

## The media scheme

Files reach the renderer through `overbench-media:`, a scheme main serves from grants the agent host issues. The renderer still has no file system access: it can play only a file the host has checked, by an unguessable URL.

```text
overbench-media://<grant>/<file name>?v=<mtime>
```

### Granting a file

`media.open` ([host protocol](./host-protocol.md#requests)) asks the host for a grant: `{ projectPath, path, sessionId }`, the session's folder, the path as the thread writes it, and the session whose thread is shown. It answers `granted` with a `MediaGrant`, or `not_found`, `forbidden` or `not_media`; a file it cannot read fails the request. The host:

1. Resolves the path: a `file:` URI to its path, a leading `~/` to the home folder, a relative path against `projectPath`, which is the session's folder, its project or its scratch folder. A path that is not there is tried once more percent-decoded, since some agents write spaces as `%20`.
2. Takes its real path (`realpath`) and requires a regular file.
3. Allows it when the real path is inside that folder, by the [platform's path rules](./agent-host.md#platform-differences), git-ignored folders included; or when that session's thread names the path as written in an entry of the agent or the user, found in the live thread or in the [stored one](./persistence.md#threads), where it is looked for as JSON writes it inside a string. Anything else is `forbidden`, so the renderer cannot ask for a file no one named.
4. Reads its first 4 KB and takes the kind and MIME type from them ([what counts](#what-counts-as-media)); a file that is not media is `not_media`.
5. For an image, reads its pixel size when the header holds it (PNG, GIF, WebP and BMP at their start, JPEG within its first 64 KB, turned when its Exif orientation turns it a quarter), so the thread reserves the exact box before it loads. AVIF, icons and SVG have no size here and take the one they decode to.
6. Registers the grant with main (`host:media-grant`, [main and host messages](./agent-host.md#main-and-host-messages)) and answers a `MediaGrant`:

   ```ts
   interface MediaGrant {
     url: string // overbench-media://<grant>/<file name>?v=<mtime>
     kind: 'image' | 'audio' | 'video'
     mimeType: string // from the first bytes, never the name
     size: number // bytes
     width?: number // an image's pixels, when its header holds them
     height?: number
   }
   ```

- A grant is a random 128-bit token in base32. Grants live in main's memory only: a session's go when it is deleted, all go when a project or every session is removed or the host stops, and past 2,000 the oldest go first. A renderer that meets a dropped grant asks again.
- `files.read` grants a media file of the Files pane itself and answers `media` with its URL instead of its bytes ([project files](./agent-host.md#project-files)), so the pane and the thread read media the same way.

### Serving

- Main registers the scheme before `ready` with the `standard`, `secure` and `stream` privileges (`<video>` and `<audio>` expect a streamed response only from a `stream` scheme) and handles it with `protocol.handle` on the app's session. Main's request filter cancels a request on the scheme unless it comes from the main frame of OverBench's own page, as `isRendererUrl` tells by the frame's URL, so a frame on another origin in the same session, such as an agent's HTML page ([#11](https://github.com/overbench/overbench/issues/11)), and any other session, such as the built-in browser ([#47](https://github.com/overbench/overbench/issues/47)), cannot use a grant even if it learned one.
- Each request looks the token up, takes the file's real path again and compares it with the grant's, so a file swapped for a link since the grant is refused, and takes its current size from `fs.stat`. A `Range: bytes=start-end` or suffix range answers `206` with `Content-Range` from `fs.createReadStream(path, { start, end })`; no range answers `200` with the whole file, streamed; a range past the end answers `416`. Everything is asynchronous: main never reads a whole file and never blocks.
- Headers: `Content-Type` from the grant, `Accept-Ranges: bytes`, `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so a response opened as a document, should one ever be, runs nothing.
- `?v=` carries the file's modification time when it was granted, so a file the agent rendered again gets a new URL and loads fresh rather than mixing old and new ranges.
- The host hands main a grant and the renderer its URL over different channels, so a request for a token main does not know yet waits up to 1 s for its grant.
- An unknown token, a method other than `GET` or `HEAD`, or a file gone since the grant answers `404`, which the item shows as [missing](#states).

Measured in a prototype with the same privileges and a CSP like the app's (Electron 44.9.2, macOS arm64, 2026-10-22): a 91 MB, 120 s 1080p H.264 file reached its metadata in 26 ms and seeked to 80% in 281 ms cold and 67 ms warm, reading 17 MB in three range requests; 5 s of its playback at 6 Mbit/s cost main 49 ms of CPU, 1%.

### SVG

An SVG is only ever shown as an image, in `<img>` or as a CSS background, never placed in the DOM and never opened as a document. In image mode Chromium runs none of its scripts and loads nothing it references: the prototype's SVG with a `<script>`, an `onload` handler and an external `<image>` rendered, and none of the three requests reached the scheme.

### Actions on a file

**Copy image**, **Save as…**, **Show in Finder** (File Explorer, the file manager) and **Open with default app** are main's: `media:copy-image`, `media:save-as`, `media:reveal` and `media:open-external` ([adding an IPC call](../../AGENTS.md#adding-an-ipc-call)) take a media URL, which main resolves through its grants, never a path from the renderer. Copy puts the picture on the clipboard as an image (`clipboard.writeImage`). For bytes carried in the thread, copy and save take the bytes themselves, within the 20 MB cap.

### Agent HTML

[Artifacts](./artifacts.md#the-protocol) serve the HTML pages agents hand over on `overbench-artifact:`, an origin per artifact, from OverBench's own store, in sandboxed frames. The two schemes share only their hardening headers (`nosniff`, `no-store`) and the way main streams a file into a response. The media scheme serves single granted files where they lie, never a document, to OverBench's own page alone, and adds the real-path check and range requests, which the store's files do not need; the artifact scheme serves documents to their own frames, whose network policy lets them request nothing but their own origin and a fixed list of CDNs.

## Content Security Policy

`src/renderer/index.html` today allows `img-src 'self' data: blob:` and has no `media-src`, so audio and video fall back to `default-src 'self'`. It becomes:

```text
img-src 'self' data: blob: overbench-media:; media-src data: overbench-media:
```

- `overbench-media:` for files, which only granted files answer.
- `data:` in `media-src` for audio and video carried in the conversation, within the 20 MB cap, as `data:` already serves its images.
- Still nothing remote: no `https:`, so a reply cannot load a tracking pixel or a remote clip, and nothing the agent writes can make the page fetch.
- Media needs no `blob:`. It is in `img-src` for the full view of an attached image ([attachments](./session-model.md#where-the-bytes-live)), which the [viewer](./ui.md#viewer) shows too.

## Remote media

A Markdown image or an `image` block that points to an `http(s)` URL is never loaded: it shows as a link chip with the URL's host, which opens in the system browser. The rule that the CSP blocks remote images ([architecture: security](../architecture.md#security)) stays as it is.

## Sizes and performance

- **Lazy.** A media item asks for its grant and sets its source only when it comes within one viewport of the thread's visible part, through one shared `IntersectionObserver`, as the thread measures its clamps through one shared `ResizeObserver`. Off-screen entries keep `content-visibility: auto`.
- **Reserved boxes.** An image's box comes from its pixel size, from the grant or from the decoded bytes, so it never shifts the thread. A video holds a 16:9 box at the column's width until its metadata arrives, then takes its own ratio once; this happens within a viewport before it scrolls into view.
- **Images.** Decoded off the main thread (`decoding="async"`), at their own resolution, scaled by CSS. Measured in the prototype: a 4000 × 3000 PNG decodes in 87 ms and a JPEG of the same size in 14 ms. Decoding costs the same from `data:`, `blob:` or the scheme, but a `data:` URL is first built as a string on the main thread: 28 ms for a 1.2 MB PNG, 1.6 million characters. No thumbnails are made and none are stored; a thread of large screenshots is measured with the performance script before one is added.
- **Video and audio** load with `preload="metadata"`: the header and the first frame, 1.2 MB of the 91 MB file above. Nothing plays by itself, and starting one pauses any other in the window.
- **Streaming.** Seeking reads only the range it needs, so a file of any size plays; there is no size limit for files on disk.

## Persistence

- **Bytes in the conversation** are stored with the entry, and those over 32 KB of base64 once per session in the thread store's `blobs` table, audio and video as images already are ([threads](./persistence.md#threads)).
- **Files on disk** are never copied. The entry keeps the text the agent wrote, and reopening the session asks for a fresh grant: a file moved or deleted since shows [missing](#states), and a file changed since shows as it is now. The thread shows the file, not a snapshot of it.
- **Grants** are never stored.
- **Replays**: a session without a stored thread replays from its agent with `session/load`. Claude Code replays image blocks, the user's and its own; Codex replays a user's local images as `resource_link`s to their files, which show from disk while they are still there (claude-agent-acp 0.94.0 and codex-acp 2.2.2, read on 2026-10-22).

## States

| State                | Detected by                                                                                                        | Shows                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Loading              | The grant or the first bytes have not arrived                                                                      | A `Skeleton` at the reserved size, after 200 ms                                                                        |
| Missing              | `media.open` answers `not_found`                                                                                   | The file's name and "Not found at `out/render.mp4`." with **Retry**                                                    |
| Format not supported | The element's `MEDIA_ERR_SRC_NOT_SUPPORTED` or `MEDIA_ERR_DECODE`, an image that does not decode, a video of 0 × 0 | "This video's format can't be played here." (or image, or sound) with **Open with default app** and **Show in Finder** |
| Read error           | `media.open` or the request fails otherwise                                                                        | `CircleAlert` and "Can't read `name`" in `--destructive`, the system's error under it in mono, and **Retry**           |
| Not allowed          | `forbidden`                                                                                                        | Nothing new: the reference stays the chip or link it was                                                               |
| Remote               | An `http(s)` source                                                                                                | A link chip with the host                                                                                              |

The look of each, in the thread and in the Files pane, is in [Interface: media](./ui.md#media).

## Accessibility

- An image's text alternative is the Markdown alt text, else a `resource_link`'s description or title, else the file name. ACP's `image` block carries no alt text.
- Players and their controls are Chromium's, which are reachable from the keyboard and labelled for screen readers; each element is labelled with its file name.
- Captions: ACP carries no text tracks, and a video's own subtitle streams are not read. None are shown in this version.
- The viewer is a modal dialog: it holds focus, closes on `Esc` and gives focus back to what opened it ([Interface: media](./ui.md#media)).

## Platform differences

- **Codecs**: the formats above were checked on macOS. HEVC plays there through the system decoder; on Windows it needs the system's HEVC extension, and Chromium on Linux has no HEVC decoder, so there it shows as a format that cannot play. Windows and Linux are checked in the [screenshots](./testing.md#screenshots) run before the build is accepted.
- **Show in the file manager** and **Open with default app** use `shell.showItemInFolder` and `shell.openPath`, and the item names the platform's file manager: Finder, File Explorer, or "the file manager" on Linux.
- Paths are compared after `realpath`, case-insensitively on Windows, as [project files](./agent-host.md#project-files) are.

## Alternatives considered

- **`data:` URLs for files**, as the Files pane shows pictures today: no seeking, so no video; the whole file through the host's port as base64, a third larger; a string built on the main thread; and a 10 MB cap. Kept only for bytes the conversation already carries.
- **Bytes over the host's port into `blob:` URLs**: no streaming either, and the whole file held in the renderer.
- **`net.fetch` of a `file:` URL in the handler**: it ignores `Range` and answers `200` with the whole file, so seeking jumps back to the start (measured in the prototype).
- **`protocol.registerSource`**, experimental in Electron 44: it serves without JavaScript, and cost main 8 ms of CPU for the same 5 s of playback instead of 49 ms. But it serves whole folders by file extension, with no per-file grant and no check of the bytes, and a file outside the project could only be served by opening its folder. Revisit when it is stable and if main's share is measured to matter.
- **Serving from the agent host**: only main can handle a scheme, and relaying each chunk through the host would add a hop to every read for nothing; the host's part is deciding what may be read.
- **`file:` URLs in the renderer**: would let the page load any file on the machine.
