<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/lockup-horizontal-dark.svg">
    <img src="./assets/lockup-horizontal.svg" alt="Kettu" width="300">
  </picture>
</h1>

[![版本](https://img.shields.io/github/v/release/KettuAI/Kettu?include_prereleases&label=%E7%89%88%E6%9C%AC&style=flat-square&labelColor=3f3f46&color=fa5615)](https://github.com/KettuAI/Kettu/releases/latest)
[![下载量](https://img.shields.io/github/downloads/KettuAI/Kettu/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F&style=flat-square&labelColor=3f3f46&color=15803d)](https://github.com/KettuAI/Kettu/releases)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%7C%20Windows%20%7C%20Linux-2563eb?style=flat-square&labelColor=3f3f46)](https://github.com/KettuAI/Kettu/releases/latest)
[![Agent](https://img.shields.io/badge/Agent-46-0f766e?style=flat-square&labelColor=3f3f46)](#-支持的-agent)
[![许可证](https://img.shields.io/github/license/KettuAI/Kettu?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&style=flat-square&labelColor=3f3f46&color=71717a)](./LICENSE)

<h3>颜值也是生产力。</h3>

你所有的编码 Agent，并排在一个窗口里。

[**下载**](https://github.com/KettuAI/Kettu/releases/latest) · [官网](https://www.kettu.sh/zh-CN/) · [文档](https://www.kettu.sh/zh-CN/docs/) · [路线图](./ROADMAP.zh-CN.md) · [反馈](https://github.com/KettuAI/Kettu/issues/new/choose) · [English](./README.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/screenshot-dark.webp">
  <img src="./assets/screenshot-light.webp" alt="Kettu 界面：Codex 会话修好了 streak 的 bug，正在请求运行测试，侧边栏里还有另一个 Codex 会话和一个 OpenCode 会话">
</picture>

> [!NOTE]
> Kettu 还是早期预览版，变化很快，欢迎[反馈问题](https://github.com/KettuAI/Kettu/issues)。

## ✨ 功能

### 💬 Agent 与会话

- 🤖 **46 个 Agent**：Claude Code、Codex、OpenCode、Pi 等，用你自己的安装、账号和设置。
- 🗂️ **并行会话**：侧边栏标出哪个在干活、哪个在等你、哪个做完了。
- ✅ **一键授权**：Agent 要运行命令或改文件时，按一个键允许或拒绝。
- ❓ **问题卡片**：Agent 的多个问题在一张卡片里逐个回答。
- 📋 **计划**：Agent 的计划和进度显示在顶栏。
- 🧩 **子 Agent**：显示在父会话下面，它的请求也在那里回答。
- 📨 **排队和插话**：Agent 干活时，下一条消息可以排队，也可以中途插话。
- 📎 **附件**：粘贴图片，附加文件和文件夹，用 `@` 引用项目文件。
- 🌿 **分叉**：从任意一条回复分出新会话。
- 🔔 **通知**：会话需要你时提醒你。
- 📊 **用量**：按天、模型和项目统计 token 和费用；Agent 提供时，还显示套餐额度还剩多少。

### 🛠️ 工作台

- 📝 **Diff**：Agent 改了哪些文件、改了什么，一目了然。
- 📁 **文件**：用标签页查看、预览和编辑项目文件。
- 🖥️ **终端**：每个会话都有自己的终端。
- 🔀 **Git**：分支、改动和 Pull Request 的检查状态。
- 🌐 **内置浏览器**：Agent 能打开页面、点击、输入和截图，你随时可以接手。
- 🖼️ **Artifacts**：Agent 做的网页、文档和幻灯片，可以留言让 Agent 改、自己编辑，或导出成 Word 和 PowerPoint。
- ⏰ **Routines**：按时让 Agent 干活，每次运行都留成会话。
- 🔎 **搜索**：在一个命令面板里搜会话、Artifacts、Routines、项目、设置和操作。

### 📱 多设备

- 📱 **手机和平板**：扫码配对，在浏览器里继续你的会话，不用装 App。
- 💻 **另一台电脑**：在另一台电脑的 Kettu 里用这台电脑上的会话。
- 🗄️ **开发机**：填 SSH 地址就能加进来。
- 🔐 **端到端加密**：直接走你自己的网络。

### 🎨 外观

- 🌗 浅色和深色模式、主题、简体中文和英文、macOS 毛玻璃侧边栏。

### 🚧 即将推出

- 🦾 **Computer use**：Agent 操作你电脑上的应用。
- 📲 **iOS 和 Android 模拟器**：模拟器画面放进 Kettu，你和 Agent 都能操作。

## 🔒 隐私

- 🛡️ 不收集遥测，会话、代码和文件都留在你自己的电脑上。
- 🔑 不保留 Agent 的登录凭据。
- 👤 登录 Kettu 账号是可选的。

## 📦 安装

从 [Releases](https://github.com/KettuAI/Kettu/releases/latest) 下载：

- 🍎 **macOS**（Apple 芯片）：`.dmg`
- 🪟 **Windows**：`setup.exe`。还没有签名，SmartScreen 提示时点「更多信息」，再点「仍要运行」。
- 🐧 **Linux**：`.AppImage`，加上执行权限后运行；需要 FUSE 2（`libfuse2`，Ubuntu 24.04 起为 `libfuse2t64`）。

服务器或开发机（[文档](https://www.kettu.sh/zh-CN/docs/devices/daemon/)）：

```sh
curl -fsSL https://kettu.sh/install | sh
```

## 🤖 支持的 Agent

<details>
<summary><b>全部 46 个 Agent</b></summary>

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

缺了你在用的 Agent？[告诉我们](https://github.com/KettuAI/Kettu/issues/new/choose)。

## 💬 反馈

欢迎提 [Issue](https://github.com/KettuAI/Kettu/issues/new/choose)，用什么语言都行。安全问题请按 [SECURITY.md](./SECURITY.md) 报告。想自己构建，请看 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 📄 许可证

[Apache-2.0](./LICENSE)
