# Contributing to Kettu

Thanks for helping shape Kettu.

## How to contribute

Kettu takes issues from outside, not code: fixes and features are written by the project, and pull requests are opened by collaborators only. The code is under the [AGPL-3.0](./LICENSE) with the [additional permission](./LICENSE-EXCEPTION) for affectUI, and a contribution comes under the same terms.

- **Bugs and ideas**: open an issue through the [issue forms](https://github.com/KettuAI/Kettu/issues/new/choose), in any language. A screenshot helps.
- **Security problems**: follow [SECURITY.md](./SECURITY.md); never post them in a public issue.

## Run from source

You need Node.js 22.13 or later and pnpm 10:

```bash
pnpm install
pnpm dev
```

`pnpm dev` keeps its data in its own folder, `Kettu Dev`, so it never touches the sessions of an installed Kettu. To run several worktrees at once, give each one a folder of its own with `KETTU_USER_DATA`, such as `KETTU_USER_DATA=/tmp/kettu-feature-x pnpm dev`; a second run on the same folder quits.

Development builds also list a **Fake agent**, which needs no account or network and plays scripted scenarios such as a long answer, a burst of tool calls or three approvals at once. Type `/` in its composer to see them; they are written in [`tools/fake-agent/scenarios.ts`](./tools/fake-agent/scenarios.ts).

Computer use runs Cua Driver's `cua-driver` program, which is not an npm package: `pnpm fetch:cua-driver` downloads the pinned release for your platform into `resources/cua-driver/` and checks its SHA-256. Without it, Settings › Computer use says the build has no driver. The Fake agent's `/computer` scenario calls the `computer_*` tools, for trying the checks, cards and label without a model: calls separated by `;` run in turn, and `wait <ms>` holds the turn between them, such as `/computer computer_get_window_state {"pid": 123, "window_id": 4} ; wait 20000`. Turn computer use off in Settings to see the setup card.

| Command                                               | What it does                                         |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                            | Start the app in development mode with hot reload    |
| `pnpm dev:web`                                        | Serve the web client with hot reload                 |
| `pnpm test`                                           | Run the core tests                                   |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`        | Lint, type-check and format the code                 |
| `pnpm build`                                          | Type-check and build the app into `out/`             |
| `pnpm package`                                        | Build an unpacked app into `dist/` for local testing |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | Build installers for each platform                   |

Packaging on macOS also needs Xcode 26 or later, whose `actool` compiles the app icon.

`pnpm build` also builds the daemon into `out/daemon/`: the `kettu` CLI and the hosts it runs under Node.js, without Electron. Give it a data folder of its own and run it in the foreground, such as `KETTU_DAEMON_DATA=/tmp/kettu-daemon node out/daemon/main.cjs run`; `status` with the same folder asks the running daemon, `direct` shows the port and the addresses devices connect to directly, which `direct port`, `direct add` and `direct remove` change, `terminal` says whether devices may use the terminal, which `terminal on` and `terminal off` change, and `KETTU_FAKE_AGENT=tools/fake-agent/main.ts` adds the Fake agent. `kettu service install` sets up a real system service, so never run it on a contributor's computer.

It builds the web client into `out/web/` as well, which the app and the daemon serve on the direct port while remote access is on: a browser pairs from the link in Settings › Remote access › Add device › Browser or from `kettu pair`. `pnpm dev:web` serves it with hot reload; `KETTU_WEB_HOST=http://localhost:<direct port> pnpm dev:web` passes its channel on to a running host.

Settings › Account and `kettu login` sign in to a Kettu account on `https://www.kettu.sh`, whose pages and `/api/` speak OAuth 2.0 for native apps: the app through the system browser and a loopback redirect, the daemon with a device code. `KETTU_ACCOUNT_URL` points either at another copy of the site and its API, such as `KETTU_ACCOUNT_URL=http://localhost:4321` for one running locally.

After `pnpm build`, `node tools/daemon/package.mjs --out dist/daemon` packages the daemon for this computer as a release does: the pinned Node.js, the daemon, the web client, node-pty as this checkout built it, and `bin/kettu`; `--node <folder>` takes an unpacked Node.js release instead of downloading it. `tools/daemon/install.sh`, which `https://kettu.sh/install` serves, installs a release's package. `KETTU_RELEASES_URL` points it at another place laid out as GitHub's releases, such as a `file://` folder whose `download/v<version>/` holds the package and `kettu-daemon-sha256sums.txt`, for `HOME=<folder> sh tools/daemon/install.sh --version <version> --no-service`; `kettu update` reads the same variable, from a server laid out that way.

What is planned next is in the [roadmap](./ROADMAP.md).

## Project work

For the project's collaborators and their coding agents. Every change goes through an issue and a pull request, named and described as the Git conventions in [AGENTS.md](./AGENTS.md#conventions) say. Before a pull request leaves draft, make sure these pass:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## UI stack

Each concern has exactly one library. Build with these instead of adding an alternative; if one of them really does not fit, open an issue first.

| Concern                     | Library                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Components and visual style | [shadcn/ui](https://ui.shadcn.com), `base-nova` style on Base UI                                                      |
| Icons                       | [Hugeicons](https://hugeicons.com) (`@hugeicons/react` with `@hugeicons/core-free-icons`)                             |
| Animation                   | [Motion](https://motion.dev) (`motion/react`)                                                                         |
| Resizable layout            | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels), through the shadcn `Resizable` component |
| Drag and drop               | [dnd-kit](https://dndkit.com) (`@dnd-kit/react`)                                                                      |
| State management            | [Zustand](https://zustand.docs.pmnd.rs)                                                                               |
| Markdown                    | [Streamdown](https://streamdown.ai) and its code, CJK and Mermaid plugins; KaTeX for maths                            |
| Syntax highlighting         | [Shiki](https://shiki.style)                                                                                          |
| Diffs                       | [Diffs](https://diffs.com) (`@pierre/diffs`)                                                                          |
| Code editing                | [CodeMirror 6](https://codemirror.net) (`codemirror`), in the Files pane and the composer                             |
| Terminal                    | [xterm.js](https://xtermjs.org) (`@xterm/xterm`) in the renderer, `node-pty` in the terminal host                     |
| Localization                | [i18next](https://www.i18next.com) with [react-i18next](https://react.i18next.com)                                    |

- **Components**: add shadcn components with `pnpm shadcn add <component>` rather than writing them by hand; they land in `src/renderer/src/components/ui`. Reach for their variants before custom classes, and style with semantic tokens such as `bg-background` and `text-muted-foreground`, never raw colors, so the light and dark themes stay consistent. Radii, sizes and timings come from the theme tokens as well. Class names are merged by `cn`, which must know the theme's own tokens (`text-ui`, `shadow-card`) to tell a size from a color: its tables in `lib/cn-tables.ts` are compiled from the `@theme` in `globals.css`, and the build points the `cn` import the shadcn CLI writes at `lib/utils`. `pnpm dev` and `pnpm build` regenerate the tables; commit the file when it changes.
- **Icons**: draw Hugeicons' free icons with `HugeiconsIcon`, e.g. `<HugeiconsIcon icon={Search01Icon} strokeWidth={1.9} />` with `Search01Icon` from `@hugeicons/core-free-icons`. Do not mix in other icon sets or inline SVGs for UI icons, and never draw an icon by hand; `ForkIcon` is the one exception, since Hugeicons has no glyph like it. Every icon takes the 1.9 stroke affectUI draws with, at any size. File and folder types and the system logos on devices and hosts are the exceptions to Hugeicons: file types use `FileTypeIcon`, from Material Icon Theme, and `SystemLogo` draws the Apple, Windows and Linux logos from Simple Icons.
- **Animation**: hover, press, focus, color and opacity changes, enter-only effects and looping indicators are CSS; they run on the compositor and cost no JavaScript per frame. Use what the stack already provides, timed with the motion tokens: tw-animate-css's `animate-in` utilities, shadcn's `shimmer` and `scroll-fade` utilities, `Collapsible`, `Skeleton` and `Spinner`. Write a keyframe of your own only where none of them fits. Use Motion for springs, layout and shared-element animations, gestures, and elements leaving the tree (`AnimatePresence`). The enter and exit transitions that ship with shadcn components (tw-animate-css) are kept, timed like the rest of the interface: `duration-(--duration-fast)` on `ease-standard`. Reduce-motion is honored by the root `<MotionConfig reducedMotion="user">` and by the `prefers-reduced-motion` block in `globals.css`; do not bypass either.
- **Layout**: build split and resizable layouts from `ResizablePanelGroup`, `ResizablePanel` and `ResizableHandle` in `components/ui/resizable.tsx`.
- **Drag and drop**: use `@dnd-kit/react`, the current dnd-kit API, not the legacy `@dnd-kit/core` and `@dnd-kit/sortable` packages. It is still on 0.x, so read its changelog before bumping the minor version.
- **Markdown**: render agent text with Streamdown, in `streaming` mode while it streams and `static` mode afterwards, with `skipHtml` on. Never render agent output with `dangerouslySetInnerHTML`. Formulas are drawn by KaTeX's own DOM builder into an element React leaves alone, and Mermaid diagrams show as an image of the SVG it returns; both load with dynamic `import()` the first time a reply needs them.
- **Code and diffs**: highlight only with Shiki, through the shadcn `code-block` component, Streamdown's code plugin and `@pierre/diffs`. Render diffs with `@pierre/diffs` and its worker pool. Code is colored only by the theme's six syntax tokens (`--syntax-*` in `tokens.css`), through the built-in light and dark Shiki themes in `features/session/markdown/code-themes.ts`; a theme file may name a bundled Shiki theme instead. The one exception is the Files pane's editor, CodeMirror 6, which highlights with its own Lezer grammars in the same colors, the code theme's rules turned into a CodeMirror highlight style, and loads with dynamic `import()` the first time a file opens. Code, diffs and the terminal sit on the code block's surface (`--bg-code-block`), in the Files pane too; tool-call previews use the diff library's bar indicators and row styling, while the Files pane lays the `--diff-*` tints over its rows and marks changes in `--code-success` and `--code-danger`. The composer's text box is a CodeMirror 6 editor too, with no highlighting: it draws the Markdown being typed, parsed with `@lezer/markdown`, and loads with the app, since the composer shows at launch.
- **Terminal**: render terminals with xterm.js and its fit, webgl and web-links addons, imported with dynamic `import()` the first time a terminal opens. Pseudo-terminals live only in the terminal host, through `node-pty`; main and the renderer never spawn a shell.
- **Text**: every word the interface shows goes through i18next, in English and Simplified Chinese, with keys in `src/shared/locales/<locale>/<namespace>.json`, with the same keys in both languages. Write whole sentences with placeholders, and call `useTranslation()` in each component that shows text.
- **State**: keep state in React when only one component or a small subtree needs it. State shared across the app lives in Zustand stores under `src/renderer/src/stores`, one store per domain. Read it through selectors such as `useSessionStore((s) => s.activeId)` so components re-render only when the values they use change.

## Dependencies

Libraries used only by the renderer go in `devDependencies`: Vite bundles them, while everything in `dependencies` is copied into the packaged app. Only modules a process loads at runtime instead of from the bundle belong in `dependencies`, such as `node-pty`, a native module the terminal host loads, and `electron-updater`, which main loads. `pnpm shadcn add` installs into `dependencies`, so move what it adds.
