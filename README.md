<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/lockup-horizontal-dark.svg">
    <img src="./assets/lockup-horizontal.svg" alt="Kettu" width="300">
  </picture>
</h1>

[![Release](https://img.shields.io/github/v/release/KettuAI/Kettu?include_prereleases&label=release&style=flat-square&labelColor=3f3f46&color=fa5615)](https://github.com/KettuAI/Kettu/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/KettuAI/Kettu/total?label=downloads&style=flat-square&labelColor=3f3f46&color=15803d)](https://github.com/KettuAI/Kettu/releases)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-2563eb?style=flat-square&labelColor=3f3f46)](#install)
[![Agents](https://img.shields.io/badge/agents-46-0f766e?style=flat-square&labelColor=3f3f46)](#agents)
[![License](https://img.shields.io/github/license/KettuAI/Kettu?style=flat-square&labelColor=3f3f46&color=71717a)](./LICENSE)

<h3>Beauty is productivity.</h3>

All your coding agents, side by side in one window that looks good and feels right.

[**Download**](https://github.com/KettuAI/Kettu/releases/latest) · [Website](https://www.kettu.sh) · [Docs](https://www.kettu.sh/docs/) · [Roadmap](./ROADMAP.md) · [Feedback](https://github.com/KettuAI/Kettu/issues/new/choose) · [简体中文](./README.zh-CN.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/screenshot-dark.webp">
  <img src="./assets/screenshot-light.webp" alt="Kettu with a Codex session that fixed a streak bug and asks to run the tests, while a Claude Code session works and others wait for you in the sidebar">
</picture>

> [!NOTE]
> Kettu is an early preview. The desktop app has found its shape, and its details still change quickly. Please [report](https://github.com/KettuAI/Kettu/issues) what you find.

## Features

### Agents and sessions

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/feature-sessions-dark.webp">
  <img src="./assets/feature-sessions-light.webp" alt="Two Codex sessions side by side: one asks which day the week starts on in a question card, the other has finished a dark mode with one changed file">
</picture>

- **46 agents**: Claude Code, Codex, OpenCode, Pi and more, with your own installs, accounts and settings. Turn one off without losing its sessions.
- **Side by side**: run sessions in parallel and split the window into up to nine panes. The sidebar shows which one is working, which one is waiting for you and which one is done.
- **One-key approvals**: when an agent wants to run a command or change a file, see what it touches, then allow or deny it with one key.
- **Question cards**: an agent's questions in one card, answered one by one and sent together.
- **Plans**: the agent's plan and progress sit in the top bar.
- **Switch agents**: hand a session to another agent between turns, and the conversation carries over.
- **Subagents**: shown under their parent session, where you answer their requests too.
- **Queue and steer**: while an agent works, queue your next message or steer it mid-turn.
- **Reply to a passage**: select part of a reply and answer just that.
- **Attachments**: paste images, attach files and folders, or mention a project file with `@`.
- **Forks**: branch a new session off any reply, even while the agent is still working.
- **Pull requests and issues**: GitHub links in replies show their current state, and a session's pull requests show in the sidebar.
- **Notifications**: know when a session needs you.
- **Usage**: tokens and cost by day, model and project, and each account's plan limits as rings.

### Workbench

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/feature-workbench-dark.webp">
  <img src="./assets/feature-workbench-light.webp" alt="A Codex session beside the canvas editor, which shows the weekly habit report the agent made">
</picture>

- **Diffs**: see which files the agent changed and how.
- **Files**: read, preview and edit project files in tabs.
- **Terminal**: every session has its own.
- **Git**: the branch, changes and pull request checks.
- **Built-in browser**: agents open pages, click, type and take screenshots; take over at any time.
- **Artifacts**: the pages, documents, slides and canvases agents make. Lay out a canvas's frames and mark them up for the agent, comment, edit them yourself, or export them to Word and PowerPoint.
- **Publish to Kettu**: give an artifact its own page on kettu.page, private, behind an access code or public.
- **Computer use**: once you turn it on, agents use the apps on your computer.
- **Routines**: run an agent on a schedule; every run is kept as a session.
- **Search**: one command palette for sessions, artifacts, routines, projects, settings and actions.

### Mobile devices

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/feature-mobile-dark.webp">
  <img src="./assets/feature-mobile-light.webp" alt="Codex drives an iPhone 17 simulator beside its session to check a page in dark mode, with Take over above the device">
</picture>

- **Right beside the session**: iOS simulators, Android emulators and real iPhones and Android phones, each in a frame with its hardware buttons.
- **For you and the agent**: tap, swipe and type on the screen yourself, or let the agent open apps and pages, tap, type, switch between light and dark and take screenshots. Take over at any time.
- **Ready for app work**: the agent installs your build, launches it and reads its logs.

### Everywhere

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/feature-devices-dark.webp">
  <img src="./assets/feature-devices-light.webp" alt="The same session open on the desktop and in a phone's browser, with the phone shown in the top bar">
</picture>

- **Any browser, any network**: open [app.kettu.sh](https://app.kettu.sh) and reach your computers through the Kettu relay, with no VPN and no open port.
- **Your own network**: pair a phone, tablet or browser with a QR code and carry on over Wi-Fi, a VPN or an SSH forward, without an account.
- **Another computer**: use this computer's sessions from Kettu on another one.
- **Development machines**: add one by its SSH address, and Kettu sets itself up there.
- **End-to-end encrypted**: nothing in between can read your sessions, the relay included.

### Looks

- Light and dark modes that follow your system and fade across the whole window at once, themes from the catalog or your own, English and Simplified Chinese, and the frosted macOS sidebar.

### Coming soon

- **iPhone and iPad app**: your sessions in your pocket, with requests answered from the lock screen.
- **Notifications on your phone**: know when a session needs you while you are away.

## Privacy

- No telemetry. Your sessions, code and files stay on your own computers.
- Kettu keeps no copy of your agents' credentials.
- A Kettu account is optional. Everything on your own computers and network works without one; signing in adds the relay, app.kettu.sh, publishing to kettu.page and problem reports.
- A problem report leaves your computer only when you send it.

## Install

Download from [Releases](https://github.com/KettuAI/Kettu/releases/latest):

- **macOS** (Apple silicon): the `.dmg`
- **Windows** (x64 and Arm): the `setup.exe`. It is not signed yet, so when SmartScreen appears, choose **More info**, then **Run anyway**.
- **Linux** (x64 and Arm): the `.AppImage`; make it executable and run it. It needs FUSE 2 (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and later).

In a browser: [app.kettu.sh](https://app.kettu.sh), signed in to the same Kettu account as Kettu on your computer.

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

Open an [issue](https://github.com/KettuAI/Kettu/issues/new/choose) in any language, or send a report from **Help › Report a Problem…** in the app. Security problems go through [SECURITY.md](./SECURITY.md). To build Kettu yourself, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[AGPL-3.0](./LICENSE), with an [additional permission](./LICENSE-EXCEPTION) for the affectUI components in `src/renderer/src/components/affect`, which stay under [affectUI's license](https://www.affectui.com/license).
