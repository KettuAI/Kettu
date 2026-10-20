# Contributing to OverBench

Thanks for helping shape OverBench. For setup and the available scripts, see [Getting started](./README.md#getting-started).

## Before you open a pull request

Make sure these pass:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
```

From M0.1 on, `pnpm test` must pass as well. The design documents in [docs/](./docs/README.md) describe how each part is meant to work; read the one for the part you change.

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

- **Components**: add shadcn components with `pnpm shadcn add <component>` rather than writing them by hand; they land in `src/renderer/src/components/ui`. Reach for their variants before custom classes, and style with semantic tokens such as `bg-background` and `text-muted-foreground`, never raw colors, so the light and dark themes stay consistent. Radii, sizes and timings come from the [design system](./docs/design/design-system.md) tokens as well.
- **Icons**: import Lucide icons as components, e.g. `import { SearchIcon } from 'lucide-react'`. Do not mix in other icon sets or inline SVGs for UI icons.
- **Animation**: hover, press, focus, color and opacity changes, enter-only effects and looping indicators are CSS transitions and keyframes built on the motion tokens; they run on the compositor and cost no JavaScript per frame. Use Motion for springs, layout and shared-element animations, gestures, and elements leaving the tree (`AnimatePresence`). The enter and exit transitions that ship with shadcn components (tw-animate-css) stay as they are. Reduce-motion is honored by the root `<MotionConfig reducedMotion="user">` and by the `prefers-reduced-motion` block in `globals.css`; do not bypass either. The [design system](./docs/design/design-system.md#motion) says which pattern to use where.
- **Layout**: build split and resizable layouts from `ResizablePanelGroup`, `ResizablePanel` and `ResizableHandle` in `components/ui/resizable.tsx`.
- **Drag and drop**: use `@dnd-kit/react`, the current dnd-kit API, not the legacy `@dnd-kit/core` and `@dnd-kit/sortable` packages. It is still on 0.x, so read its changelog before bumping the minor version.
- **Markdown**: render agent text with Streamdown, in `streaming` mode while it streams and `static` mode afterwards, with `skipHtml` on. Never render agent output with `dangerouslySetInnerHTML`.
- **Code and diffs**: highlight only with Shiki, through the shadcn `code-block` component, Streamdown's code plugin and `@pierre/diffs`. Render diffs with `@pierre/diffs` and its worker pool.
- **State**: keep state in React when only one component or a small subtree needs it. State shared across the app lives in Zustand stores under `src/renderer/src/stores`, one store per domain. Read it through selectors such as `useSessionStore((s) => s.activeId)` so components re-render only when the values they use change.

## Dependencies

Libraries used only by the renderer go in `devDependencies`: Vite bundles them, while everything in `dependencies` is copied into the packaged app. Only modules the main process loads at runtime belong in `dependencies`. `pnpm shadcn add` installs into `dependencies`, so move what it adds.
