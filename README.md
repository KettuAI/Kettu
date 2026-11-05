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

All your coding agents, side by side in one window that is a pleasure to work in.<br>
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

Coding agents like Claude Code, Codex and OpenCode can now plan a change, write the code and run the tests on their own. In a terminal, though, working with them means reading walls of scrolling text, watching for approvals that are easy to miss and hunting for sessions across tabs and windows.

Kettu gives that work a home. Every agent you use sits side by side in one window, replies read like well-set documents, and when an agent needs you, it asks in a card you answer with one key.

A tool you spend whole days in should be a pleasure to look at. That is what Kettu is built on: when everything is clear and calm, you see what the agent did sooner and get on with your work.

## Highlights

- **All your agents, one window.** Claude Code, Codex, OpenCode, Pi and 42 more agents work side by side, and the sidebar shows which session is working, which one is waiting for you and which one is done.
- **Easy to read.** Replies are laid out like documents, with highlighted code and images in place, and the small steps fold away. What the agent changed shows as a clear diff, and its plan shows its progress in the top bar.
- **One key to answer.** When an agent wants to run a command or change a file, you see exactly what it will do and answer with one key. A notification tells you when a session needs you, and Kettu never answers for you.
- **Know where you stand.** See the tokens and cost of every agent by day, model and project, and, for the agents that report them, how much of each plan's limits is left.
- **Everything at hand.** A terminal, Git, your files and a browser sit right beside the session, so you rarely need to leave.
- **Artifacts.** The pages, documents and slides an agent makes are kept in one place, with every version. Comment on a part for the agent to change, edit it yourself, and export documents and slides to Word and PowerPoint.
- **Routines.** Give an agent a task to run on a schedule, such as sorting last night's issues every morning; every run is kept for you to read later.
- **On your other devices.** Pair a phone, a tablet or another computer and carry on with your sessions there, end-to-end encrypted, straight over your own network. In a browser, there is nothing to install.
- **Crafted details.** Light and dark modes, themes, English and Simplified Chinese, the frosted macOS sidebar and calm motion throughout.

## Your agents, your data

- **The agents you already use.** Kettu runs the agents you have installed and signed in to, with your own accounts and settings, so they work just as they do in your terminal. If one is missing, Kettu can install it for you.
- **Your data stays with you.** Kettu collects no telemetry. Your sessions, code and files stay on your own computers, and a Kettu account is optional.
- **Free and open source.** Kettu costs nothing, and its code is right here under the Apache-2.0 license.

## Install

Download the installer for your system from [Releases](https://github.com/KettuAI/Kettu/releases/latest).

- **macOS** (Apple silicon): open the `.dmg` and drag Kettu to Applications.
- **Windows**: run the `setup.exe` for your PC, x64 or Arm. Windows builds are not signed yet, so when SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.
- **Linux**: make the `.AppImage` for your PC, x86_64 or Arm, executable and run it. It needs FUSE 2: `libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and later.

Kettu keeps itself up to date: new versions download in the background and install when you quit.

**On a server or a development machine?** Install Kettu there with one command, or add the machine from the desktop app in **Settings › Hosts** by its SSH address. See the [docs](https://www.kettu.sh/docs/devices/daemon/).

```sh
curl -fsSL https://kettu.sh/install | sh
```

**On your phone or another computer?** Turn on **Settings › Remote access**, click **Add device…** and scan the code. See [remote access](https://www.kettu.sh/docs/devices/remote-access/).

## Get started

1. **Add your agents** in **Settings › Agents**. Kettu uses the ones you have installed, and installs a missing one with one click in **Settings › Harnesses**.
2. **Start a session**: pick a project and an agent, then say what you want done.
3. **Keep an eye on it** from the sidebar, and answer with one key when it asks.

The [docs](https://www.kettu.sh/docs/) walk through every part of the app.

## Agents

Kettu works with 46 agents today, each with its own account and settings.

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

Kettu is young, and early feedback shapes it the most; ideas about design and how you work are especially welcome. Open an [issue](https://github.com/KettuAI/Kettu/issues/new/choose) to report a bug or start a conversation, in any language; a screenshot helps. Security problems go through [SECURITY.md](./SECURITY.md), never a public issue.

Want to build Kettu yourself? [CONTRIBUTING.md](./CONTRIBUTING.md) has the setup.

## License

Kettu is released under the [Apache-2.0 license](./LICENSE).
