# 路线图

Kettu 现在有什么、接下来做什么，按版本列出。版本没有固定的发布日期：核心功能完成后马上发版，较小的修复随下一版一起发布，所以这里的先后顺序比时间更可靠。每一项都链接到对应的 Issue，你可以在那里关注进展，或者告诉我们你的需求；完整的列表（包括各项修复）见 [Milestones](https://github.com/KettuAI/Kettu/milestones)。[English](./ROADMAP.md)

## 现在已有

[v0.0.1](https://github.com/KettuAI/Kettu/releases/tag/v0.0.1) 中：

- 并排使用 Claude Code、Codex、opencode 和另外 40 多个 Agent，其中 Claude Code 和 Codex 经它们自己的接口接入
- 会话历史、多会话并行、子会话，以及从任意一条回复分叉，还有一份消息大纲，可以在你发过的消息之间跳转
- 按一个键就能回答的授权卡片、会话需要你时发送通知，以及 Prompt 缓存倒计时
- Git 状态与 Pull Request，每个项目都有文件面板和终端，还有 Agent 可以操作、能保留登录状态的内置浏览器
- 所有 Agent 的 token 用量、请求数和费用，以及套餐额度
- Artifacts：Agent 生成的页面和画布，保留历史版本，在隔离的查看器中打开，还能通过链接在线分享
- 附件：从输入框、剪贴板或 `@` 引用附加文件、文件夹和图片，图片、视频和音频直接显示在回复、工具调用和文件面板中
- Routines：按计划自动运行的 Agent 任务，在权限范围内运行，接近套餐额度时暂停，并保留每次运行的记录
- 可从文件或在线目录安装的主题，有浅色和深色，内置 Paper 外观
- 关掉窗口后 Kettu 继续在后台运行，并显示托盘图标
- macOS、Windows、Linux 预览版，macOS 版经过 Apple 签名和公证，更新在你选择的时候安装

## v0.1.0：完整的桌面应用

- [ ] 桌面应用的每个部分都做完，并对照设计验收
- [ ] 经过 Microsoft 签名的 Windows 安装包，并在两个版本之间验证 macOS 一键更新（[#68](https://github.com/KettuAI/Kettu/issues/68)）
- [ ] 把会话退回到任意一条消息之前，撤销 Agent 在那之后改的文件（[#615](https://github.com/KettuAI/Kettu/issues/615)）
- [ ] Agent 问的选择题显示成点一下就能回答的卡片（[#616](https://github.com/KettuAI/Kettu/issues/616)），以及每个会话的 MCP 服务器和它们的连接状态（[#617](https://github.com/KettuAI/Kettu/issues/617)）
- [ ] 并行的会话各自在自己的 Git worktree 里工作（[#618](https://github.com/KettuAI/Kettu/issues/618)），以及在一处审阅一个会话或一轮的改动（[#619](https://github.com/KettuAI/Kettu/issues/619)）
- [ ] 盯着会话开的 Pull Request，检查失败、出现冲突或有人评审时叫醒 Agent 接着处理（[#621](https://github.com/KettuAI/Kettu/issues/621)）

## v0.2.0：在你自己的网络里，从其他设备使用会话

- [ ] 从其他设备使用你的会话（[#377](https://github.com/KettuAI/Kettu/issues/377)）：配对设备并选择哪些可以连接（[#380](https://github.com/KettuAI/Kettu/issues/380)），在你自己组好的任何网络上直接连接，比如同一网络、Tailscale 这类 VPN 或转发出来的端口（[#581](https://github.com/KettuAI/Kettu/issues/581)），不打开窗口 Kettu 也保持运行（[#378](https://github.com/KettuAI/Kettu/issues/378)）；不需要账号
- [ ] 在 Linux 和 macOS 开发机上以 daemon 运行 Kettu，开机就启动（[#649](https://github.com/KettuAI/Kettu/issues/649)），一行命令就能装好（[#658](https://github.com/KettuAI/Kettu/issues/658)）；在桌面应用里填 SSH 地址就能添加它，没装的替你装好，版本旧的替你升级（[#650](https://github.com/KettuAI/Kettu/issues/650)）
- [ ] 在桌面应用中操作另一台电脑上的 Kettu（[#384](https://github.com/KettuAI/Kettu/issues/384)），所有主机的会话放在一起看，需要你的一眼就能看到
- [ ] 在远程设备上回答授权请求（[#385](https://github.com/KettuAI/Kettu/issues/385)）、查看文件、改动和 Artifacts（[#386](https://github.com/KettuAI/Kettu/issues/386)）、打开终端（[#387](https://github.com/KettuAI/Kettu/issues/387)），在多台设备上同时使用一个会话（[#389](https://github.com/KettuAI/Kettu/issues/389)），另一台主机上的 Agent 也能用浏览器（[#651](https://github.com/KettuAI/Kettu/issues/651)）

## v0.3.0：官方云服务

- [ ] 经官方中继从你的网络之外访问主机（[#381](https://github.com/KettuAI/Kettu/issues/381)），需要 Kettu 账号，只有官方服务才需要它
- [ ] Web 客户端，安卓手机和平板也用它（[#382](https://github.com/KettuAI/Kettu/issues/382)）
- [ ] 远程设备上的通知（[#388](https://github.com/KettuAI/Kettu/issues/388)）

## v0.4.0：iOS 应用

- [ ] iPhone 和 iPad 上的原生应用（[#383](https://github.com/KettuAI/Kettu/issues/383)）：你的会话，在锁屏和通知上回答授权请求，分享扩展和用量小组件

## v1.0.0：团队

- [ ] 把一个会话、一个项目或整台主机共享给团队：队友能实时看、提议消息，或在同一个会话里接着做
- [ ] 交接工作，把工作分派给人
- [ ] 按成员设上限：能运行什么、能用多少

## 以后

- [ ] 原生的安卓应用
- [ ] 按对话内容搜索所有会话（[#622](https://github.com/KettuAI/Kettu/issues/622)）
- [ ] 以 Artifacts 形式制作幻灯片（[#368](https://github.com/KettuAI/Kettu/issues/368)），导出为 PDF、PNG 或 PowerPoint（[#367](https://github.com/KettuAI/Kettu/issues/367)），在 Artifact 的某一部分留下评论（[#366](https://github.com/KettuAI/Kettu/issues/366)），以及让 Artifact 页面保存的数据到达 Agent（[#369](https://github.com/KettuAI/Kettu/issues/369)）
- [ ] 在设置中管理技能和插件（[#488](https://github.com/KettuAI/Kettu/issues/488)、[#489](https://github.com/KettuAI/Kettu/issues/489)），以及显示会话启动的后台任务（[#495](https://github.com/KettuAI/Kettu/issues/495)）
- [ ] 从项目的设计系统生成 Artifacts（[#370](https://github.com/KettuAI/Kettu/issues/370)）、直接编辑画布页面（[#371](https://github.com/KettuAI/Kettu/issues/371)），以及把 Word、PowerPoint 和 Excel 文件作为 Artifacts 显示（[#365](https://github.com/KettuAI/Kettu/issues/365)）

还缺什么？[提一个 Issue](https://github.com/KettuAI/Kettu/issues/new/choose)，告诉我们你需要什么。
