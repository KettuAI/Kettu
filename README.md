<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/lockup-horizontal-dark.svg">
    <img src="./assets/lockup-horizontal.svg" alt="Kettu" width="300">
  </picture>
</h1>

[![Release](https://img.shields.io/github/v/release/KettuAI/Kettu?include_prereleases&label=release&style=flat-square&labelColor=3f3f46&color=fa5615)](https://github.com/KettuAI/Kettu/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/KettuAI/Kettu/total?label=downloads&style=flat-square&labelColor=3f3f46&color=15803d)](https://github.com/KettuAI/Kettu/releases)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-2563eb?style=flat-square&labelColor=3f3f46)](https://github.com/KettuAI/Kettu/releases/latest)
[![Agents](https://img.shields.io/badge/agents-46-0f766e?style=flat-square&labelColor=3f3f46)](#agents)
[![License](https://img.shields.io/github/license/KettuAI/Kettu?style=flat-square&labelColor=3f3f46&color=71717a)](./LICENSE)

<h3>Beauty is productivity.</h3>

All your coding agents, side by side in one window.

[**Download**](https://github.com/KettuAI/Kettu/releases/latest) · [Website](https://www.kettu.sh) · [Docs](https://www.kettu.sh/docs/) · [Roadmap](./ROADMAP.md) · [Feedback](https://github.com/KettuAI/Kettu/issues/new/choose) · [简体中文](./README.zh-CN.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/screenshot-dark.webp">
  <img src="./assets/screenshot-light.webp" alt="Kettu showing a Codex session that fixed a streak bug and asks to run the tests, with another Codex session and an OpenCode session in the sidebar">
</picture>

> [!NOTE]
> Kettu is an early preview that changes quickly. Please [report](https://github.com/KettuAI/Kettu/issues) what you find.

## Features

### Agents and sessions

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/feature-sessions-dark.webp">
  <img src="./assets/feature-sessions-light.webp" alt="Claude Code asks two questions in one card while a Codex session works in the sidebar, with the plan in the top bar">
</picture>

- **46 agents**: Claude Code, Codex, OpenCode, Pi and more, with your own installs, accounts and settings.
- **Parallel sessions**: the sidebar shows which one is working, which one is waiting for you and which one is done.
- **One-key approvals**: when an agent wants to run a command or change a file, allow or deny it with one key.
- **Question cards**: answer an agent's questions one by one in a single card.
- **Plans**: the agent's plan and progress sit in the top bar.
- **Subagents**: shown under their parent session, where you answer their requests too.
- **Queue and steer**: while an agent works, queue your next message or steer it mid-turn.
- **Attachments**: paste images, attach files and folders, or mention a project file with `@`.
- **Forks**: branch a new session off any reply.
- **Notifications**: know when a session needs you.
- **Usage**: tokens and cost by day, model and project, and, where the agent reports it, how much of your plan is left.

### Workbench

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/feature-artifacts-dark.webp">
  <img src="./assets/feature-artifacts-light.webp" alt="A weekly habit report that an agent made, open in the Artifacts viewer with its version, Present and Share">
</picture>

- **Diffs**: see which files the agent changed and how.
- **Files**: read, preview and edit project files in tabs.
- **Terminal**: every session has its own.
- **Git**: the branch, changes and pull request checks.
- **Built-in browser**: agents open pages, click, type and take screenshots; take over at any time.
- **Artifacts**: pages, documents and slides the agent makes; comment for the agent to change them, edit them yourself, or export them to Word and PowerPoint.
- **Routines**: run an agent on a schedule; every run is kept as a session.
- **Search**: one command palette for sessions, artifacts, routines, projects, settings and actions.

### Other devices

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/feature-devices-dark.webp">
  <img src="./assets/feature-devices-light.webp" alt="The same session open on the desktop and on a phone, with the phone shown in the top bar">
</picture>

- **Phone and tablet**: pair with a QR code and carry on in the browser, with no app to install.
- **Another computer**: use this computer's sessions from Kettu on another one.
- **Development machines**: add one by its SSH address.
- **End-to-end encrypted**: straight over your own network.

### Looks

- Light and dark modes, themes, English and Simplified Chinese, the frosted macOS sidebar.

### Coming soon

- **Computer use**: agents operate the apps on your computer.
- **iOS Simulator and Android Emulator**: on screen in Kettu, for you and the agent to use.

## Privacy

- No telemetry. Your sessions, code and files stay on your own computers.
- Kettu keeps no copy of your agents' credentials.
- A Kettu account is optional.

## Install

Download from [Releases](https://github.com/KettuAI/Kettu/releases/latest):

- **macOS** (Apple silicon): the `.dmg`
- **Windows**: the `setup.exe`. It is not signed yet, so when SmartScreen appears, choose **More info**, then **Run anyway**.
- **Linux**: the `.AppImage`; make it executable and run it. It needs FUSE 2 (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and later).

On a server or development machine ([docs](https://www.kettu.sh/docs/devices/daemon/)):

```sh
curl -fsSL https://kettu.sh/install | sh
```

## Agents

<details>
<summary><b>All 46 agents</b></summary>

|                                                                             |                                                       |                                                                                     |                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Claude Code](https://github.com/anthropics/claude-code)                    | [Codex](https://github.com/openai/codex)              | [OpenCode](https://opencode.ai)                                                     | [Pi](https://pi.dev)                                     |
| [fast-agent](https://fast-agent.ai)                                         | [Minion Code](https://github.com/femto/minion-code)   | [Auggie CLI](https://github.com/augmentcode/auggie)                                 | [Codebuddy Code](https://www.codebuddy.cn/cli/)          |
| [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview) | [DimCode](https://dimagent.cn/)                       | [Dirac](https://dirac.run)                                                          | [GLM Agent](https://github.com/stefandevo/glm-acp-agent) |
| [Nova](https://www.compassap.ai/portfolio/nova.html)                        | [Qoder CLI](https://qoder.com)                        | [siGit Code](https://github.com/getsigit/sigit)                                     | [Agoragentic](https://agoragentic.com)                   |
| [Autohand Code](https://www.autohand.ai/cli/)                               | [Cursor](https://cursor.com/docs/cli/acp)             | [Kimi Code CLI](https://moonshotai.github.io/kimi-cli/)                             | [Amp](https://ampcode.com)                               |
| [goose](https://block.github.io/goose/)                                     | [Kilo Code](https://kilo.ai)                          | [Gemini CLI](https://github.com/google-gemini/gemini-cli)                           | [GitHub Copilot](https://github.com/github/copilot-cli)  |
| [Qwen Code](https://github.com/QwenLM/qwen-code)                            | [Grok](https://x.ai/cli)                              | [Cline](https://cline.bot/cli)                                                      | [Factory Droid](https://factory.ai/product/cli)          |
| [OMP (Oh My Pi)](https://omp.sh)                                            | [Hermes Agent](https://hermes-agent.nousresearch.com) | [Muse Code](https://dev.meta.ai)                                                    | [CodeWhale](https://codewhale.net)                       |
| [Bob](https://bob.ibm.com)                                                  | [MiniMax Code](https://agent.minimax.io)              | [Harn](https://harnlang.com)                                                        | [Kimchi](https://kimchi.dev)                             |
| [Google Antigravity](https://antigravity.google)                            | [Devin](https://docs.devin.ai/cli)                    | [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli) | [Corust Agent](https://corust.ai)                        |
| [crow-cli](https://github.com/crow-cli/crow-cli)                            | [Junie](https://junie.jetbrains.com)                  | [Mistral Vibe](https://github.com/mistralai/mistral-vibe)                           | [Poolside](https://poolside.ai)                          |
| [Stakpak](https://stakpak.dev)                                              | [VT Code](https://github.com/vinhnx/VTCode)           |                                                                                     |                                                          |

</details>

Missing an agent you use? [Tell us](https://github.com/KettuAI/Kettu/issues/new/choose).

## Feedback

Open an [issue](https://github.com/KettuAI/Kettu/issues/new/choose) in any language. Security problems go through [SECURITY.md](./SECURITY.md). To build Kettu yourself, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[AGPL-3.0](./LICENSE), with an [additional permission](./LICENSE-EXCEPTION) for the affectUI components in `src/renderer/src/components/affect`, which stay under [affectUI's license](https://www.affectui.com/license).
