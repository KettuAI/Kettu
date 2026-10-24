# 路线图

OverBench 现在有什么、接下来做什么，按版本列出。版本没有固定的发布日期：攒够了改动就发一版，所以这里的先后顺序比时间更可靠。每一项都链接到对应的 Issue，你可以在那里关注进展，或者告诉我们你的需求；完整的列表（包括各项修复）见 [Milestones](https://github.com/overbench/overbench/milestones)。[English](./ROADMAP.md)

## 现在已有

v0.0.2 中：

- 通过 Agent Client Protocol 并排使用 Claude Code、Codex CLI 和 opencode
- 会话历史、多会话并行、子会话，以及从任意一条回复分叉
- 按一个键就能回答的授权卡片，会话需要你时发送通知
- Git 状态与 Pull Request，每个项目都有文件面板和终端
- 所有 Agent 的 token 用量与套餐额度
- macOS、Windows、Linux 预览版，Windows 和 Linux 上自动更新

## v0.0.3：Artifacts 与附件

已合并，将随下一个版本发布：

- [x] Artifacts：Agent 生成的页面和画布，保留历史版本，在隔离的查看器中打开，并有自己的页面（[#11](https://github.com/overbench/overbench/issues/11)）
- [x] 粘贴图片、附加文件和文件夹，用 `@` 引用项目文件（[#134](https://github.com/overbench/overbench/issues/134)、[#135](https://github.com/overbench/overbench/issues/135)、[#137](https://github.com/overbench/overbench/issues/137)）
- [x] Agent 在回复中提到的图片直接显示（[#187](https://github.com/overbench/overbench/issues/187)）
- [x] 每个会话的 Prompt 缓存何时过期（[#21](https://github.com/overbench/overbench/issues/21)）
- [x] 置顶和归档会话（[#36](https://github.com/overbench/overbench/issues/36)）
- [x] 新建会话成为首屏，并显示最近的 Artifacts（[#31](https://github.com/overbench/overbench/issues/31)、[#225](https://github.com/overbench/overbench/issues/225)）
- [x] 更克制的配色和参考设计的信息密度（[#39](https://github.com/overbench/overbench/issues/39)、[#127](https://github.com/overbench/overbench/issues/127)）

## v0.0.4：Routines

- [ ] Routines：按计划自动运行的 Agent 任务（[#22](https://github.com/overbench/overbench/issues/22)）
- [ ] 在设置之外提示 Agent 更新，并可以跳过某个版本（[#35](https://github.com/overbench/overbench/issues/35)）
- [ ] 补全「设置 › Agent」里还缺的信息（[#32](https://github.com/overbench/overbench/issues/32)）

## v0.0.5：用量与控制

- [ ] 用量页面显示请求数和费用，而不只是 token（[#20](https://github.com/overbench/overbench/issues/20)）
- [ ] 自己选择更新何时下载和安装（[#67](https://github.com/overbench/overbench/issues/67)）
- [ ] 打磨模型菜单和斜杠命令弹窗（[#28](https://github.com/overbench/overbench/issues/28)、[#38](https://github.com/overbench/overbench/issues/38)）

## v0.0.6：阅读与导航

- [ ] 对话旁的消息大纲（[#37](https://github.com/overbench/overbench/issues/37)）
- [ ] 重新设计终端标签栏（[#41](https://github.com/overbench/overbench/issues/41)）
- [ ] 重新设计用量弹窗（[#30](https://github.com/overbench/overbench/issues/30)）

## v0.1.0：媒体与浏览器

- [ ] 在对话和文件面板中播放音频和视频（[#43](https://github.com/overbench/overbench/issues/43)）
- [ ] Agent 可以操作的内置浏览器（[#47](https://github.com/overbench/overbench/issues/47)）
- [ ] 长段粘贴保存为附件，支持粘贴从文件管理器复制的文件（[#138](https://github.com/overbench/overbench/issues/138)、[#170](https://github.com/overbench/overbench/issues/170)）
- [ ] macOS 上一键安装更新（[#68](https://github.com/overbench/overbench/issues/68)）

## 以后

- [ ] 在改动面板中审阅 diff
- [ ] 跨会话搜索与命令面板
- [ ] 经过 Apple 和 Microsoft 签名的安装包

还缺什么？[提一个 Issue](https://github.com/overbench/overbench/issues/new/choose)，告诉我们你需要什么。
