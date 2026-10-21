<div align="center">

# OverBench

**为终端编码 Agent 精心打造的桌面工作台。**

Claude Code · Codex CLI · opencode —— 一个窗口，一套从容的工作流。

_颜值也是生产力。_

[![Status](https://img.shields.io/badge/status-early%20development-orange?style=flat-square)](#路线图)
[![Electron](https://img.shields.io/badge/built%20with-Electron-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](#路线图)

[English](./README.md) · **简体中文**

</div>

> [!NOTE]
> OverBench 目前处于早期开发阶段，还没有发布任何版本。第一个里程碑 M0 已在 `main` 分支上实现，正在验收，现在就可以从源码运行。下文标为「_之后_」的内容还在计划中，尚未实现。

## 为什么是 OverBench

终端编码 Agent 已经能自己规划、修改和测试代码，但我们和它们协作的方式还停留在终端里：不断滚动的文字墙、只能用等宽字体逐行读的 diff、散落在各个标签页和窗口里的会话。

OverBench 想给这些 Agent 一个适合长时间工作的家，它的核心信念是：**颜值也是生产力**。落到实处，就是三件事：

- **集成最优秀的实现。** 市面上的优质项目已经把这件事的不少环节做得很好：有的终端出色，有的 diff 查看出色，有的会话管理出色。OverBench 不重复造轮子，而是研究其中最强的实现，把各家的长处集成到同一个工作台里。
- **极致优化。** 集成只是起点。每个部分都会继续打磨到足够快：启动迅速，再长的对话记录也滚动顺滑，不掉帧。
- **极致 UI。** 每个部分也都会反复打磨到看起来、用起来都恰到好处，因为一个工具的观感和手感，本身就是它好不好用的一部分。清晰的视觉层级，比任何滚动记录都更快让你看清 Agent 改了什么；克制的字体、配色和动效，让你能专注好几个小时；设计良好的审阅流程，能把终端里容易被淹没的问题摆到你面前。

在 OverBench 里，设计不是工具之上的装饰，设计就是工具本身。

## 支持的 Agent

OverBench 通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）与各个 Agent 通信，直接使用你已经在用的 Agent CLI：你自己的安装、你自己的账号、你自己的配置。

| Agent                                                    | OverBench 如何运行它                                             | 状态 |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ---- |
| [Claude Code](https://github.com/anthropics/claude-code) | 通过 npx 运行 ACP 适配器 `@agentclientprotocol/claude-agent-acp` | M0   |
| [Codex CLI](https://github.com/openai/codex)             | 通过 npx 运行 ACP 适配器 `@agentclientprotocol/codex-acp`        | M0   |
| [opencode](https://opencode.ai)                          | 你自己安装的 `opencode`，以 `opencode acp` 运行                  | M0   |

Claude Code 和 Codex 的适配器需要 Node.js 22 及以上版本，OverBench 会通过你的登录 shell 找到它。登录走各个 Agent 自己的流程，OverBench 不会接触你的凭据。

## 功能

M0 提供的功能：

- **所有 Agent，一个工作台** —— 在同一个项目里并排开启 Claude Code、Codex CLI 和 opencode 会话，切换 Agent 不用切换工具。
- **按项目组织的会话** —— 每个会话都随项目保存，重新打开时带着完整历史，Agent 崩溃后也能恢复；Agent 已有的该项目会话可以导入。
- **好读的对话线程** —— 回答以 Markdown 流式呈现，代码带语法高亮；思考过程、计划、工具调用及其行内 diff 以安静的卡片展示，需要时再展开。
- **看得懂的授权请求** —— 权限请求以清晰的卡片展示，点击或按数字键即可应答；Agent 并行提问时可以同时处理多个。
- **多会话并行** —— 多个会话同时运行，侧边栏标出哪些在运行、哪些在等你、哪些已完成，子 Agent 显示在父会话下；OverBench 在后台时，有会话需要你会弹出系统通知。
- **每个 Agent 自己的控制项** —— 模式、模型和推理强度选择、斜杠命令、上下文用量，以及 Agent 上报时显示的套餐额度，侧边栏里也能一眼看到。
- **Git 一目了然** —— 顶栏显示分支、同步状态和改动，线程里显示提交和推送，并通过 GitHub CLI 显示 Pull Request 及其检查状态。
- **内置终端** —— 每个项目一个，在会话右侧的侧栏里，支持多标签页，使用你的登录 shell。
- **打磨到细节** —— 讲究的字体排印、浅色与深色主题、遵循「减少动态效果」的克制动效，以及常用操作的快捷键。

_之后_：用于并排审阅 diff 的改动面板、跨会话搜索、命令面板、输入框中的 `@` 文件引用和图片，以及签名的安装包。[M0 计划](./docs/milestones/m0.md#scope)（英文）列出了包含与不包含的内容。

## 设计原则

1. **颜值也是生产力。** 视觉品质是和功能同等重要的特性。一个能让你舒服地看上八小时的界面，也是让你工作得更好的界面。
2. **清晰优先于密度。** 只展示当下做决定所需要的信息，其余的放在一步之外。
3. **让 Agent 的工作一目了然。** 它打算做什么、运行了什么、改了什么，都应该一眼可见、易于审阅。
4. **原生般的体验。** 虽然基于 Electron 构建，依然要启动快、操作顺滑，并尊重每个平台的使用习惯。
5. **不喧宾夺主。** 干活的是 Agent。OverBench 负责让它的工作可见、可控，然后退到一旁。

## 路线图

第一个里程碑 M0 通过 ACP 接入这三个 Agent，目前已实现，正在验收。详见[架构设计](./docs/architecture.md)、[M0 计划](./docs/milestones/m0.md)和它的[性能测量结果](./docs/perf/m0.md)（均为英文）。

- [x] 应用框架与设计系统
- [x] 通过 ACP 接入 Claude Code、Codex CLI 和 opencode
- [x] 会话历史：重新打开、崩溃恢复和导入
- [x] 多项目、多会话工作区与子会话
- [x] Git 状态、Pull Request 和内置终端
- [ ] M0 在 macOS、Windows、Linux 上通过验收
- [ ] macOS、Windows、Linux 预览版
- [ ] 在改动面板中审阅 diff
- [ ] 跨会话搜索

## 快速开始

目前还没有可以安装的版本，欢迎 Star 或 Watch 本仓库关注进展。如果想从源码运行 OverBench，需要 Node.js 22.12 及以上版本和 pnpm 10：

```bash
pnpm install
pnpm dev
```

开发版还会列出一个 **Fake agent**：它不需要账号和网络，按脚本演示各种场景，例如很长的回答、一连串工具调用，或同时出现三个授权请求。在它的输入框里输入 `/` 即可查看，也可以阅读 [fake agent](./docs/design/testing.md#fake-agent) 文档（英文）。

| 命令                                                  | 作用                                              |
| ----------------------------------------------------- | ------------------------------------------------- |
| `pnpm dev`                                            | 以开发模式启动应用，支持热更新                    |
| `pnpm test`                                           | 运行单元测试、集成测试和进程测试                  |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`        | 代码检查、类型检查和格式化                        |
| `pnpm build`                                          | 类型检查并把应用构建到 `out/`                     |
| `pnpm package`                                        | 在 `dist/` 中生成未打成安装包的应用，用于本地测试 |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | 为各个平台构建安装包                              |

技术栈为 Electron、electron-vite、React、TypeScript、Tailwind CSS 和 shadcn/ui。源码按进程划分：

```text
src/
├── main/            主进程：应用生命周期、窗口、菜单、IPC、更新
├── preload/         以 window.overbench 暴露给渲染进程的桥接层
├── agent-host/      通过 ACP 运行各个 Agent、管理会话的 utility 进程
├── terminal-host/   运行终端 shell 的 utility 进程
├── renderer/        React 界面
└── shared/          各进程共用的类型和逻辑，例如线程模型
tools/
├── fake-agent/      用于测试、开发和性能测量的脚本化 ACP Agent
└── perf/            性能测量脚本
```

## 参与贡献

OverBench 正在成形，越早的反馈越能影响它最终的样子。我们尤其欢迎关于设计和工作流的想法，可以直接提一个 [Issue](https://github.com/overbench/overbench/issues) 来聊聊。提交代码前，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)（英文），了解项目统一使用的 UI 技术栈和开发约定。

---

<sub>OverBench 是一个独立项目，与其所支持的各个 Agent 的开发方不存在隶属或背书关系。文中提到的产品名称均为其各自所有者的商标。</sub>
