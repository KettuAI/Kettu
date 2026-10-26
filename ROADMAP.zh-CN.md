# 路线图

OverBench 现在有什么、接下来做什么，按版本列出。版本没有固定的发布日期：核心功能完成后马上发版，较小的修复随下一版一起发布，所以这里的先后顺序比时间更可靠。每一项都链接到对应的 Issue，你可以在那里关注进展，或者告诉我们你的需求；完整的列表（包括各项修复）见 [Milestones](https://github.com/overbench/overbench/milestones)。[English](./ROADMAP.md)

## 现在已有

v0.0.5 中：

- 通过 Agent Client Protocol 并排使用 Claude Code、Codex CLI 和 opencode
- 会话历史、多会话并行、子会话，以及从任意一条回复分叉，还有一份消息大纲，可以在你发过的消息之间跳转
- 按一个键就能回答的授权卡片、会话需要你时发送通知，以及 Prompt 缓存倒计时
- Git 状态与 Pull Request，每个项目都有文件面板和终端，还有能保留登录状态的浏览器面板
- 所有 Agent 的 token 用量、请求数和费用，以及套餐额度
- Artifacts：Agent 生成的页面和画布，保留历史版本，在隔离的查看器中打开，还能通过链接在线分享
- 附件：从输入框、剪贴板或 `@` 引用附加文件、文件夹和图片，回复中提到的图片、视频和音频直接显示
- Routines：按计划自动运行的 Agent 任务，在权限范围内运行，接近套餐额度时暂停，并保留每次运行的记录
- 可从文件或在线目录安装的主题，有浅色和深色
- 重新设计的模型菜单、斜杠命令列表、用量弹窗和终端标签栏，控件和表面有轻微的层次感
- macOS、Windows、Linux 预览版，Windows 和 Linux 上的更新在你选择的时候安装

## v0.0.6：其余的核心功能

已合并，将随本版本发布：

- [x] 在 macOS 上，发送 Apple Events 的命令会弹出系统的授权提示，不再被直接拒绝（[#133](https://github.com/overbench/overbench/issues/133)）
- [x] 较小的修复：把过长的思考折叠进它所在的工作（[#333](https://github.com/overbench/overbench/issues/333)）、通知中的链接可点击（[#345](https://github.com/overbench/overbench/issues/345)）、输入时高亮斜杠命令（[#363](https://github.com/overbench/overbench/issues/363)）、输入时隐藏最近的 Artifacts（[#391](https://github.com/overbench/overbench/issues/391)）、重新设计的链接确认（[#246](https://github.com/overbench/overbench/issues/246)）、折叠的工作行之间不再留出空白（[#244](https://github.com/overbench/overbench/issues/244)）、从历史中读取的 Codex 思考不再把标题连在一起（[#267](https://github.com/overbench/overbench/issues/267)），以及 [Milestone](https://github.com/overbench/overbench/milestone/11) 中的其他修复

尚未完成：

- [ ] 以 Paper 外观作为内置主题，本版本会等它完成后发布：窗口是桌面，对话、面板和页面是铺在上面的纸张，字体和多个界面的布局也随之更新（[#423](https://github.com/overbench/overbench/issues/423)）
- [ ] 在工具调用和文件面板中显示图片、音频和视频（[#43](https://github.com/overbench/overbench/issues/43)、[#312](https://github.com/overbench/overbench/issues/312)），在图片查看器中缩放、逐步查看和复制（[#311](https://github.com/overbench/overbench/issues/311)），以及在对话中传输音频和视频文件内容（[#313](https://github.com/overbench/overbench/issues/313)）
- [ ] 侧栏的头部和底部（[#34](https://github.com/overbench/overbench/issues/34)）、关于页面中的 logo、应用图标和许可证（[#33](https://github.com/overbench/overbench/issues/33)），以及让代码符合设计指南（[#29](https://github.com/overbench/overbench/issues/29)）

## v0.0.7：内置浏览器与更多 Agent

- [ ] Agent 可以操作的内置浏览器（[#47](https://github.com/overbench/overbench/issues/47)、[#317](https://github.com/overbench/overbench/issues/317)），并在 Agent 打开新网站前询问（[#318](https://github.com/overbench/overbench/issues/318)）
- [ ] 把 Cursor、GitHub Copilot CLI、Gemini CLI 和 Pi 接入为 Agent（[#350](https://github.com/overbench/overbench/issues/350)、[#351](https://github.com/overbench/overbench/issues/351)、[#352](https://github.com/overbench/overbench/issues/352)、[#353](https://github.com/overbench/overbench/issues/353)）

## v0.1.0：更多 Agent 与 Artifacts

- [ ] 把 Qwen Code、Kimi Code、Amp、Factory Droid、Devin CLI、Goose、Cline、Kilo Code 和 Grok 接入为 Agent（[#354](https://github.com/overbench/overbench/issues/354)、[#355](https://github.com/overbench/overbench/issues/355)、[#356](https://github.com/overbench/overbench/issues/356)、[#357](https://github.com/overbench/overbench/issues/357)、[#358](https://github.com/overbench/overbench/issues/358)、[#359](https://github.com/overbench/overbench/issues/359)、[#360](https://github.com/overbench/overbench/issues/360)、[#361](https://github.com/overbench/overbench/issues/361)、[#362](https://github.com/overbench/overbench/issues/362)）
- [ ] 以 Artifacts 形式制作幻灯片（[#368](https://github.com/overbench/overbench/issues/368)），导出为 PDF、PNG、PowerPoint 或各页的压缩包（[#367](https://github.com/overbench/overbench/issues/367)），在 Artifact 的某一部分留下评论并发送给 Agent（[#366](https://github.com/overbench/overbench/issues/366)），以及让 Artifact 页面保存的数据到达 Agent 和导出文件（[#369](https://github.com/overbench/overbench/issues/369)）

## v0.2.0：在其他设备上使用会话

- [ ] 通过 Web 客户端和手机、平板应用控制 OverBench（[#377](https://github.com/overbench/overbench/issues/377)、[#382](https://github.com/overbench/overbench/issues/382)、[#383](https://github.com/overbench/overbench/issues/383)）
- [ ] 配对不同设备并选择哪些可以连接（[#380](https://github.com/overbench/overbench/issues/380)），从家庭网络外访问这台电脑（[#381](https://github.com/overbench/overbench/issues/381)），以及不打开窗口也保持 OverBench 运行（[#378](https://github.com/overbench/overbench/issues/378)）
- [ ] 在远程设备上回答授权请求（[#385](https://github.com/overbench/overbench/issues/385)）、查看文件、改动和 Artifacts（[#386](https://github.com/overbench/overbench/issues/386)）、打开终端（[#387](https://github.com/overbench/overbench/issues/387)）并接收通知（[#388](https://github.com/overbench/overbench/issues/388)）
- [ ] 在桌面应用中操作另一台电脑上的 OverBench（[#384](https://github.com/overbench/overbench/issues/384)），以及在多台设备上同时使用一个会话（[#389](https://github.com/overbench/overbench/issues/389)）

## 以后

- [ ] 在改动面板中审阅 diff
- [ ] 跨会话搜索与命令面板
- [ ] 经过 Apple 和 Microsoft 签名的安装包，以及 macOS 上一键安装更新（[#68](https://github.com/overbench/overbench/issues/68)）
- [ ] 从项目的设计系统生成 Artifacts（[#370](https://github.com/overbench/overbench/issues/370)）、直接编辑画布页面（[#371](https://github.com/overbench/overbench/issues/371)），以及把 Word、PowerPoint 和 Excel 文件作为 Artifacts 显示（[#365](https://github.com/overbench/overbench/issues/365)）

还缺什么？[提一个 Issue](https://github.com/overbench/overbench/issues/new/choose)，告诉我们你需要什么。
