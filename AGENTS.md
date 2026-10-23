# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this file, so edit this one and keep a single source of truth.

## Project

OverBench is an Electron desktop GUI for terminal coding agents: Claude Code, Codex CLI and opencode. It is in early development; [README.md](./README.md) has the product vision, features and roadmap.

OverBench is only a GUI: it implements no agent and talks to every agent over the Agent Client Protocol (ACP). Before you build anything, read [docs/architecture.md](./docs/architecture.md), the detailed design for the part you are touching (all of them are listed in [docs/README.md](./docs/README.md)), and the current milestone plan, [docs/milestones/m0.md](./docs/milestones/m0.md). Implement what the design says; when the design turns out wrong or incomplete, update the document in the same change, following the rules in `docs/README.md`.

## Workflow

Every change goes through an issue and a pull request, as [docs/workflow.md](./docs/workflow.md) describes; read it before you start. In short:

- One issue, one session, one worktree, one branch, one pull request. Branch from the latest `origin/main`; the main checkout stays on a clean `main`.
- Never push to `main`. Open a draft pull request after your first push, and mark it ready once the definition of done holds.
- Search for an existing issue before you file one. A bug you find on the side becomes its own issue, not part of your pull request.
- The gates are the maintainer's: accepting, designs, merging, closing without a merged pull request, and releasing. Ask at each, and report every issue, pull request and comment you create, with its link.

## Core philosophy: beauty is productivity (颜值也是生产力)

OverBench takes the best implementations already proven in leading projects, integrates them into one workbench, and then pushes them further, with performance optimized to the limit and a UI polished to the limit. Judge every change on all three.

1. **Start from the best existing implementation.** Before building a feature, study how the strongest projects solve it. Read their source, not only their screenshots, and adopt the best approach instead of inventing one from scratch. In your summary, name the projects you drew on and what you took from each.
2. **Then go further.** Integration is the starting point, not the goal. Drop what the original did not need, fix its rough edges, and make it faster and better looking than where it came from.
3. **Optimize to the limit.**
   - Never block the main process: no synchronous file system, child process or network calls there. Move heavy work off the UI thread.
   - Keep the renderer smooth: stream agent output incrementally, virtualize long lists (sessions, transcripts, diffs), and subscribe to Zustand through narrow selectors so a change re-renders only what uses it.
   - Never animate properties that trigger layout, except disclosures as the design system describes. Prefer `transform` and `opacity`, and hold the display's frame rate (60 Hz, or 120 Hz on ProMotion displays).
   - Keep startup fast: load heavy modules (syntax highlighting, diff engines, terminals) lazily with dynamic `import()`.
   - Measure before and after with the DevTools Performance panel. An optimization without a measurement is a guess.
4. **Polish the UI to the limit.**
   - Every design goes through the design rules first: [visual style](./docs/design/visual-style.md) for how it looks, [UX guidelines](./docs/design/ux-guidelines.md) for how it behaves, and the steps of the [design process](./docs/design/design-process.md). A design that breaks a rule does not ship; the rule changes first, with the maintainer's agreement. A case the rules do not cover is decided and written into them before it is built.
   - Design every state: loading (`Skeleton`), empty (`Empty`), error, and hover, focus, active and disabled.
   - Check every screen in both light and dark themes, at small and large window sizes.
   - Take colors, radii, sizes and timings from the tokens in the [design system](./docs/design/design-system.md); no raw colors or magic numbers.
   - Motion is purposeful and restrained, and always honors reduce-motion. Micro-interactions are CSS; Motion handles springs, layout, exits and gestures.
   - The first desktop version benchmarks Claude Desktop. Take its principles and measurements from the design system, never its brand assets or the reconstructed code in the reference.
   - Respect platform conventions: macOS traffic lights and `Cmd` shortcuts, `Ctrl` on Windows and Linux.

### Reusing code from other projects

- Check the license first. Code under MIT, BSD, ISC or Apache-2.0 may be adapted: keep its copyright and license notice, and add a one-line comment with the source URL.
- OverBench is licensed under Apache-2.0, so code under GPL or AGPL cannot be reused. Ask the maintainer before reusing LGPL or MPL code, or code without a license.
- When a maintained package already does the job, prefer depending on it over copying it, subject to the dependency rules below.

## Tech stack

Electron 44, electron-vite 6 (Vite 8), React 19, TypeScript 6 in strict mode, Tailwind CSS v4, pnpm 10, electron-builder. TypeScript stays on 6.0 until typescript-eslint supports 7.

