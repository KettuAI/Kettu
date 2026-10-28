<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/lockup-horizontal-dark.svg">
    <img src="./assets/lockup-horizontal.svg" alt="OverBench" width="300">
  </picture>
</h1>

[![版本](https://img.shields.io/github/v/release/overbench/overbench?include_prereleases&label=%E7%89%88%E6%9C%AC&style=flat-square&labelColor=555555&color=2563eb)](https://github.com/overbench/overbench/releases/latest)
[![下载量](https://img.shields.io/github/downloads/overbench/overbench/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F&style=flat-square&labelColor=555555&color=15803d)](https://github.com/overbench/overbench/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/overbench/overbench/release.yml?branch=main&label=CI&style=flat-square&labelColor=555555)](https://github.com/overbench/overbench/actions/workflows/release.yml)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%7C%20Windows%20%7C%20Linux-6d28d9?style=flat-square&labelColor=555555)](https://github.com/overbench/overbench/releases/latest)
[![Agent Client Protocol](https://img.shields.io/badge/%E5%8D%8F%E8%AE%AE-ACP-c2410c?style=flat-square&labelColor=555555)](https://agentclientprotocol.com)
[![许可证](https://img.shields.io/github/license/overbench/overbench?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&style=flat-square&labelColor=555555&color=b45309)](./LICENSE)

**为终端编码 Agent 打造的从容桌面工作台。**

Claude Code、Codex CLI 和 opencode 并排在同一个窗口里，<br>
好读的对话线程、清晰的授权请求，每个会话旁边都有 Git 和终端。

[**下载**](https://github.com/overbench/overbench/releases/latest) · [路线图](./ROADMAP.zh-CN.md) · [反馈](https://github.com/overbench/overbench/issues/new/choose) · [English](./README.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/screenshot-dark.webp">
  <img src="./assets/screenshot-light.webp" alt="OverBench 界面：Claude Code 会话修复了一个 bug，正在请求运行测试，侧边栏里还有 Codex 和 opencode 的会话">
</picture>

> [!NOTE]
> OverBench 目前是预览版，由仍在验收中的第一个里程碑 M0 构建而来，难免还有粗糙之处，欢迎[反馈问题](https://github.com/overbench/overbench/issues)。

## OverBench 是什么

Claude Code、Codex、opencode 这样的编码 Agent 已经能自己规划改动、修改代码、运行测试。但在终端里和它们协作，依然意味着不断滚动的文字墙、容易错过的授权请求，以及散落在各个标签页和窗口里的会话。

OverBench 为这些工作提供了一个桌面上的家。你用的每个 Agent 都并排在同一个窗口里，每个会话归在自己的项目下，哪个 Agent 在干活、哪个在等你、哪个已经做完，一眼就能看清。回答读起来像文档而不是日志，Agent 改了什么以 diff 呈现，Agent 有问题要问你时，会以卡片的形式出现，按一个键就能回答。

它驱动的是你已经在用的 Agent：你自己的安装、账号和配置，Agent 的工作方式一点都不会变，OverBench 只是给它们一个更好的工作环境。

## 功能

- **所有 Agent，一个窗口** —— 在同一个项目里并排开启 Claude Code、Codex CLI 和 opencode 会话。侧边栏标出哪些在运行、哪些在等你、哪些已完成，子 Agent 显示在父会话下；常用的会话可以置顶，做完的可以归档。
- **好读的对话线程** —— 回答以 Markdown 流式呈现，代码带语法高亮，改动以行内 diff 展示，Agent 提到的图片直接显示，连续的步骤折叠成一行。Agent 工作时可以排队下一条消息，也可以中途调整方向。
- **一眼看懂的授权请求** —— 权限请求以卡片呈现，点击或按数字键即可应答；有会话需要你时，系统通知会提醒你。
- **什么都能附上** —— 粘贴图片、附加文件和文件夹，或用 `@` 引用项目里的文件，第一条消息就可以。
- **Artifacts** —— Agent 通过 OverBench 内置的 artifacts 服务发布 HTML 页面和多页画布。每个都保留历史版本，在与应用隔离的查看器中打开，并汇总在 Artifacts 页面和新建会话页上。
- **每个 Agent 自己的控制项** —— 模式、模型与推理强度、斜杠命令、上下文用量、Prompt 缓存何时过期，以及 Agent 上报时显示的套餐额度。
- **用量一目了然** —— 按天、模型和项目统计所有 Agent 的 token 用量，并显示各套餐的额度；数据来自 OverBench 自己的记录，也可以选择读取 Agent 的本地日志。
- **会话不丢失** —— 每个会话都随项目保存，重新打开时带着完整历史，Agent 崩溃后也能恢复，还可以从 Agent 导入已有会话。
- **Git、文件与终端** —— 顶栏显示分支、同步状态和改动，通过 GitHub CLI 显示 Pull Request 及其检查状态，另有可以查看、预览和编辑文件的文件面板，每个项目一个内置终端。
- **打磨到细节** —— 浅色与深色主题、中英文界面、遵循「减少动态效果」的克制动效，以及常用操作的快捷键。

## 你的 Agent，你的数据

- **用你自己的 Agent。** OverBench 自己不实现任何 Agent，而是通过开放的 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）与每个 Agent 通信，你的模型、配置、规则和工具都保持你设置好的样子。
- **在原来的地方登录。** 每个 Agent 都用它自己的登录流程，OverBench 不会接触你的凭据。
- **默认只在本地。** OverBench 没有自己的账号和服务器，也不收集任何遥测数据。你的会话留在你的电脑上，每个 Agent 只和它自己的服务商通信，和你在终端里用它时一样。

## 安装

从 [Releases](https://github.com/overbench/overbench/releases/latest) 下载对应系统的安装包。预览版还没有经过 Apple 和 Microsoft 的签名，所以首次启动前系统会询问一次。

- **macOS**：Apple 芯片打开 `OverBench-<版本>-arm64.dmg`，Intel 芯片打开 `OverBench-<版本>-x64.dmg`，把 OverBench 拖进「应用程序」。macOS 提示无法验证该应用时，打开「系统设置 › 隐私与安全性」，点击「仍要打开」。
- **Windows**：运行 `OverBench-<版本>-x64-setup.exe`，Arm 设备运行 `OverBench-<版本>-arm64-setup.exe`。SmartScreen 提示「Windows 已保护你的电脑」时，点击「更多信息」，再点击「仍要运行」。
- **Linux**：用 `chmod +x` 给 `OverBench-x86_64.AppImage`（Arm 设备为 `OverBench-arm64.AppImage`）加上执行权限后运行。AppImage 需要 FUSE 2：`libfuse2`，Ubuntu 24.04 及以上为 `libfuse2t64`。

在 Windows 和 Linux 上，新版本会在后台下载，并在 OverBench 重启时安装；在 macOS 上，安装包完成签名之前，OverBench 会给出新版本的下载链接。v0.0.1 无法发现更新，请手动安装一次最新版本覆盖它。

### Agent

请先安装下面至少一个 Agent，OverBench 会在你的系统里找到它。

| Agent                                                                       | OverBench 如何运行它                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Claude Code](https://github.com/anthropics/claude-code)                    | ACP 适配器 `@agentclientprotocol/claude-agent-acp`，首次使用时安装          |
| [Codex CLI](https://github.com/openai/codex)                                | ACP 适配器 `@agentclientprotocol/codex-acp`，首次使用时安装                 |
| [opencode](https://opencode.ai)                                             | 你自己安装的 `opencode`，以 `opencode acp` 运行                             |
| [Pi](https://pi.dev)                                                        | ACP 适配器 `pi-acp`，首次使用时安装，并运行你自己安装的 `pi`                |
| [Auggie CLI](https://github.com/augmentcode/auggie)                         | ACP 包 `@augmentcode/auggie`，首次使用时安装，以 `--acp` 运行并关闭自动更新 |
| [Codebuddy Code](https://www.codebuddy.cn/cli/)                             | ACP 包 `@tencent-ai/codebuddy-code`，首次使用时安装，以 `--acp` 运行        |
| [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview) | ACP 包 `deepagents-acp`，首次使用时安装                                     |
| [DimCode](https://dimagent.cn/)                                             | ACP 包 `dimcode`，首次使用时安装，以 `acp` 运行                             |
| [Dirac](https://dirac.run)                                                  | ACP 包 `dirac-cli`，首次使用时安装，以 `--acp` 运行                         |
| [GLM Agent](https://github.com/stefandevo/glm-acp-agent)                    | ACP 包 `glm-acp-agent`，首次使用时安装                                      |
| [Nova](https://www.compassap.ai/portfolio/nova.html)                        | ACP 包 `@compass-ai/nova`，首次使用时安装，以 `acp` 运行                    |
| [Qoder CLI](https://qoder.com)                                              | ACP 包 `@qoder-ai/qodercli`，首次使用时安装，以 `--acp` 运行                |
| [siGit Code](https://github.com/getsigit/sigit)                             | ACP 包 `@smbcloud/sigit`，首次使用时安装                                    |
| [Agoragentic](https://agoragentic.com)                                      | ACP 包 `agoragentic-mcp`，首次使用时安装，以 `--acp` 运行                   |
| [Autohand Code](https://www.autohand.ai/cli/)                               | ACP 包 `@autohandai/autohand-acp`，首次使用时安装                           |

这些适配器需要 Node.js 和 npm，OverBench 会通过你的登录 shell 找到它们。

## 为什么是 OverBench

它的核心信念是：**颜值也是生产力**。一个要整天用的工具，看着就该让人舒服，而这份舒服正是让你干得更快的原因。

- **集成最优秀的实现。** 研究每个环节最强的实现，从终端到 diff 查看器，把它们集成到一起，而不是重新造轮子。
- **极致优化。** 启动迅速，再长的对话记录也滚动顺滑，不掉帧。
- **极致 UI。** 清晰的层级、克制的字体与动效，让你比翻任何滚动记录都更快看清 Agent 改了什么。

## 反馈

越早的反馈越能影响 OverBench 最终的样子，我们尤其欢迎关于设计和工作流的想法。发现 bug 或想聊聊，都可以提一个 [Issue](https://github.com/overbench/overbench/issues/new/choose)，用什么语言都行，附上截图会很有帮助。安全问题请按 [SECURITY.md](./SECURITY.md) 报告，不要发在公开的 Issue 里。

想自己构建 OverBench？请看 [CONTRIBUTING.md](./CONTRIBUTING.md)（英文）。

## 许可证

OverBench 基于 [Apache-2.0 许可证](./LICENSE)发布。

---

<sub>OverBench 是一个独立项目，与其所支持的各个 Agent 的开发方不存在隶属或背书关系。文中提到的产品名称均为其各自所有者的商标。</sub>
