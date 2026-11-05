<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/lockup-horizontal-dark.svg">
    <img src="./assets/lockup-horizontal.svg" alt="Kettu" width="300">
  </picture>
</h1>

[![Release](https://img.shields.io/github/v/release/KettuAI/Kettu?include_prereleases&label=release&style=flat-square&labelColor=555555&color=2563eb)](https://github.com/KettuAI/Kettu/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/KettuAI/Kettu/total?label=downloads&style=flat-square&labelColor=555555&color=15803d)](https://github.com/KettuAI/Kettu/releases)
[![Release build](https://img.shields.io/github/actions/workflow/status/KettuAI/Kettu/release.yml?branch=main&label=release%20build&style=flat-square&labelColor=555555)](https://github.com/KettuAI/Kettu/actions/workflows/release.yml)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-6d28d9?style=flat-square&labelColor=555555)](https://github.com/KettuAI/Kettu/releases/latest)
[![Agents](https://img.shields.io/badge/agents-46-0f766e?style=flat-square&labelColor=555555)](#agents)
[![Website](https://img.shields.io/badge/website-kettu.sh-c2410c?style=flat-square&labelColor=555555)](https://www.kettu.sh)
[![Docs](https://img.shields.io/badge/docs-kettu.sh%2Fdocs-0369a1?style=flat-square&labelColor=555555)](https://www.kettu.sh/docs/)
[![License](https://img.shields.io/github/license/KettuAI/Kettu?style=flat-square&labelColor=555555&color=b45309)](./LICENSE)

**Your coding agents, all in one window.**

Claude Code, Codex, OpenCode, Pi and 42 more agents side by side, with your own installs, accounts and settings.<br>
See at a glance which one is working, which one is waiting for you and which one is done.

[**Download**](https://github.com/KettuAI/Kettu/releases/latest) · [Website](https://www.kettu.sh) · [Docs](https://www.kettu.sh/docs/) · [Roadmap](./ROADMAP.md) · [Feedback](https://github.com/KettuAI/Kettu/issues/new/choose) · [简体中文](./README.zh-CN.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/screenshot-dark.webp">
  <img src="./assets/screenshot-light.webp" alt="Kettu showing a Codex session that fixed a streak bug and asks to run the tests, with another Codex session and an OpenCode session in the sidebar">
</picture>

> [!NOTE]
> Kettu is an early preview that changes quickly, so expect rough edges and please [report them](https://github.com/KettuAI/Kettu/issues).

## What is Kettu

Coding agents like Claude Code, Codex and OpenCode can now plan a change, edit the code and run the tests on their own. Working with them in a terminal still means walls of scrolling text, approvals that are easy to miss, and sessions scattered across tabs, windows and machines.

Kettu is a desktop home for that work. Every agent you use opens side by side in one window, each session sits under its project, and the sidebar shows which agent is working, which one is waiting for you and which one is done. Answers read like documents instead of logs, what the agent changed is shown as a diff, and a request from an agent comes to you as a card you answer with one key.

It drives the agents you already have, with your own installation, account and settings, so nothing about how they work changes. And it goes where your work is: run it as a daemon on a development machine, and follow your sessions from another computer, a phone or any browser on your own network.

## Features

- **Every agent, one window** — Claude Code, Codex, OpenCode and the others side by side in the same project. The sidebar shows which sessions are running, which wait for you and which are done, with subagents under their parent; search them, pin the ones you come back to and archive the rest.
- **Threads that read well** — answers stream as Markdown with highlighted code, changed files open as diffs, images show in place, and a run of steps folds into one line. The agent's plan sits in the top bar with its progress. Reply to a passage you select, queue your next message while the agent works, or steer it mid-turn.
- **Approvals and questions at a glance** — permission requests are cards you answer with a click or a number key, an agent's questions come in one card you step through, and a notification tells you when a session needs you. Each agent starts new sessions in the permission mode you choose.
- **Attach anything** — paste images, attach files and folders, or mention a project file with `@`; the arrow keys bring back what you sent before.
- **Each agent's own controls** — mode, model and reasoning, slash commands, how full the context is, when the prompt cache expires and, where the agent reports them, your plan limits and balances.
- **Usage at a glance** — tokens, requests and cost across every agent by day, model and project, with each plan's limits.
- **Artifacts** — agents make pages, documents, slides and canvases through Kettu's built-in MCP service. Each one keeps its versions and opens in a viewer isolated from the app: comment on part of it for the agent, edit it yourself, export documents and slides to Word and PowerPoint, or share it by link.
- **Routines** — prompts that run on a schedule within a permission scope, pause near a plan limit and keep every run as a session.
- **Git, files, a terminal and a browser** — the branch, sync state and changes in the top bar, pull requests with their checks through the GitHub CLI, a files pane with tabs to read, preview and edit files, a terminal for each project, and a built-in browser that agents can drive and that keeps your sign-ins.
- **Sessions that last** — every session is kept with its project, reopens with its full history, survives an agent crash, forks from any reply and can be imported from the agent.
- **Your sessions on every device** — pair another computer, a phone or a tablet and work in your sessions there, end-to-end encrypted, straight over your own network: the same Wi-Fi, a VPN such as Tailscale, a forwarded port or SSH. A browser needs nothing installed, since Kettu serves the web client itself, and a development machine joins by its SSH address.
- **Crafted details** — light and dark modes, themes from a file or an online catalog, English and Simplified Chinese, the macOS sidebar material, restrained motion that honors reduce motion, shortcuts for the common actions, and a tray icon that keeps Kettu running after you close its window.

## Your agents, your data

- **Bring your own agents.** Kettu implements no agent of its own. It drives Claude Code through the Claude Agent SDK, Codex through `codex app-server` and every other agent over the open [Agent Client Protocol](https://agentclientprotocol.com) (ACP), so your models, settings, rules and tools stay exactly as you set them up.
- **Sign in where you always do.** Each agent signs in with its own flow, and Kettu keeps no copy of its credentials: an API key you set in Kettu goes straight to the agent.
- **Local by default.** Kettu collects no telemetry. Your sessions, code and files stay on your computers, each agent talks only to its own provider, as it does in your terminal, and the devices you pair connect straight to your computer. Signing in to a Kettu account is optional: nothing on your own computers and network needs one.

## Install

### Desktop app

Download the installer for your system from [Releases](https://github.com/KettuAI/Kettu/releases/latest). macOS builds are signed and notarized by Apple; Windows builds are not signed yet, so Windows asks once before the first launch.

- **macOS**: open `Kettu-<version>-arm64.dmg` and drag Kettu to Applications. Kettu needs a Mac with Apple silicon.
- **Windows**: run `Kettu-<version>-x64-setup.exe`, or `Kettu-<version>-arm64-setup.exe` on Arm. When SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.
- **Linux**: make `Kettu-x86_64.AppImage`, or `Kettu-arm64.AppImage` on Arm, executable with `chmod +x`, then run it. AppImages need FUSE 2: `libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and later.

New versions download in the background and install when you quit Kettu, or right away from the sidebar.

### Server or development machine

On a machine without a desktop, on Linux (x64 or Arm, with glibc 2.28 or later) or a Mac with Apple silicon, install Kettu as a daemon instead:

```sh
curl -fsSL https://kettu.sh/install | sh
```

It installs into your home without root and brings its own Node.js, checks the download against the release's checksum, links `~/.local/bin/kettu` and starts the daemon as a service with the system. `kettu pair` adds a device, and `kettu update` moves to a new release. In a container, pass `sh -s -- --no-service` and run `kettu run` instead. You can also add the machine from the desktop app, in **Settings › Hosts › Add host…** by its SSH address, and Kettu installs or updates the daemon there for you. See the [daemon](https://www.kettu.sh/docs/devices/daemon/) docs.

### Your other devices

Turn on **Settings › Remote access** and click **Add device…**. Scan the code with a phone or a tablet to open the web client in its browser, or paste the link into **Settings › Hosts** in Kettu on another computer. See [remote access](https://www.kettu.sh/docs/devices/remote-access/) and the [web client](https://www.kettu.sh/docs/devices/web-client/) in the docs.

## Agents

Kettu runs 46 agents. Add the ones you use in **Settings › Agents**, each with its own account and configuration. **Settings › Harnesses** shows the program each one runs on: Kettu uses your own copy when it finds one, and **Install** offers its maker's install, or the ACP Registry's archive, when it is missing.

<details>
<summary><b>All 46 agents and how Kettu runs them</b></summary>

| Agent                                                                               | How Kettu runs it                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Claude Code](https://github.com/anthropics/claude-code)                            | The Claude Agent SDK `@anthropic-ai/claude-agent-sdk`, installed on first use, running your installed `claude` |
| [Codex](https://github.com/openai/codex)                                            | Your installed `codex`, 0.166.0 or later, as `codex app-server`                                                |
| [OpenCode](https://opencode.ai)                                                     | Your installed `opencode`, as `opencode acp`                                                                   |
| [Pi](https://pi.dev)                                                                | The ACP adapter `pi-acp`, installed on first use, with your installed `pi`                                     |
| [fast-agent](https://fast-agent.ai)                                                 | The ACP package `fast-agent-acp`, run with `uvx` from your installed `uv`, with `-x`                           |
| [Minion Code](https://github.com/femto/minion-code)                                 | The ACP package `minion-code`, run with `uvx` from your installed `uv`, with `acp`                             |
| [Auggie CLI](https://github.com/augmentcode/auggie)                                 | The ACP package `@augmentcode/auggie`, installed on first use, with `--acp` and auto-update off                |
| [Codebuddy Code](https://www.codebuddy.cn/cli/)                                     | The ACP package `@tencent-ai/codebuddy-code`, installed on first use, with `--acp`                             |
| [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview)         | The ACP package `deepagents-acp`, installed on first use                                                       |
| [DimCode](https://dimagent.cn/)                                                     | The ACP package `dimcode`, installed on first use, with `acp`                                                  |
| [Dirac](https://dirac.run)                                                          | The ACP package `dirac-cli`, installed on first use, with `--acp`                                              |
| [GLM Agent](https://github.com/stefandevo/glm-acp-agent)                            | The ACP package `glm-acp-agent`, installed on first use                                                        |
| [Nova](https://www.compassap.ai/portfolio/nova.html)                                | The ACP package `@compass-ai/nova`, installed on first use, with `acp`                                         |
| [Qoder CLI](https://qoder.com)                                                      | The ACP package `@qoder-ai/qodercli`, installed on first use, with `--acp`                                     |
| [siGit Code](https://github.com/getsigit/sigit)                                     | The ACP package `@smbcloud/sigit`, installed on first use                                                      |
| [Agoragentic](https://agoragentic.com)                                              | The ACP package `agoragentic-mcp`, installed on first use, with `--acp`                                        |
| [Autohand Code](https://www.autohand.ai/cli/)                                       | The ACP package `@autohandai/autohand-acp`, installed on first use                                             |
| [Cursor](https://cursor.com/docs/cli/acp)                                           | Your installed `cursor-agent`, as `cursor-agent acp`, else the ACP Registry's archive                          |
| [Kimi Code CLI](https://moonshotai.github.io/kimi-cli/)                             | Your installed `kimi`, as `kimi acp`, else the ACP Registry's archive                                          |
| [Amp](https://ampcode.com)                                                          | Your installed `amp-acp` adapter, else the ACP Registry's archive                                              |
| [goose](https://block.github.io/goose/)                                             | Your installed `goose`, as `goose acp`, else the ACP Registry's archive                                        |
| [Kilo Code](https://kilo.ai)                                                        | Your installed `kilo`, as `kilo acp`, else the ACP Registry's archive                                          |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)                           | The ACP package `@google/gemini-cli`, installed on first use, with `--acp`                                     |
| [GitHub Copilot](https://github.com/github/copilot-cli)                             | The ACP package `@github/copilot`, installed on first use, with `--acp`                                        |
| [Qwen Code](https://github.com/QwenLM/qwen-code)                                    | The ACP package `@qwen-code/qwen-code`, installed on first use, with `--acp`                                   |
| [Grok](https://x.ai/cli)                                                            | The ACP package `@xai-official/grok`, installed on first use, with `agent stdio`                               |
| [Cline](https://cline.bot/cli)                                                      | The ACP package `cline`, installed on first use, with `--acp`                                                  |
| [Factory Droid](https://factory.ai/product/cli)                                     | The ACP package `droid`, installed on first use, with `exec --output-format acp-daemon` and self-updates off   |
| [OMP (Oh My Pi)](https://omp.sh)                                                    | Your installed `omp`, as `omp acp`                                                                             |
| [Hermes Agent](https://hermes-agent.nousresearch.com)                               | Your installed `hermes`, as `hermes acp`                                                                       |
| [Muse Code](https://dev.meta.ai)                                                    | Your installed `muse`, as `muse acp` with its experimental ACP mode, else the ACP Registry's archive           |
| [CodeWhale](https://codewhale.net)                                                  | Your installed `codewhale`, as `codewhale serve --acp` (a partial ACP adapter)                                 |
| [Bob](https://bob.ibm.com)                                                          | The ACP package `@ibm/bob`, installed on first use, with `acp`                                                 |
| [MiniMax Code](https://agent.minimax.io)                                            | The ACP package `@minimax-ai/code`, installed on first use, with `acp`                                         |
| [Harn](https://harnlang.com)                                                        | Your installed `harn`, as `harn serve acp`, else the ACP Registry's archive                                    |
| [Kimchi](https://kimchi.dev)                                                        | Your installed `kimchi`, as `kimchi --mode acp`, else the ACP Registry's archive                               |
| [Google Antigravity](https://antigravity.google)                                    | The ACP Registry's archive, as `agy_acp_server`                                                                |
| [Devin](https://docs.devin.ai/cli)                                                  | Your installed `devin`, as `devin acp`, else the ACP Registry's archive                                        |
| [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli) | Your installed `cortex`, as `cortex acp serve`, else the ACP Registry's archive                                |
| [Corust Agent](https://corust.ai)                                                   | The ACP Registry's archive, as `corust-agent-acp`                                                              |
| [crow-cli](https://github.com/crow-cli/crow-cli)                                    | Your installed `crow-cli`, as `crow-cli acp`, else the ACP Registry's archive                                  |
| [Junie](https://junie.jetbrains.com)                                                | Your installed `junie`, as `junie --acp=true`, else the ACP Registry's archive                                 |
| [Mistral Vibe](https://github.com/mistralai/mistral-vibe)                           | The ACP Registry's archive, as `vibe-acp`                                                                      |
| [Poolside](https://poolside.ai)                                                     | Your installed `pool`, as `pool acp`, else the ACP Registry's archive                                          |
| [Stakpak](https://stakpak.dev)                                                      | Your installed `stakpak`, as `stakpak acp`, else the ACP Registry's archive                                    |
| [VT Code](https://github.com/vinhnx/VTCode)                                         | Your installed `vtcode`, as `vtcode acp`, else the ACP Registry's archive                                      |

</details>

The Claude Agent SDK, the ACP packages and `pi-acp` install with your Node.js and npm, which Kettu finds through your login shell; fast-agent and Minion Code need [uv](https://docs.astral.sh/uv/) instead. An archive is downloaded only when you click **Install** in Settings › Harnesses. The [docs](https://www.kettu.sh/docs/agents/) say what Kettu installs, where it goes and how it updates.

## Why Kettu

It rests on one belief, **beauty is productivity**: a tool you spend whole days in should be a pleasure to look at, and that pleasure is what lets you work faster.

- **Start from the best.** Study the strongest implementations of each piece, from terminals to diff viewers, and bring them together instead of reinventing them.
- **Optimize to the limit.** Quick to start and smooth through the longest transcript, with no dropped frames.
- **Polish to the limit.** A clear hierarchy, calm typography and restrained motion, so you see what the agent changed faster than in any scrollback.

## Feedback

Early feedback shapes Kettu the most, and ideas about design and workflow are especially welcome. Open an [issue](https://github.com/KettuAI/Kettu/issues/new/choose) to report a bug or start a conversation, in any language; a screenshot helps. Security problems go through [SECURITY.md](./SECURITY.md), never a public issue.

The [docs](https://www.kettu.sh/docs/) explain every part of the app. Want to build Kettu yourself? [CONTRIBUTING.md](./CONTRIBUTING.md) has the setup.

## License

Kettu is released under the [Apache-2.0 license](./LICENSE).

---

<sub>Kettu is an independent project and is not affiliated with or endorsed by the makers of the agents it supports. All product names are trademarks of their respective owners.</sub>