Approved for M0 and installed by the work package that first needs them: `@agentclientprotocol/sdk` for ACP (protocol v1 through the SDK's `unstable` entrypoint, whose schema carries the subagent updates; nothing unstable beyond the exceptions listed in [protocol version](./docs/architecture.md#protocol-version)) and Vitest for tests, both from M0.1; xterm.js (`@xterm/xterm` with its fit, webgl and web-links addons) and `node-pty` for the terminal, and `electron-updater` for updates, all from M0.5; `@fontsource-variable/jetbrains-mono` for the mono face, approved 2026-10-22 and installed when the code is aligned with the [type scale](./docs/design/design-system.md#type-scale).

Approved beyond M0: `react-day-picker`, which shadcn/ui's `Calendar` needs, for the [usage page](./docs/design/usage.md#interface)'s date range picker, approved 2026-10-22 and installed with that page; `@fontsource-variable/source-serif-4` for the New session heading, approved 2026-10-23 ([#127](https://github.com/overbench/overbench/issues/127)).

### UI stack: one library per concern

| Concern                     | Library                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Components and visual style | shadcn/ui, `base-nova` style on Base UI                            |
| Icons                       | Lucide (`lucide-react`)                                            |
| Animation                   | Motion (`motion/react`)                                            |
| Resizable layout            | react-resizable-panels, through `components/ui/resizable.tsx`      |
| Drag and drop               | dnd-kit, the new `@dnd-kit/react` API only                         |
| State management            | Zustand, stores in `src/renderer/src/stores`, one store per domain |
| Markdown                    | Streamdown, with `@streamdown/code` and `@streamdown/cjk` (M0.3)   |
| Syntax highlighting         | Shiki (M0.3)                                                       |
| Diffs                       | `@pierre/diffs` (M0.3)                                             |
| Code editing                | CodeMirror 6 (`codemirror`), the Files pane's editor               |
| Terminal                    | xterm.js in the renderer, `node-pty` in the terminal host (M0.5)   |
| Localization                | i18next with react-i18next, catalogs in `src/shared/locales`       |

Never add a library that overlaps one of these. The detailed usage rules are in [CONTRIBUTING.md](./CONTRIBUTING.md); read it before UI work.

## Architecture

The top of the tree is below; [docs/architecture.md](./docs/architecture.md#directory-layout) describes each process in detail.

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

`pnpm dev` keeps its data in a folder of its own, `OverBench Dev`, so it never touches the installed app's sessions and can run beside it. To run several worktrees at once, give each its own folder and debugging port, such as `OVERBENCH_USER_DATA=/tmp/overbench-feature-x REMOTE_DEBUGGING_PORT=9223 pnpm dev` (set the variables as your shell does on Windows). Electron's `--user-data-dir` is not needed; see [persistence](./docs/design/persistence.md#what-is-stored-and-where).

## Definition of done

- `pnpm format:check`, `pnpm lint` and `pnpm typecheck` pass. Also run `pnpm build` when you touch config, the main process or the preload.
- For UI changes, walk the [visual](./docs/design/visual-style.md#checklist) and [UX](./docs/design/ux-guidelines.md#checklist) checklists, and run the app and look at the result in light and dark themes before reporting the work as done. In development, `REMOTE_DEBUGGING_PORT=9222 pnpm dev` exposes the renderer over the Chrome DevTools Protocol for inspection and screenshots.
- Once M0.1 adds Vitest, `pnpm test` must pass too, and logic you add or change comes with tests as described in [docs/design/testing.md](./docs/design/testing.md).

## Conventions

- **Formatting**: Prettier (single quotes, no semicolons, 100 columns) and ESLint own the style; do not format against them.
- **Imports**: use the `@renderer/*` and `@shared/*` aliases instead of deep relative paths.
- **Comments**: English and ASCII only, and only when they say what the code cannot, such as the reason for a workaround or an edge case. No commented-out code.
- **Dependencies**: ask the maintainer before adding any. Renderer-only libraries go in `devDependencies` because Vite bundles them; only modules a process loads at runtime instead of from the bundle, such as `node-pty` and `electron-updater`, go in `dependencies`. `pnpm shadcn add` installs into `dependencies`, so move what it adds.
- **Docs**: `README.md` and `README.zh-CN.md` are kept in sync; change both together. Design docs under `docs/` follow the maintenance rules in `docs/README.md`.
- **Git**: Conventional Commits 1.0.0 in English, with an imperative subject of at most 50 characters and a body that explains why. No tool-generated trailers or attribution lines. Branches are `<type>/<issue>-<slug>` in kebab-case, such as `fix/123-model-menu-close`. A pull request's title follows the same subject rules, because the squash merge makes it the commit on `main`; its description is a sentence or two, `Closes #N` and how it was checked, with no headings.
- **Language**: talk to the maintainer in Simplified Chinese. Everything written into the repository is English (code, comments, commits, pull requests), except Chinese product copy and `README.zh-CN.md`.

## Gotchas

- shadcn/ui here is built on Base UI, not Radix: components take a `render` prop instead of `asChild`. To make a link look like a button, put `buttonVariants()` on a plain `<a>` rather than `<Button render={<a />}>`.
- `BACKGROUND_COLOR` in `src/main/window.ts` must match `--background` in `globals.css`, or the window flashes on load.
- On macOS the title bar is hidden: the top header is the drag region (`app-region-drag`) and leaves room for the traffic lights. Give interactive elements inside it `app-region-no-drag`.
- `@dnd-kit/react` is still 0.x; read its changelog before bumping the minor version, and never mix in the legacy `@dnd-kit/core` packages.
- Enter-to-send handlers must ignore IME composition (`event.nativeEvent.isComposing`, or `keyCode` 229), or Chinese, Japanese and Korean input sends half-typed text.
- macOS, Windows and Linux are equal targets. Code that spawns processes, resolves executables or compares paths follows the platform rules in [docs/design/agent-host.md](./docs/design/agent-host.md#platform-differences).
