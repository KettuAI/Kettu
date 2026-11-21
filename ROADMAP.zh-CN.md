# 路线图

Kettu 现在有什么、接下来做什么。版本没有固定的发布日期：功能完成后马上发版，较小的修复随下一版一起发布，所以这里的先后顺序比时间更可靠。每一项都链接到对应的 Issue，你可以在那里关注进展，或者告诉我们你的需求；每个版本发布的全部内容（包括各项修复）见[发布说明](https://github.com/KettuAI/Kettu/releases)。[English](./ROADMAP.md)

## 现在已有

[v0.1.13](https://github.com/KettuAI/Kettu/releases/tag/v0.1.13) 中：

- 48 个 Agent，Claude Code、Codex、OpenCode、Pi 等，用你自己的安装、账号和设置；暂时不用的可以关掉，会话不会丢；两轮之间可以把会话交给另一个 Agent
- 并行的会话、子 Agent 和从任意回复分出的分叉，由 Kettu 创建和清理的 Git worktree，窗口最多分成九格，侧边栏标出哪个会话在干活、在等你或已做完
- 一键回应授权请求，Agent 的多个问题在一张卡片里回答，计划显示在顶栏，排队消息引导正在进行的一轮，回复选中的段落，以及通知
- Agent 之间的交接，让任务按步骤走、每步一个会话的工作流，以及一个页面看全所有会话和任务的总览
- Diff、Git 状态和 Pull Request，回复里的 GitHub 引用，标签页里的文件面板，每个会话自己的终端，以及 Agent 能操作的内置浏览器
- Artifacts：带版本的网页、文档、幻灯片和画布，Agent 会读的留言，导出成 Word 和 PowerPoint，以及发布到 kettu.page 的页面，可以只有自己能看、凭访问码看或公开
- 会话旁边的移动设备，你和 Agent 都能操作；打开之后的 Computer use
- Routines，带每个账号套餐额度的用量和费用，管理插件、Skills、MCP 服务器和工作流的 Marketplace，以及什么都能搜的命令面板
- 随处可用：任何浏览器打开 app.kettu.sh 经 Kettu 中继连回电脑，在你自己的网络里不用账号，另一台电脑上的 Kettu，经 SSH 加进来的开发机，全部端到端加密
- iPhone 和 iPad 应用，正在 [TestFlight 公开测试](https://testflight.apple.com/join/zsbFyAPQ)
- 浅色和深色模式，主题，简体中文和英文，以及从应用里发送问题报告
- macOS 版（Apple 芯片和 Intel，经过 Apple 签名和公证），Windows 和 Linux 版（x64 和 Arm），以及用在服务器上的 daemon 和 Docker 镜像

## 接下来

- [ ] 在 MacBook 的刘海里显示每个会话在做什么，并且直接在那里回应（[#2053](https://github.com/KettuAI/Kettu/issues/2053)、[#2059](https://github.com/KettuAI/Kettu/issues/2059)）
- [ ] Antigravity 的协作子 Agent 显示在它的会话下面，它的提问进问题卡片（[#1695](https://github.com/KettuAI/Kettu/issues/1695)、[#1696](https://github.com/KettuAI/Kettu/issues/1696)）
- [ ] 在你的其他设备上看到电脑的更多状态：云服务和 Computer use 是否打开，以及它的诊断信息（[#1584](https://github.com/KettuAI/Kettu/issues/1584)、[#1596](https://github.com/KettuAI/Kettu/issues/1596)、[#1597](https://github.com/KettuAI/Kettu/issues/1597)）

## 正在考虑

有人提了、我们正在权衡的。在 Issue 上点个赞会有帮助：

- [ ] 左右并排的 Diff（[#1916](https://github.com/KettuAI/Kettu/issues/1916)），以及撤销某一轮的文件改动（[#1789](https://github.com/KettuAI/Kettu/issues/1789)）
- [ ] 每一轮回复下面显示这一轮的费用和 token（[#1918](https://github.com/KettuAI/Kettu/issues/1918)）
- [ ] 直接在输入框里把任务交给另一个 Agent（[#2058](https://github.com/KettuAI/Kettu/issues/2058)）
- [ ] 在内置浏览器的页面上做标注交给 Agent（[#1812](https://github.com/KettuAI/Kettu/issues/1812)）
- [ ] 把对话导出成文件（[#1836](https://github.com/KettuAI/Kettu/issues/1836)），往项目里上传文件（[#1838](https://github.com/KettuAI/Kettu/issues/1838)），以及预览 PDF 和 Word 文件（[#1839](https://github.com/KettuAI/Kettu/issues/1839)）
- [ ] 自己设定界面、回复和代码的字体、字重和字号（[#1841](https://github.com/KettuAI/Kettu/issues/1841)）

## 以后

- [ ] 原生 Android 应用，排在 iPhone 和 iPad 应用之后
- [ ] 设备经 NAT 穿透直接连到你的电脑（[#1527](https://github.com/KettuAI/Kettu/issues/1527)）
- [ ] 更多 Agent 改用自己的接口而不是 ACP：先是 GitHub Copilot、Cursor、OMP、Muse Code 和 Amp（[#2021](https://github.com/KettuAI/Kettu/issues/2021)），再是 Kilo Code、Qoder 和 Factory Droid（[#2022](https://github.com/KettuAI/Kettu/issues/2022)）

还缺什么？[提一个 Issue](https://github.com/KettuAI/Kettu/issues/new/choose)，告诉我们你需要什么。
