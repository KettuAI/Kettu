# 路线图

Kettu 现在有什么、接下来做什么，按版本列出。版本没有固定的发布日期：核心功能完成后马上发版，较小的修复随下一版一起发布，所以这里的先后顺序比时间更可靠。每一项都链接到对应的 Issue，你可以在那里关注进展，或者告诉我们你的需求；完整的列表（包括各项修复）见 [Milestones](https://github.com/KettuAI/Kettu/milestones)。[English](./ROADMAP.md)

## 现在已有

[v0.0.30](https://github.com/KettuAI/Kettu/releases/tag/v0.0.30) 中：

- 并排使用 Claude Code、Codex、OpenCode、Pi 和另外 40 多个 Agent，其中 Claude Code 和 Codex 经它们自己的接口接入；暂时不用的 Agent 可以关掉，会话不会丢；两轮之间可以把会话交给另一个 Agent
- 多会话并行、子 Agent，以及从任意一条回复分叉，窗口最多分成九格，侧边栏标出哪个会话在干活、在等你或已做完
- 按一个键就能回答的授权卡片，在一张卡片里回答 Agent 的多个问题，顶栏显示计划，运行中可以排队和插话，可以只回复选中的段落，以及通知
- Diff、Git 状态与 Pull Request，回复里的 GitHub 引用，用标签页打开的文件面板，每个会话一个终端，以及 Agent 可以操作的内置浏览器
- Artifacts：网页、文档、幻灯片和画布，保留历史版本；留言给 Agent 看、直接编辑画布、演示，导出为 Word、Markdown、PowerPoint 和 PDF，还能发布到 kettu.page，可以只有自己能看、凭访问码看或公开
- 移动设备：iOS 模拟器、Android 模拟器和真机就在会话旁边，你和 Agent 都能操作
- Computer use：打开之后，Agent 能操作你电脑上的应用
- Routines，带每个账号套餐额度的 token 用量和费用，以及一个能搜会话、Artifacts、Routines、项目、设置和操作的命令面板
- 在你自己的网络里从其他设备使用会话：设备配对、直接连接、使用另一台电脑上的 Kettu，以及填 SSH 地址添加开发机，daemon 会替你装好
- 登录 Kettu 账号后的官方云服务：从任何网络连回你电脑的中继，以及 app.kettu.sh 上的 Web 客户端
- 在应用里提交问题报告，浅色和深色模式，从文件或在线目录安装的主题，简体中文和英文
- 支持 Apple 芯片的 macOS 版，经过 Apple 签名和公证；x64 和 Arm 的 Windows 版和 Linux 版；更新在你选择的时候安装

## v0.1.0：完整的桌面应用

- [ ] 桌面应用的每个部分都做完，并对照设计验收
- [ ] 经过 Microsoft 签名的 Windows 安装包，并在两个版本之间验证 macOS 一键更新（[#68](https://github.com/KettuAI/Kettu/issues/68)）
- [ ] 把会话退回到任意一条消息之前，撤销 Agent 在那之后改的文件（[#615](https://github.com/KettuAI/Kettu/issues/615)）
- [ ] 每个会话的 MCP 服务器和它们的连接状态（[#617](https://github.com/KettuAI/Kettu/issues/617)）
- [ ] 并行的会话各自在自己的 Git worktree 里工作（[#618](https://github.com/KettuAI/Kettu/issues/618)），以及在一处审阅一个会话或一轮的改动（[#619](https://github.com/KettuAI/Kettu/issues/619)）
- [ ] 盯着会话开的 Pull Request，检查失败、出现冲突或有人评审时叫醒 Agent 接着处理（[#621](https://github.com/KettuAI/Kettu/issues/621)）

## v0.2.0：在你自己的网络里，从其他设备使用会话

已经可以用了，只剩：

- [ ] 在手机上的 Web 客户端里只读查看文件，修改交给 Agent（[#749](https://github.com/KettuAI/Kettu/issues/749)）

## v0.3.0：官方云服务

中继、app.kettu.sh 上的 Web 客户端和 Kettu 账号已经可以用了。接下来：

- [ ] 会话需要你时，在你的其他设备上收到通知（[#388](https://github.com/KettuAI/Kettu/issues/388)）
- [ ] 适合手机宽度的 Web 客户端布局，在有应用之前安卓手机也用它（[#712](https://github.com/KettuAI/Kettu/issues/712)）

## v0.4.0：iOS 应用

- [ ] iPhone 和 iPad 上的原生应用（[#383](https://github.com/KettuAI/Kettu/issues/383)）：你的会话，在锁屏和通知上回答授权请求，分享扩展和用量小组件

## 以后

- [ ] 原生的安卓应用
- [ ] 按对话内容搜索所有会话（[#622](https://github.com/KettuAI/Kettu/issues/622)）
- [ ] 把 Agent 生成的 Word、PowerPoint 和 Excel 文件作为 Artifacts 显示（[#365](https://github.com/KettuAI/Kettu/issues/365)），从项目的设计系统生成 Artifacts（[#370](https://github.com/KettuAI/Kettu/issues/370)），以及导出为 PNG（[#367](https://github.com/KettuAI/Kettu/issues/367)）
- [ ] 在设置中管理技能和插件（[#488](https://github.com/KettuAI/Kettu/issues/488)、[#489](https://github.com/KettuAI/Kettu/issues/489)），以及显示会话启动的后台任务（[#495](https://github.com/KettuAI/Kettu/issues/495)）

还缺什么？[提一个 Issue](https://github.com/KettuAI/Kettu/issues/new/choose)，告诉我们你需要什么。
