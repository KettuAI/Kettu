<div align="center">

# OverBench

**A calm desktop workbench for terminal coding agents.**

Claude Code, Codex CLI and opencode side by side in one window,<br>
with readable threads, clear approvals, git and a terminal beside every session.

[**Download**](https://github.com/overbench/overbench/releases/latest) · [Docs](./docs/README.md) · [简体中文](./README.zh-CN.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/screenshot-dark.webp">
  <img src="./docs/images/screenshot-light.webp" alt="OverBench showing a Claude Code session that fixed a bug and asks to run the tests, with Codex and opencode sessions in the sidebar">
</picture>

> [!NOTE]
> v0.0.1 is the first preview. It is built from the first milestone, M0, which is still in acceptance, so expect rough edges and please [report them](https://github.com/overbench/overbench/issues).

## Features

- **Every agent, one window** — Claude Code, Codex CLI and opencode sessions side by side in the same project. The sidebar shows which are running, which wait for you and which are done, with subagents under their parent.
- **Threads that read well** — answers stream as Markdown with highlighted code, edits show as inline diffs, and a run of steps folds into one line. Queue your next message while the agent works, or steer it mid-turn.
- **Approvals at a glance** — permission requests are cards you answer with a click or a number key, and a system notification tells you when a session needs you.
- **Each agent's own controls** — mode, model and reasoning, slash commands, context usage and, where the agent reports them, your plan limits.
- **Sessions that last** — every session is kept with its project, reopens with its full history, survives an agent crash, and can be imported from the agent.
- **Git, files and a terminal** — the branch, sync state and changes in the top bar, pull requests with their checks through the GitHub CLI, a files pane to read and edit files, and a terminal for each project.
- **Crafted details** — light and dark themes, English and Simplified Chinese, restrained motion that honors reduce motion, and shortcuts for the common actions.

## Install

Download the installer for your system from [Releases](https://github.com/overbench/overbench/releases/latest). Preview builds are not signed by Apple or Microsoft yet, so your system asks once before the first launch.

- **macOS** (Apple silicon): open `OverBench-<version>-arm64.dmg` and drag OverBench to Applications. When macOS says it cannot verify the app, open System Settings › Privacy & Security and choose **Open Anyway**. Builds for Intel Macs are not available yet.
- **Windows** (x64): run `OverBench-<version>-setup.exe`. When SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.
- **Linux** (x64): make `OverBench-<version>-x86_64.AppImage` executable with `chmod +x`, then run it. AppImages need FUSE 2: `libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and later.

On Windows and Linux, new versions download in the background and install when OverBench restarts; on macOS, OverBench links to the download until its builds are signed.

### Agents

OverBench drives the agent CLIs you already use, with your installation, your account and your configuration. Install at least one of them first; you sign in with each agent's own flow, so OverBench never sees your credentials.

| Agent                                                    | How OverBench runs it                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Claude Code](https://github.com/anthropics/claude-code) | The ACP adapter `@agentclientprotocol/claude-agent-acp`, installed on first use |
| [Codex CLI](https://github.com/openai/codex)             | The ACP adapter `@agentclientprotocol/codex-acp`, installed on first use        |
| [opencode](https://opencode.ai)                          | Your installed `opencode`, as `opencode acp`                                    |

The two adapters need Node.js 22 or later with npm, which OverBench finds through your login shell.

## Why OverBench

Terminal coding agents can plan, edit and test code on their own, yet working with them still means walls of scrolling text and sessions scattered across tabs. OverBench gives them a home built for long working days. It is only the interface: it implements no agent itself and talks to each one over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), so you keep the agents exactly as you set them up.

It rests on one belief, **beauty is productivity**:

- **Start from the best.** Study the strongest implementations of each piece, from terminals to diff viewers, and bring them together instead of reinventing them.
- **Optimize to the limit.** Quick to start and smooth through the longest transcript, with no dropped frames.
- **Polish to the limit.** A clear hierarchy, calm typography and restrained motion, so you see what the agent changed faster than in any scrollback.

## Roadmap

- [x] Claude Code, Codex CLI and opencode over ACP
- [x] Session history, parallel sessions and sub-sessions
- [x] Git status, pull requests, files and a built-in terminal
- [x] Preview builds for macOS, Windows and Linux
- [ ] M0 accepted on all three platforms
- [ ] A changes panel for reviewing diffs
- [ ] `@` file mentions and images in the composer
- [ ] Search across sessions and a command palette
- [ ] Signed and notarized builds

The [M0 plan](./docs/milestones/m0.md) lists what is in and out, and the [architecture](./docs/architecture.md) explains how the pieces fit.

## Run from source

You need Node.js 22.13 or later and pnpm 10:

```bash
pnpm install
pnpm dev
```

Development builds also list a **Fake agent**, which needs no account or network and plays scripted scenarios such as a long answer, a burst of tool calls or three approvals at once. Type `/` in its composer to see them, or read the [fake agent](./docs/design/testing.md#fake-agent) docs.

| Command                                               | What it does                                         |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                            | Start the app in development mode with hot reload    |
| `pnpm test`                                           | Run the unit, integration and process tests          |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`        | Lint, type-check and format the code                 |
| `pnpm build`                                          | Type-check and build the app into `out/`             |
| `pnpm package`                                        | Build an unpacked app into `dist/` for local testing |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | Build installers for each platform                   |

## Contributing

Early feedback shapes OverBench the most, and ideas about design and workflow are especially welcome: open an [issue](https://github.com/overbench/overbench/issues) to start the conversation. Before sending code, read [CONTRIBUTING.md](./CONTRIBUTING.md) for the UI stack and project conventions.

---

<sub>OverBench is an independent project and is not affiliated with or endorsed by the makers of the agents it supports. All product names are trademarks of their respective owners.</sub>
