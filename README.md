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
> OverBench is in early development. v0.0.1 is its first preview build, made from the first milestone, M0, while it is still in acceptance, so expect rough edges and please report them as [issues](https://github.com/overbench/overbench/issues). What is marked _later_ below is planned, not built.

## Why OverBench

Terminal coding agents can now plan, edit and test code on their own. The way we work with them, though, still looks like a terminal: walls of scrolling text, diffs read line by line in monospace, sessions scattered across tabs and windows.

OverBench gives these agents a home built for long working days, and it rests on one belief: **beauty is productivity**. In practice that means three things:

- **Start from the best.** The best tools out there have already solved pieces of this problem: a great terminal here, a great diff viewer there, a smart session model somewhere else. OverBench does not reinvent them. It studies the strongest implementations and brings the best of each together in one workbench.
- **Optimize to the limit.** Bringing them together is only the starting point. Every piece is then tuned until it is fast: quick to start, smooth through the longest transcripts, with no dropped frames.
- **Polish to the limit.** Every piece is also reworked until it looks and feels right, because how a tool looks and feels is part of how well it works. A clear visual hierarchy shows you what the agent changed faster than any scrollback, calm typography, colors and motion keep you focused for hours, and a well-designed review flow surfaces the mistakes a terminal buries.

Design in OverBench is not decoration on top of the tool. It is the tool.

## Supported agents

OverBench talks to every agent over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) and works with the agent CLIs you already use: your installation, your account, your configuration.

