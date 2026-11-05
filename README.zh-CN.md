<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/lockup-horizontal-dark.svg">
    <img src="./assets/lockup-horizontal.svg" alt="Kettu" width="300">
  </picture>
</h1>

[![版本](https://img.shields.io/github/v/release/KettuAI/Kettu?include_prereleases&label=%E7%89%88%E6%9C%AC&style=flat-square&labelColor=555555&color=2563eb)](https://github.com/KettuAI/Kettu/releases/latest)
[![下载量](https://img.shields.io/github/downloads/KettuAI/Kettu/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F&style=flat-square&labelColor=555555&color=15803d)](https://github.com/KettuAI/Kettu/releases)
[![发布构建](https://img.shields.io/github/actions/workflow/status/KettuAI/Kettu/release.yml?branch=main&label=%E5%8F%91%E5%B8%83%E6%9E%84%E5%BB%BA&style=flat-square&labelColor=555555)](https://github.com/KettuAI/Kettu/actions/workflows/release.yml)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-macOS%20%7C%20Windows%20%7C%20Linux-6d28d9?style=flat-square&labelColor=555555)](https://github.com/KettuAI/Kettu/releases/latest)
[![Agent](https://img.shields.io/badge/Agent-46-0f766e?style=flat-square&labelColor=555555)](#agent)
[![官网](https://img.shields.io/badge/%E5%AE%98%E7%BD%91-kettu.sh-c2410c?style=flat-square&labelColor=555555)](https://www.kettu.sh/zh-CN/)
[![文档](https://img.shields.io/badge/%E6%96%87%E6%A1%A3-kettu.sh%2Fdocs-0369a1?style=flat-square&labelColor=555555)](https://www.kettu.sh/zh-CN/docs/)
[![许可证](https://img.shields.io/github/license/KettuAI/Kettu?label=%E8%AE%B8%E5%8F%AF%E8%AF%81&style=flat-square&labelColor=555555&color=b45309)](./LICENSE)

**你的编码 Agent，并排在一个窗口里。**

Claude Code、Codex、OpenCode、Pi 和另外 42 个 Agent 并排工作，照旧用你自己的安装、账号和配置。<br>
哪个在运行、哪个在等你、哪个做完了，一眼看清。

[**下载**](https://github.com/KettuAI/Kettu/releases/latest) · [官网](https://www.kettu.sh/zh-CN/) · [文档](https://www.kettu.sh/zh-CN/docs/) · [路线图](./ROADMAP.zh-CN.md) · [反馈](https://github.com/KettuAI/Kettu/issues/new/choose) · [English](./README.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/screenshot-dark.webp">
  <img src="./assets/screenshot-light.webp" alt="Kettu 界面：Codex 会话修好了 streak 的 bug，正在请求运行测试，侧边栏里还有另一个 Codex 会话和一个 OpenCode 会话">
</picture>

> [!NOTE]
> Kettu 还是早期预览版，变化很快，难免有粗糙之处，欢迎[反馈问题](https://github.com/KettuAI/Kettu/issues)。

## Kettu 是什么

Claude Code、Codex、OpenCode 这样的编码 Agent 已经能自己规划改动、修改代码、运行测试。但在终端里和它们协作，依然意味着不断滚动的文字墙、容易错过的授权请求，以及散落在各个标签页、窗口和机器上的会话。

Kettu 为这些工作提供了一个桌面上的家。你用的每个 Agent 都并排在同一个窗口里，每个会话归在自己的项目下，哪个 Agent 在干活、哪个在等你、哪个已经做完，侧边栏上一眼就能看清。回答读起来像文档而不是日志，Agent 改了什么以 diff 呈现，Agent 有请求时，会以卡片的形式出现，按一个键就能回答。

它驱动的是你已经在用的 Agent：你自己的安装、账号和配置，Agent 的工作方式一点都不会变。它也跟着你的工作走：在开发机上以 daemon 运行，在另一台电脑、手机或你自己网络里的任何浏览器上接着看你的会话。

## 功能

- **所有 Agent，一个窗口** —— Claude Code、Codex、OpenCode 和其他 Agent 在同一个项目里并排工作。侧边栏标出哪些会话在运行、哪些在等你、哪些已完成，子 Agent 显示在父会话下；会话可以搜索，常用的可以置顶，其余的可以归档。
- **好读的对话线程** —— 回答以 Markdown 流式呈现，代码带语法高亮，改动的文件以 diff 展开，图片直接显示，连续的步骤折叠成一行。Agent 的计划和进度显示在顶栏上。选中一段文字就能针对它回复；Agent 工作时可以排队下一条消息，也可以中途调整方向。
- **一眼看懂的授权和提问** —— 权限请求以卡片呈现，点击或按数字键即可应答；Agent 的多个问题合在一张卡片里逐个回答；有会话需要你时，系统通知会提醒你。每个 Agent 的新会话都从你选定的权限模式开始。
- **什么都能附上** —— 粘贴图片、附加文件和文件夹，或用 `@` 引用项目里的文件；用方向键可以找回发过的消息。
- **每个 Agent 自己的控制项** —— 模式、模型与推理强度、斜杠命令、上下文用了多少、Prompt 缓存何时过期，以及 Agent 上报时显示的套餐额度和余额。
- **用量一目了然** —— 按天、模型和项目统计所有 Agent 的 token、请求数和费用，并显示各套餐的额度。
- **Artifacts** —— Agent 通过 Kettu 内置的 MCP 服务制作网页、文档、幻灯片和画布。每个都保留历史版本，在与应用隔离的查看器中打开：可以对其中一部分留评论交给 Agent，也可以自己直接编辑，文档和幻灯片能导出为 Word 和 PowerPoint，还能通过链接分享。
- **Routines** —— 按计划运行的提示词，限定在一个权限范围内，接近套餐额度时暂停，每次运行都保存为会话。
- **Git、文件、终端和浏览器** —— 顶栏显示分支、同步状态和改动，通过 GitHub CLI 显示 Pull Request 及其检查状态；文件面板用标签页查看、预览和编辑文件；每个项目一个终端；还有一个 Agent 能操作、并保留你登录状态的内置浏览器。
- **会话不丢失** —— 每个会话都随项目保存，重新打开时带着完整历史，Agent 崩溃后也能恢复，可以从任意一条回复分叉，还可以从 Agent 导入已有会话。
- **会话跟着你到每台设备** —— 配对另一台电脑、手机或平板，在上面继续你的会话，端到端加密，直接走你自己的网络：同一个 Wi-Fi、Tailscale 这样的 VPN、端口转发或 SSH。浏览器什么都不用装，因为 Web 客户端由 Kettu 自己提供；开发机用 SSH 地址就能加进来。
- **打磨到细节** —— 浅色与深色模式、来自文件或在线目录的主题、中英文界面、macOS 侧边栏材质、遵循「减少动态效果」的克制动效、常用操作的快捷键，以及关掉窗口后让 Kettu 继续运行的托盘图标。

## 你的 Agent，你的数据

- **用你自己的 Agent。** Kettu 自己不实现任何 Agent：Claude Code 经 Claude Agent SDK 接入，Codex 经 `codex app-server` 接入，其余 Agent 都通过开放的 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）通信，你的模型、配置、规则和工具都保持你设置好的样子。
- **在原来的地方登录。** 每个 Agent 都用它自己的登录流程，Kettu 不保留任何凭据副本：你在 Kettu 里填的 API key 会直接交给 Agent 自己保管。
- **默认只在本地。** Kettu 不收集任何遥测数据。你的会话、代码和文件留在你自己的电脑上，每个 Agent 只和它自己的服务商通信，和你在终端里用它时一样，配对的设备也直接连到你的电脑。登录 Kettu 账号是可选的：在你自己的电脑和网络上，一切都不需要账号。

## 安装

### 桌面应用

从 [Releases](https://github.com/KettuAI/Kettu/releases/latest) 下载对应系统的安装包。macOS 版经过 Apple 签名和公证；Windows 版还没有签名，所以首次启动前 Windows 会询问一次。

- **macOS**：打开 `Kettu-<版本>-arm64.dmg`，把 Kettu 拖进「应用程序」。Kettu 需要 Apple 芯片的 Mac。
- **Windows**：运行 `Kettu-<版本>-x64-setup.exe`，Arm 设备运行 `Kettu-<版本>-arm64-setup.exe`。SmartScreen 提示「Windows 已保护你的电脑」时，点击「更多信息」，再点击「仍要运行」。
- **Linux**：用 `chmod +x` 给 `Kettu-x86_64.AppImage`（Arm 设备为 `Kettu-arm64.AppImage`）加上执行权限后运行。AppImage 需要 FUSE 2：`libfuse2`，Ubuntu 24.04 及以上为 `libfuse2t64`。

新版本会在后台下载，在你退出 Kettu 时安装，也可以在侧边栏上立即安装。

### 服务器或开发机

在没有桌面的机器上，Linux（x64 或 Arm，glibc 2.28 及以上）或 Apple 芯片的 Mac，改装 Kettu 的 daemon：

```sh
curl -fsSL https://kettu.sh/install | sh
```

它装在你的用户目录里，不需要 root，自带 Node.js；下载的包会对照发布里的校验和检查，再链接 `~/.local/bin/kettu`，并把 daemon 装成开机启动的系统服务。`kettu pair` 添加设备，`kettu update` 升到新版本。在容器里用 `sh -s -- --no-service`，改用 `kettu run` 运行。也可以在桌面应用的「**设置 › 主机 › 添加主机…**」里填这台机器的 SSH 地址，Kettu 会替你在那边安装或升级 daemon。详见文档里的 [daemon](https://www.kettu.sh/zh-CN/docs/devices/daemon/)。

### 你的其他设备

打开「**设置 › 远程访问**」，点击「**添加设备…**」。用手机或平板扫码，就能在它的浏览器里打开 Web 客户端；或者把链接粘贴到另一台电脑上 Kettu 的「**设置 › 主机**」里。详见文档里的[远程访问](https://www.kettu.sh/zh-CN/docs/devices/remote-access/)和 [Web 客户端](https://www.kettu.sh/zh-CN/docs/devices/web-client/)。

## Agent

Kettu 能运行 46 个 Agent。在「**设置 › Agent**」里添加你要用的，每个都有自己的账号和配置。「**设置 › Harness**」显示每个 Agent 运行的程序：找到你自己的副本时就用它，缺少时，「**安装**」会提供开发方的官方安装方式，或 ACP Registry 的压缩包。

<details>
<summary><b>全部 46 个 Agent，以及 Kettu 如何运行它们</b></summary>

| Agent                                                                               | Kettu 如何运行它                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Claude Code](https://github.com/anthropics/claude-code)                            | Claude Agent SDK `@anthropic-ai/claude-agent-sdk`，首次使用时安装，运行你自己安装的 `claude` |
| [Codex](https://github.com/openai/codex)                                            | 你自己安装的 `codex`（0.166.0 及以上），以 `codex app-server` 运行                           |
| [OpenCode](https://opencode.ai)                                                     | 你自己安装的 `opencode`，以 `opencode acp` 运行                                              |
| [Pi](https://pi.dev)                                                                | ACP 适配器 `pi-acp`，首次使用时安装，并运行你自己安装的 `pi`                                 |
| [fast-agent](https://fast-agent.ai)                                                 | ACP 包 `fast-agent-acp`，通过你安装的 `uv` 以 `uvx` 运行，带 `-x`                            |
| [Minion Code](https://github.com/femto/minion-code)                                 | ACP 包 `minion-code`，通过你安装的 `uv` 以 `uvx` 运行，带 `acp`                              |
| [Auggie CLI](https://github.com/augmentcode/auggie)                                 | ACP 包 `@augmentcode/auggie`，首次使用时安装，以 `--acp` 运行并关闭自动更新                  |
| [Codebuddy Code](https://www.codebuddy.cn/cli/)                                     | ACP 包 `@tencent-ai/codebuddy-code`，首次使用时安装，以 `--acp` 运行                         |
| [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview)         | ACP 包 `deepagents-acp`，首次使用时安装                                                      |
| [DimCode](https://dimagent.cn/)                                                     | ACP 包 `dimcode`，首次使用时安装，以 `acp` 运行                                              |
| [Dirac](https://dirac.run)                                                          | ACP 包 `dirac-cli`，首次使用时安装，以 `--acp` 运行                                          |
| [GLM Agent](https://github.com/stefandevo/glm-acp-agent)                            | ACP 包 `glm-acp-agent`，首次使用时安装                                                       |
| [Nova](https://www.compassap.ai/portfolio/nova.html)                                | ACP 包 `@compass-ai/nova`，首次使用时安装，以 `acp` 运行                                     |
| [Qoder CLI](https://qoder.com)                                                      | ACP 包 `@qoder-ai/qodercli`，首次使用时安装，以 `--acp` 运行                                 |
| [siGit Code](https://github.com/getsigit/sigit)                                     | ACP 包 `@smbcloud/sigit`，首次使用时安装                                                     |
| [Agoragentic](https://agoragentic.com)                                              | ACP 包 `agoragentic-mcp`，首次使用时安装，以 `--acp` 运行                                    |
| [Autohand Code](https://www.autohand.ai/cli/)                                       | ACP 包 `@autohandai/autohand-acp`，首次使用时安装                                            |
| [Cursor](https://cursor.com/docs/cli/acp)                                           | 你自己安装的 `cursor-agent`，以 `cursor-agent acp` 运行；否则用 ACP Registry 的压缩包        |
| [Kimi Code CLI](https://moonshotai.github.io/kimi-cli/)                             | 你自己安装的 `kimi`，以 `kimi acp` 运行；否则用 ACP Registry 的压缩包                        |
| [Amp](https://ampcode.com)                                                          | 你自己安装的 `amp-acp` 适配器；否则用 ACP Registry 的压缩包                                  |
| [goose](https://block.github.io/goose/)                                             | 你自己安装的 `goose`，以 `goose acp` 运行；否则用 ACP Registry 的压缩包                      |
| [Kilo Code](https://kilo.ai)                                                        | 你自己安装的 `kilo`，以 `kilo acp` 运行；否则用 ACP Registry 的压缩包                        |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)                           | ACP 包 `@google/gemini-cli`，首次使用时安装，以 `--acp` 运行                                 |
| [GitHub Copilot](https://github.com/github/copilot-cli)                             | ACP 包 `@github/copilot`，首次使用时安装，以 `--acp` 运行                                    |
| [Qwen Code](https://github.com/QwenLM/qwen-code)                                    | ACP 包 `@qwen-code/qwen-code`，首次使用时安装，以 `--acp` 运行                               |
| [Grok](https://x.ai/cli)                                                            | ACP 包 `@xai-official/grok`，首次使用时安装，以 `agent stdio` 运行                           |
| [Cline](https://cline.bot/cli)                                                      | ACP 包 `cline`，首次使用时安装，以 `--acp` 运行                                              |
| [Factory Droid](https://factory.ai/product/cli)                                     | ACP 包 `droid`，首次使用时安装，以 `exec --output-format acp-daemon` 运行，并关闭自动更新    |
| [OMP (Oh My Pi)](https://omp.sh)                                                    | 你自己安装的 `omp`，以 `omp acp` 运行                                                        |
| [Hermes Agent](https://hermes-agent.nousresearch.com)                               | 你自己安装的 `hermes`，以 `hermes acp` 运行                                                  |
| [Muse Code](https://dev.meta.ai)                                                    | 你自己安装的 `muse`，以 `muse acp` 运行，启用实验性的 ACP 模式；否则用 ACP Registry 的压缩包 |
| [CodeWhale](https://codewhale.net)                                                  | 你自己安装的 `codewhale`，以 `codewhale serve --acp` 运行（部分支持的 ACP 适配器）           |
| [Bob](https://bob.ibm.com)                                                          | ACP 包 `@ibm/bob`，首次使用时安装，以 `acp` 运行                                             |
| [MiniMax Code](https://agent.minimax.io)                                            | ACP 包 `@minimax-ai/code`，首次使用时安装，以 `acp` 运行                                     |
| [Harn](https://harnlang.com)                                                        | 你自己安装的 `harn`，以 `harn serve acp` 运行；否则用 ACP Registry 的压缩包                  |
| [Kimchi](https://kimchi.dev)                                                        | 你自己安装的 `kimchi`，以 `kimchi --mode acp` 运行；否则用 ACP Registry 的压缩包             |
| [Google Antigravity](https://antigravity.google)                                    | ACP Registry 中的压缩包，以 `agy_acp_server` 运行                                            |
| [Devin](https://docs.devin.ai/cli)                                                  | 你自己安装的 `devin`，以 `devin acp` 运行；否则用 ACP Registry 的压缩包                      |
| [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli) | 你自己安装的 `cortex`，以 `cortex acp serve` 运行；否则用 ACP Registry 的压缩包              |
| [Corust Agent](https://corust.ai)                                                   | ACP Registry 中的压缩包，以 `corust-agent-acp` 运行                                          |
| [crow-cli](https://github.com/crow-cli/crow-cli)                                    | 你自己安装的 `crow-cli`，以 `crow-cli acp` 运行；否则用 ACP Registry 的压缩包                |
| [Junie](https://junie.jetbrains.com)                                                | 你自己安装的 `junie`，以 `junie --acp=true` 运行；否则用 ACP Registry 的压缩包               |
| [Mistral Vibe](https://github.com/mistralai/mistral-vibe)                           | ACP Registry 中的压缩包，以 `vibe-acp` 运行                                                  |
| [Poolside](https://poolside.ai)                                                     | 你自己安装的 `pool`，以 `pool acp` 运行；否则用 ACP Registry 的压缩包                        |
| [Stakpak](https://stakpak.dev)                                                      | 你自己安装的 `stakpak`，以 `stakpak acp` 运行；否则用 ACP Registry 的压缩包                  |
| [VT Code](https://github.com/vinhnx/VTCode)                                         | 你自己安装的 `vtcode`，以 `vtcode acp` 运行；否则用 ACP Registry 的压缩包                    |

</details>

Claude Agent SDK、各个 ACP 包和 `pi-acp` 用你的 Node.js 和 npm 安装，Kettu 会通过你的登录 shell 找到它们；fast-agent 和 Minion Code 需要的是 [uv](https://docs.astral.sh/uv/)。压缩包只在你点击「设置 › Harness」里的「安装」时才会下载。Kettu 装了什么、装在哪里、怎么更新，请看[文档](https://www.kettu.sh/zh-CN/docs/agents/)。

## 为什么是 Kettu

它的核心信念是：**颜值也是生产力**。一个要整天用的工具，看着就该让人舒服，而这份舒服正是让你干得更快的原因。

- **集成最优秀的实现。** 研究每个环节最强的实现，从终端到 diff 查看器，把它们集成到一起，而不是重新造轮子。
- **极致优化。** 启动迅速，再长的对话记录也滚动顺滑，不掉帧。
- **极致 UI。** 清晰的层级、克制的字体与动效，让你比翻任何滚动记录都更快看清 Agent 改了什么。

## 反馈

越早的反馈越能影响 Kettu 最终的样子，我们尤其欢迎关于设计和工作流的想法。发现 bug 或想聊聊，都可以提一个 [Issue](https://github.com/KettuAI/Kettu/issues/new/choose)，用什么语言都行，附上截图会很有帮助。安全问题请按 [SECURITY.md](./SECURITY.md) 报告，不要发在公开的 Issue 里。

[文档](https://www.kettu.sh/zh-CN/docs/)介绍了应用的每个部分。想自己构建 Kettu？请看 [CONTRIBUTING.md](./CONTRIBUTING.md)（英文）。

## 许可证

Kettu 基于 [Apache-2.0 许可证](./LICENSE)发布。

---

<sub>Kettu 是一个独立项目，与其所支持的各个 Agent 的开发方不存在隶属或背书关系。文中提到的产品名称均为其各自所有者的商标。</sub>
