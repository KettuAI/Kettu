# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this file, so edit this one and keep a single source of truth.

## Project

OverBench is an Electron desktop GUI for terminal coding agents: Claude Code, Codex CLI and opencode. It is in early development; [README.md](./README.md) has the product vision and features, and [ROADMAP.md](./ROADMAP.md) the plans.

OverBench is only a GUI: it implements no agent and talks to every agent over the Agent Client Protocol (ACP).

## Engineering rules

### Performance

- Never block the main process: no synchronous file system, child process or network calls there. Move heavy work off the UI thread.
- Keep the renderer smooth: stream agent output incrementally, virtualize long lists (sessions, transcripts, diffs), and subscribe to Zustand through narrow selectors so a change re-renders only what uses it.
- Never animate properties that trigger layout, except disclosures. Prefer `transform` and `opacity`, and hold the display's frame rate (60 Hz, or 120 Hz on ProMotion displays).
- Keep startup fast: load heavy modules (syntax highlighting, diff engines, terminals) lazily with dynamic `import()`.
- Measure before and after with the DevTools Performance panel. An optimization without a measurement is a guess.

### Interface

- Design every state: loading (`Skeleton`), empty (`Empty`), error, and hover, focus, active and disabled.
- Check every screen in both light and dark themes, at small and large window sizes.
- Take colors, radii, sizes and timings from the theme tokens in `src/renderer/src/styles/tokens.css` and `globals.css`; no raw colors or magic numbers. `pnpm lint` rejects a color literal outside the tokens.
- Motion is purposeful and restrained, and always honors reduce-motion. Micro-interactions are CSS; Motion handles springs, layout, exits and gestures.
- Respect platform conventions: macOS traffic lights and `Cmd` shortcuts, `Ctrl` on Windows and Linux.

### Reusing code from other projects

- Check the license first. Code under MIT, BSD, ISC or Apache-2.0 may be adapted: keep its copyright and license notice, and add a one-line comment with the source URL.
- OverBench is licensed under Apache-2.0, so code under GPL or AGPL cannot be reused. Ask the maintainer before reusing LGPL or MPL code, or code without a license.
- When a maintained package already does the job, prefer depending on it over copying it, subject to the dependency rules below.

## Tech stack

Electron 44, electron-vite 6 (Vite 8), React 19, TypeScript 6 in strict mode, Tailwind CSS v4, pnpm 10, electron-builder. TypeScript stays on 6.0 until typescript-eslint supports 7.