| Agent                                                    | How OverBench runs it                                                                    | Status |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| [Claude Code](https://github.com/anthropics/claude-code) | The ACP adapter `@agentclientprotocol/claude-agent-acp`, installed from npm on first use | M0     |
| [Codex CLI](https://github.com/openai/codex)             | The ACP adapter `@agentclientprotocol/codex-acp`, installed from npm on first use        | M0     |
| [opencode](https://opencode.ai)                          | Your installed `opencode`, as `opencode acp`                                             | M0     |

The Claude Code and Codex adapters need Node.js 22 or later with npm, which OverBench finds through your login shell; it installs each adapter once, on first use, into its own data folder. You sign in with each agent's own flow, so OverBench never sees your credentials.

## Features

What M0 delivers:

- **Every agent, one workbench** — start Claude Code, Codex CLI and opencode sessions side by side in the same project, and switch agents without switching tools.
- **Sessions organized by project** — every session is kept with its project, reopens with its full history and survives an agent crash; the sessions an agent already has for a project can be imported.
- **A thread that reads well** — answers stream as Markdown with highlighted code, and thoughts, plans, tool calls and their inline diffs show as quiet cards you can open.
- **Readable approvals** — permission requests are clear cards you answer with a click or the number keys, several at once when the agent asks in parallel.
- **Parallel sessions** — several sessions run at once; the sidebar shows which are running, which are waiting for you and which are done, with subagents under their parent, and a system notification tells you when one needs you while OverBench is in the background.
- **Each agent's own controls** — mode, model and reasoning selectors, slash commands, context usage and, where the agent reports them, your plan limits, which the sidebar also shows at a glance.
- **Git at a glance** — the branch, sync state and changes in the top bar, commits and pushes in the thread, and pull requests with their checks through the GitHub CLI.
- **A built-in terminal** — one per project, in a side panel beside the session, with tabs and your login shell.
- **Crafted details** — considered typography, light and dark themes, an interface in English or Simplified Chinese, restrained motion that honors reduce motion, and shortcuts for the common actions.

_Later_: a changes panel for reviewing diffs side by side, search across sessions, a command palette, `@` file mentions and images in the composer, and signed builds. The [M0 plan](./docs/milestones/m0.md#scope) lists what is in and out.

## Design principles

1. **Beauty is productivity.** Visual quality is a feature, with the same weight as functionality. A screen that is pleasant to look at for eight hours is a screen you work better in.
2. **Clarity before density.** Show what the decision at hand needs, and keep the rest one step away.
3. **Make the agent's work legible.** What it plans, what it runs and what it changes should be visible at a glance and easy to review.
4. **Feel native.** Fast to start, smooth to use and respectful of each platform's conventions, even though it is built on Electron.
5. **Stay out of the way.** The agent does the work. OverBench makes that work visible and controllable, then steps aside.

## Roadmap

The first milestone, M0, connects all three agents over ACP; it is implemented and in acceptance. See the [architecture](./docs/architecture.md), the [M0 plan](./docs/milestones/m0.md) and its [performance results](./docs/perf/m0.md).

- [x] App shell and design system
- [x] Claude Code, Codex CLI and opencode over ACP
- [x] Session history: reopening, crash recovery and import
- [x] Multi-project, multi-session workspace with sub-sessions
- [x] Git status, pull requests and a built-in terminal
- [ ] M0 accepted on macOS, Windows and Linux
- [ ] Preview builds for macOS, Windows and Linux
- [ ] Diff review in a changes panel
- [ ] Search across sessions

## Install

Download the installer for your system from [Releases](https://github.com/overbench/overbench/releases/latest). Preview builds are not signed by Apple or Microsoft yet, so your system asks once before the first launch.

| System                 | Download                              | First launch                                                                                                                    |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| macOS on Apple silicon | `OverBench-<version>-arm64.dmg`       | When macOS says it cannot verify the app, open System Settings › Privacy & Security and choose **Open Anyway**                  |
| Windows x64            | `OverBench-<version>-setup.exe`       | When SmartScreen says it protected your PC, choose **More info**, then **Run anyway**                                           |
| Linux x64              | `OverBench-<version>-x86_64.AppImage` | Make it executable with `chmod +x`, then run it; AppImages need FUSE 2 (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and later) |

Builds for Intel Macs are not available yet. OverBench runs the agent CLIs you already use, so install and sign in to at least one of them first; the Claude Code and Codex adapters also need Node.js 22 or later with npm, as described under [Supported agents](#supported-agents).

On Windows and Linux, OverBench downloads new versions in the background and installs them when it restarts. On macOS it tells you when a new version is out and links to its download, until its builds are signed.

## Run from source

To run OverBench from source you need Node.js 22.12 or later and pnpm 10:

```bash
pnpm install
pnpm dev
```

Development builds also list a **Fake agent**, which needs no account or network and plays scripted scenarios, such as a long answer, a burst of tool calls or three approvals at once. Type `/` in its composer to see them, or read the [fake agent](./docs/design/testing.md#fake-agent) docs.

| Command                                               | What it does                                         |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                            | Start the app in development mode with hot reload    |
| `pnpm test`                                           | Run the unit, integration and process tests          |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`        | Lint, type-check and format the code                 |
| `pnpm build`                                          | Type-check and build the app into `out/`             |
| `pnpm package`                                        | Build an unpacked app into `dist/` for local testing |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | Build installers for each platform                   |

Built with Electron, electron-vite, React, TypeScript, Tailwind CSS and shadcn/ui. The source is split by process:

```text
src/
├── main/            Main process: app lifecycle, windows, menus, IPC, updates
├── preload/         Bridge exposed to the renderer as window.overbench
├── agent-host/      Utility process that runs the agents over ACP and owns the sessions
├── terminal-host/   Utility process that runs the terminal's shells
├── renderer/        React UI
└── shared/          Types and logic shared across processes, such as the thread model
tools/
├── fake-agent/      A scripted ACP agent for tests, development and performance runs
└── perf/            The performance script
```

## Contributing

OverBench is taking shape, and early feedback shapes it the most. Ideas about design and workflow are especially welcome: open an [issue](https://github.com/overbench/overbench/issues) to start the conversation. Before sending code, read [CONTRIBUTING.md](./CONTRIBUTING.md) for the UI stack and project conventions.

---

<sub>OverBench is an independent project and is not affiliated with or endorsed by the makers of the agents it supports. All product names are trademarks of their respective owners.</sub>
