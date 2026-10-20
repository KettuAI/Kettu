<div align="center">

# OverBench

**A beautifully crafted desktop workbench for terminal coding agents.**

Claude Code · Codex CLI · opencode — one window, one calm workflow.

_Beauty is productivity._

[![Status](https://img.shields.io/badge/status-early%20development-orange?style=flat-square)](#roadmap)
[![Electron](https://img.shields.io/badge/built%20with-Electron-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](#roadmap)

**English** · [简体中文](./README.zh-CN.md)

</div>

> [!NOTE]
> OverBench is in early development and has no release yet. Everything below describes where the project is headed, not what ships today.

## Why OverBench

Terminal coding agents can now plan, edit and test code on their own. The way we work with them, though, still looks like a terminal: walls of scrolling text, diffs read line by line in monospace, sessions scattered across tabs and windows.

OverBench gives these agents a home built for long working days, and it rests on one belief: **beauty is productivity**. In practice that means three things:

- **Start from the best.** The best tools out there have already solved pieces of this problem: a great terminal here, a great diff viewer there, a smart session model somewhere else. OverBench does not reinvent them. It studies the strongest implementations and brings the best of each together in one workbench.
- **Optimize to the limit.** Bringing them together is only the starting point. Every piece is then tuned until it is fast: quick to start, smooth through the longest transcripts, with no dropped frames.
- **Polish to the limit.** Every piece is also reworked until it looks and feels right, because how a tool looks and feels is part of how well it works. A clear visual hierarchy shows you what the agent changed faster than any scrollback, calm typography, colors and motion keep you focused for hours, and a well-designed review flow surfaces the mistakes a terminal buries.

Design in OverBench is not decoration on top of the tool. It is the tool.

## Supported agents

OverBench works with the agent CLIs you already use: your installation, your account, your configuration.

| Agent                                                    | Status  |
| -------------------------------------------------------- | ------- |
| [Claude Code](https://github.com/anthropics/claude-code) | Planned |
| [Codex CLI](https://github.com/openai/codex)             | Planned |
| [opencode](https://opencode.ai)                          | Planned |

## Features

> Planned for the first releases.

- **Every agent, one workbench** — run Claude Code, Codex CLI and opencode side by side, and switch agents without switching tools.
- **Sessions organized by project** — every conversation kept, searchable and resumable, grouped by the project it belongs to.
- **Review diffs, not scrollback** — the agent's edits rendered as real side-by-side or inline diffs, file by file.
- **Readable approvals** — tool calls and permission requests shown as clear, structured cards you can approve with confidence.
- **Parallel sessions** — several agents working across projects at once, with status that shows at a glance what is running, what is waiting for you and what is done.
- **Keyboard first** — a command palette and shortcuts for everything, so the mouse stays optional.
- **Crafted details** — considered typography, polished light and dark themes, and restrained motion that never gets in the way.

## Design principles

1. **Beauty is productivity.** Visual quality is a feature, with the same weight as functionality. A screen that is pleasant to look at for eight hours is a screen you work better in.
2. **Clarity before density.** Show what the decision at hand needs, and keep the rest one step away.
3. **Make the agent's work legible.** What it plans, what it runs and what it changes should be visible at a glance and easy to review.
4. **Feel native.** Fast to start, smooth to use and respectful of each platform's conventions, even though it is built on Electron.
5. **Stay out of the way.** The agent does the work. OverBench makes that work visible and controllable, then steps aside.

## Roadmap

- [ ] App shell and design system
- [ ] Claude Code integration
- [ ] Codex CLI integration
- [ ] opencode integration
- [ ] Session history and search
- [ ] Diff review
- [ ] Multi-project, multi-session workspace
- [ ] Preview builds for macOS, Windows and Linux

## Getting started

There is no release to install yet; star or watch the repository to follow along. To run OverBench from source you need Node.js 22.12 or later and pnpm 10:

```bash
pnpm install
pnpm dev
```

| Command                                               | What it does                                         |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                            | Start the app in development mode with hot reload    |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`        | Lint, type-check and format the code                 |
| `pnpm build`                                          | Type-check and build the app into `out/`             |
| `pnpm package`                                        | Build an unpacked app into `dist/` for local testing |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | Build installers for each platform                   |

Built with Electron, electron-vite, React, TypeScript, Tailwind CSS and shadcn/ui. The source is split by Electron process:

```text
src/
├── main/       Main process: app lifecycle, windows, IPC handlers
├── preload/    Bridge exposed to the renderer as window.overbench
├── renderer/   React UI
└── shared/     Types shared across processes, such as IPC contracts
```

## Contributing

OverBench is taking shape, and early feedback shapes it the most. Ideas about design and workflow are especially welcome: open an [issue](https://github.com/overbench/overbench/issues) to start the conversation. Before sending code, read [CONTRIBUTING.md](./CONTRIBUTING.md) for the UI stack and project conventions.

---

<sub>OverBench is an independent project and is not affiliated with or endorsed by the makers of the agents it supports. All product names are trademarks of their respective owners.</sub>