Beyond the UI stack: `@agentclientprotocol/sdk` for ACP (protocol v1 through the SDK's `unstable` entrypoint, whose schema carries the subagent updates), `@modelcontextprotocol/sdk` for the artifacts service's MCP server, `electron-updater` for updates, Vitest for tests, `react-day-picker` for the usage page's date range picker, and the Inter and Source Serif 4 faces from `@fontsource-variable`.

### UI stack: one library per concern

| Concern                     | Library                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Components and visual style | shadcn/ui, `base-nova` style on Base UI                            |
| Icons                       | Lucide (`lucide-react`)                                            |
| Animation                   | Motion (`motion/react`)                                            |
| Resizable layout            | react-resizable-panels, through `components/ui/resizable.tsx`      |
| Drag and drop               | dnd-kit, the new `@dnd-kit/react` API only                         |
| State management            | Zustand, stores in `src/renderer/src/stores`, one store per domain |
| Markdown                    | Streamdown, with `@streamdown/code` and `@streamdown/cjk`          |
| Syntax highlighting         | Shiki                                                              |
| Diffs                       | `@pierre/diffs`                                                    |
| Code editing                | CodeMirror 6 (`codemirror`), the Files pane's editor               |
| Terminal                    | xterm.js in the renderer, `node-pty` in the terminal host          |
| Localization                | i18next with react-i18next, catalogs in `src/shared/locales`       |

Never add a library that overlaps one of these. The detailed usage rules are in [CONTRIBUTING.md](./CONTRIBUTING.md); read it before UI work.

## Architecture

The top of the tree:

```text
src/
├── main/              Main process: lifecycle, windows, menus, IPC, settings, updates
├── preload/           Sandboxed bridge exposed as window.overbench
├── agent-host/        Utility process: agents over ACP, sessions, projects, git
├── terminal-host/     Utility process: the terminal's shells through node-pty
├── renderer/src/      React UI
│   ├── app/           Bootstrap, actions, shortcuts, menu commands
│   ├── features/      One folder per area: session, sidebar, settings, git, terminal, ...
│   ├── stores/        Zustand stores, one per domain
│   ├── components/ui  shadcn/ui components (managed by the shadcn CLI)
│   ├── lib/           Helpers (cn, format, host requests)
│   └── styles/        globals.css: Tailwind entry and theme tokens
└── shared/            Shared across processes: the IPC and host contracts, the thread model
tools/
├── fake-agent/        Scripted ACP agent for development, tests and perf runs
├── perf/              The performance script and its CI runner
├── screenshots/       Captures the main screens on each platform
├── workflow/          The pull request check and the release check CI runs
└── launch.mjs         Starts a production build for perf and screenshots
```

### Adding an IPC call

1. Declare the channel in `IpcInvokeContract` and the method in `OverbenchApi`, both in `src/shared/ipc.ts`. Channel names are `domain:action` in kebab-case, e.g. `app:get-info`.
2. Register the handler in `src/main/ipc.ts` with `handle()`, which rejects senders outside the app.
3. Expose the method in `src/preload/index.ts` through `invoke()`.

### Security rules

OverBench drives agents that run shell commands, so these are not negotiable:

- Keep `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`.
- Never expose `ipcRenderer` or Node APIs to the renderer; expose narrow, typed methods only.
- Treat every IPC argument as untrusted input and validate it in the main process.
- Keep the permission handlers in `src/main/permissions.ts`: the clipboard is the only web permission granted, and only to the app's own page. Add another only with a stated reason.
- Navigation away from the app and new windows stay blocked; external `http(s)` links open in the system browser.
- The sandboxed preload can only `require('electron')`. Bundled source and type-only imports from `@shared` are fine; Node built-ins and npm packages are not.
- Do not loosen the CSP in `src/renderer/index.html` without a stated reason.

## Commands

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | Run the app with hot reload               |
| `pnpm format:check` | Check formatting (`pnpm format` fixes it) |
| `pnpm lint`         | ESLint                                    |
| `pnpm typecheck`    | Type-check main, preload and renderer     |
| `pnpm build`        | Type-check and build into `out/`          |
| `pnpm package`      | Build an unpacked app into `dist/`        |
| `pnpm shadcn add x` | Add a shadcn/ui component                 |

`pnpm dev` keeps its data in a folder of its own, `OverBench Dev`, so it never touches the installed app's sessions and can run beside it. To run several worktrees at once, give each its own folder and debugging port, such as `OVERBENCH_USER_DATA=/tmp/overbench-feature-x REMOTE_DEBUGGING_PORT=9223 pnpm dev` (set the variables as your shell does on Windows). Electron's `--user-data-dir` is not needed.

## Definition of done

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. Also run `pnpm build` when you touch config, the main process or the preload.
- Logic you add or change comes with tests; a bug fix starts with a test that fails.
- CI checks pull requests on Linux only; Windows and macOS run in the release run before each release. A change that may behave differently by platform, such as spawning processes, paths, shells, native modules or packaging, runs the Release workflow on its branch before it is marked ready (`gh workflow run release.yml --ref <branch>`).
- For UI changes, run the app and look at the result in light and dark themes before reporting the work as done. In development, `REMOTE_DEBUGGING_PORT=9222 pnpm dev` exposes the renderer over the Chrome DevTools Protocol for inspection and screenshots.

## Conventions

- **Formatting**: Prettier (single quotes, no semicolons, 100 columns) and ESLint own the style; do not format against them.
- **Imports**: use the `@renderer/*` and `@shared/*` aliases instead of deep relative paths.
- **Comments**: English and ASCII only, and only when they say what the code cannot, such as the reason for a workaround or an edge case. No commented-out code.
- **Dependencies**: ask the maintainer before adding any. Renderer-only libraries go in `devDependencies` because Vite bundles them; only modules a process loads at runtime instead of from the bundle, such as `node-pty` and `electron-updater`, go in `dependencies`. `pnpm shadcn add` installs into `dependencies`, so move what it adds.
- **Docs**: `README.md` and `README.zh-CN.md` are kept in sync, and so are `ROADMAP.md` and `ROADMAP.zh-CN.md`; change both of a pair together. The README is for users; setup and commands live in `CONTRIBUTING.md`, and plans in the roadmap, which follows the GitHub milestones.
- **Git**: Conventional Commits 1.0.0 in English, with an imperative subject of at most 50 characters and a body that explains why. No tool-generated trailers or attribution lines. Branches are `<type>/<issue>-<slug>` in kebab-case, such as `fix/123-model-menu-close`. A pull request's title follows the same subject rules, because the squash merge makes it the commit on `main`; its description is a sentence or two, `Closes #N` and how it was checked, with no headings.
- **Language**: everything written into the repository is English (code, comments, commits, pull requests), except Chinese product copy, `README.zh-CN.md` and `ROADMAP.zh-CN.md`.

## Gotchas

- shadcn/ui here is built on Base UI, not Radix: components take a `render` prop instead of `asChild`. To make a link look like a button, put `buttonVariants()` on a plain `<a>` rather than `<Button render={<a />}>`.
- `BACKGROUND_COLOR` in `src/main/window.ts` must match `--background` in `globals.css`, or the window flashes on load.
- On macOS the title bar is hidden: the top header is the drag region (`app-region-drag`) and leaves room for the traffic lights. Give interactive elements inside it `app-region-no-drag`.
- `@dnd-kit/react` is still 0.x; read its changelog before bumping the minor version, and never mix in the legacy `@dnd-kit/core` packages.
- Enter-to-send handlers must ignore IME composition (`event.nativeEvent.isComposing`, or `keyCode` 229), or Chinese, Japanese and Korean input sends half-typed text.
- macOS, Windows and Linux are equal targets. Code that spawns processes, resolves executables or compares paths handles each: a minimal `PATH` when the app starts from the macOS or Linux desktop, `PATHEXT` and `.cmd` shims on Windows, and paths compared only after `path.resolve` and `fs.realpath.native`, case-insensitively on Windows.
