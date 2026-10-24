# Contributing to OverBench

Thanks for helping shape OverBench.

## How to contribute

OverBench takes issues from outside, not code: fixes and features are written by the project, and pull requests are opened by collaborators only ([why](./docs/workflow.md#outside-contributions)).

- **Bugs and ideas**: open an issue through the [issue forms](https://github.com/overbench/overbench/issues/new/choose), in any language. A screenshot helps.
- **Security problems**: follow [SECURITY.md](./SECURITY.md); never post them in a public issue.

## Run from source

You need Node.js 22.13 or later and pnpm 10:

```bash
pnpm install
pnpm dev
```

`pnpm dev` keeps its data in its own folder, `OverBench Dev`, so it never touches the sessions of an installed OverBench. To run several worktrees at once, give each one a folder of its own with `OVERBENCH_USER_DATA`, such as `OVERBENCH_USER_DATA=/tmp/overbench-feature-x pnpm dev`; a second run on the same folder quits ([persistence](./docs/design/persistence.md#what-is-stored-and-where)).

Development builds also list a **Fake agent**, which needs no account or network and plays scripted scenarios such as a long answer, a burst of tool calls or three approvals at once. Type `/` in its composer to see them, or read the [fake agent](./docs/design/testing.md#fake-agent) docs.

| Command                                               | What it does                                         |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                            | Start the app in development mode with hot reload    |
| `pnpm test`                                           | Run the unit, integration and process tests          |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`        | Lint, type-check and format the code                 |
| `pnpm build`                                          | Type-check and build the app into `out/`             |
| `pnpm package`                                        | Build an unpacked app into `dist/` for local testing |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | Build installers for each platform                   |

Packaging on macOS also needs Xcode 26 or later, whose `actool` compiles the [app icon](./docs/design/brand.md#app-icons).

The [architecture](./docs/architecture.md) explains how the pieces fit, and the [M0 plan](./docs/milestones/m0.md) lists what is in and out of the first milestone.

## Project work

For the maintainer and the coding agents. Every change goes through an issue and a pull request, as [docs/workflow.md](./docs/workflow.md) describes. Before a pull request leaves draft, make sure these pass:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

The design documents in [docs/](./docs/README.md) describe how each part is meant to work; read the one for the part you change. Any UI work follows the [design process](./docs/design/design-process.md) and the rules in [visual style](./docs/design/visual-style.md) and [UX guidelines](./docs/design/ux-guidelines.md).

## UI stack

Each concern has exactly one library. Build with these instead of adding an alternative; if one of them really does not fit, open an issue first.

| Concern                     | Library                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Components and visual style | [shadcn/ui](https://ui.shadcn.com), `base-nova` style on Base UI                                                      |
| Icons                       | [Lucide](https://lucide.dev) (`lucide-react`)                                                                         |
| Animation                   | [Motion](https://motion.dev) (`motion/react`)                                                                         |
| Resizable layout            | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels), through the shadcn `Resizable` component |
| Drag and drop               | [dnd-kit](https://dndkit.com) (`@dnd-kit/react`)                                                                      |
| State management            | [Zustand](https://zustand.docs.pmnd.rs)                                                                               |
| Markdown                    | [Streamdown](https://streamdown.ai), with `@streamdown/code` and `@streamdown/cjk` (from M0.3)                        |
| Syntax highlighting         | [Shiki](https://shiki.style) (from M0.3)                                                                              |
| Diffs                       | [Diffs](https://diffs.com) (`@pierre/diffs`, from M0.3)                                                               |
| Code editing                | [CodeMirror 6](https://codemirror.net) (`codemirror`), in the Files pane                                              |
| Terminal                    | [xterm.js](https://xtermjs.org) (`@xterm/xterm`) in the renderer, `node-pty` in the terminal host (from M0.5)         |
| Localization                | [i18next](https://www.i18next.com) with [react-i18next](https://react.i18next.com)                                    |

- **Components**: add shadcn components with `pnpm shadcn add <component>` rather than writing them by hand; they land in `src/renderer/src/components/ui`. Reach for their variants before custom classes, and style with semantic tokens such as `bg-background` and `text-muted-foreground`, never raw colors, so the light and dark themes stay consistent. Radii, sizes and timings come from the [design system](./docs/design/design-system.md) tokens as well. Class names are merged by `cn`, which must know the theme's own tokens (`text-ui`, `shadow-card`) to tell a size from a color: its tables in `lib/cn-tables.ts` are compiled from the `@theme` in `globals.css`, and the build points the `cn` import the shadcn CLI writes at `lib/utils`. `pnpm dev` and `pnpm build` regenerate the tables, and `pnpm test` fails until a changed file is committed.
- **Icons**: import Lucide icons as components, e.g. `import { SearchIcon } from 'lucide-react'`. Do not mix in other icon sets or inline SVGs for UI icons, and never draw an icon by hand. Every icon takes the stroke width that `LucideProvider` sets in `main.tsx`; do not pass `strokeWidth` at a call site. File and folder types are the one exception: they use `FileTypeIcon`, from Material Icon Theme ([design system: file icons](./docs/design/design-system.md#file-icons)).
- **Animation**: hover, press, focus, color and opacity changes, enter-only effects and looping indicators are CSS; they run on the compositor and cost no JavaScript per frame. Use what the stack already provides, timed with the motion tokens: tw-animate-css's `animate-in` utilities, shadcn's `shimmer` and `scroll-fade` utilities, `Collapsible`, `Skeleton` and `Spinner`. Write a keyframe of your own only where none of them fits, and record why in the design system. Use Motion for springs, layout and shared-element animations, gestures, and elements leaving the tree (`AnimatePresence`). The enter and exit transitions that ship with shadcn components (tw-animate-css) stay as they are. Reduce-motion is honored by the root `<MotionConfig reducedMotion="user">` and by the `prefers-reduced-motion` block in `globals.css`; do not bypass either. The [design system](./docs/design/design-system.md#motion) says which pattern to use where.
- **Layout**: build split and resizable layouts from `ResizablePanelGroup`, `ResizablePanel` and `ResizableHandle` in `components/ui/resizable.tsx`.
- **Drag and drop**: use `@dnd-kit/react`, the current dnd-kit API, not the legacy `@dnd-kit/core` and `@dnd-kit/sortable` packages. It is still on 0.x, so read its changelog before bumping the minor version.
- **Markdown**: render agent text with Streamdown, in `streaming` mode while it streams and `static` mode afterwards, with `skipHtml` on. Never render agent output with `dangerouslySetInnerHTML`.
- **Code and diffs**: highlight only with Shiki, through the shadcn `code-block` component, Streamdown's code plugin and `@pierre/diffs`. Render diffs with `@pierre/diffs` and its worker pool. The one exception is the Files pane's editor, CodeMirror 6, which highlights with its own Lezer grammars in GitHub's colours (`@uiw/codemirror-theme-github`) and loads with dynamic `import()` the first time a file opens ([Files](./docs/design/ui.md#files)).
- **Terminal**: render terminals with xterm.js and its fit, webgl and web-links addons, imported with dynamic `import()` the first time a terminal opens. Pseudo-terminals live only in the terminal host, through `node-pty`; main and the renderer never spawn a shell ([terminal design](./docs/design/terminal.md)).
- **Text**: every word the interface shows goes through i18next, in English and Simplified Chinese, with keys in `src/shared/locales/<locale>/<namespace>.json`; `pnpm test` fails when the two languages differ. Write whole sentences with placeholders, call `useTranslation()` in each component that shows text, and follow the [localization design](./docs/design/localization.md#writing-messages) and its Chinese glossary.
- **State**: keep state in React when only one component or a small subtree needs it. State shared across the app lives in Zustand stores under `src/renderer/src/stores`, one store per domain. Read it through selectors such as `useSessionStore((s) => s.activeId)` so components re-render only when the values they use change.

## Dependencies

Libraries used only by the renderer go in `devDependencies`: Vite bundles them, while everything in `dependencies` is copied into the packaged app. Only modules a process loads at runtime instead of from the bundle belong in `dependencies`, such as `node-pty`, a native module the terminal host loads, and `electron-updater`, which main loads. `pnpm shadcn add` installs into `dependencies`, so move what it adds.
