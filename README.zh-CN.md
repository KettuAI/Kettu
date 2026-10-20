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
> OverBench 目前处于早期开发阶段，还没有发布任何版本。下文描述的是项目的方向，而不是现在已经能用的功能。

## 为什么是 OverBench

终端编码 Agent 已经能自己规划、修改和测试代码，但我们和它们协作的方式还停留在终端里：不断滚动的文字墙、只能用等宽字体逐行读的 diff、散落在各个标签页和窗口里的会话。

OverBench 想给这些 Agent 一个适合长时间工作的家，它的核心信念是：**颜值也是生产力**。落到实处，就是三件事：

- **集成最优秀的实现。** 市面上的优质项目已经把这件事的不少环节做得很好：有的终端出色，有的 diff 查看出色，有的会话管理出色。OverBench 不重复造轮子，而是研究其中最强的实现，把各家的长处集成到同一个工作台里。
- **极致优化。** 集成只是起点。每个部分都会继续打磨到足够快：启动迅速，再长的对话记录也滚动顺滑，不掉帧。
- **极致 UI。** 每个部分也都会反复打磨到看起来、用起来都恰到好处，因为一个工具的观感和手感，本身就是它好不好用的一部分。清晰的视觉层级，比任何滚动记录都更快让你看清 Agent 改了什么；克制的字体、配色和动效，让你能专注好几个小时；设计良好的审阅流程，能把终端里容易被淹没的问题摆到你面前。

在 OverBench 里，设计不是工具之上的装饰，设计就是工具本身。

## 支持的 Agent

OverBench 直接使用你已经在用的 Agent CLI：你自己的安装、你自己的账号、你自己的配置。

| Agent                                                    | 状态   |
| -------------------------------------------------------- | ------ |
| [Claude Code](https://github.com/anthropics/claude-code) | 计划中 |
| [Codex CLI](https://github.com/openai/codex)             | 计划中 |
| [opencode](https://opencode.ai)                          | 计划中 |

## 功能

> 计划在首批版本中提供。

- **所有 Agent，一个工作台** —— 在同一个界面里并排使用 Claude Code、Codex CLI 和 opencode，切换 Agent 不用切换工具。
- **按项目组织的会话** —— 每一次对话都会保留，可搜索、可恢复，并按所属项目归类。
- **用 diff 审阅改动，而不是翻滚动记录** —— Agent 的修改以真正的并排或行内 diff 呈现，逐个文件查看。
- **看得懂的授权请求** —— 工具调用和权限请求以清晰的结构化卡片展示，让你放心批准。
- **多会话并行** —— 多个 Agent 同时在不同项目里工作，一眼就能看出哪些在运行、哪些在等你、哪些已完成。
- **键盘优先** —— 命令面板和快捷键覆盖所有操作，鼠标只是可选项。
- **打磨到细节** —— 讲究的字体排印、精心调校的浅色与深色主题，以及从不打扰你的克制动效。

## 设计原则

1. **颜值也是生产力。** 视觉品质是和功能同等重要的特性。一个能让你舒服地看上八小时的界面，也是让你工作得更好的界面。
2. **清晰优先于密度。** 只展示当下做决定所需要的信息，其余的放在一步之外。
3. **让 Agent 的工作一目了然。** 它打算做什么、运行了什么、改了什么，都应该一眼可见、易于审阅。
4. **原生般的体验。** 虽然基于 Electron 构建，依然要启动快、操作顺滑，并尊重每个平台的使用习惯。
5. **不喧宾夺主。** 干活的是 Agent。OverBench 负责让它的工作可见、可控，然后退到一旁。

## 路线图

- [ ] 应用框架与设计系统
- [ ] 接入 Claude Code
- [ ] 接入 Codex CLI
- [ ] 接入 opencode
- [ ] 会话历史与搜索
- [ ] Diff 审阅
- [ ] 多项目、多会话工作区
- [ ] macOS、Windows、Linux 预览版

## 快速开始

目前还没有可以安装的版本，欢迎 Star 或 Watch 本仓库关注进展。如果想从源码运行 OverBench，需要 Node.js 22.12 及以上版本和 pnpm 10：

```bash
pnpm install
pnpm dev
```

| 命令                                                  | 作用                                              |
| ----------------------------------------------------- | ------------------------------------------------- |
| `pnpm dev`                                            | 以开发模式启动应用，支持热更新                    |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`        | 代码检查、类型检查和格式化                        |
| `pnpm build`                                          | 类型检查并把应用构建到 `out/`                     |
| `pnpm package`                                        | 在 `dist/` 中生成未打成安装包的应用，用于本地测试 |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | 为各个平台构建安装包                              |

技术栈为 Electron、electron-vite、React、TypeScript、Tailwind CSS 和 shadcn/ui。源码按 Electron 进程划分：

```text
src/
├── main/       主进程：应用生命周期、窗口、IPC 处理
├── preload/    以 window.overbench 暴露给渲染进程的桥接层
├── renderer/   React 界面
└── shared/     各进程共用的类型，例如 IPC 约定
```

## 参与贡献

OverBench 正在成形，越早的反馈越能影响它最终的样子。我们尤其欢迎关于设计和工作流的想法，可以直接提一个 [Issue](https://github.com/overbench/overbench/issues) 来聊聊。提交代码前，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)（英文），了解项目统一使用的 UI 技术栈和开发约定。

---

<sub>OverBench 是一个独立项目，与其所支持的各个 Agent 的开发方不存在隶属或背书关系。文中提到的产品名称均为其各自所有者的商标。</sub>
