# Roadmap

What Kettu has and what comes next. Releases have no fixed dates: a feature ships as soon as it is done, and smaller fixes with the next release, so the order here is firmer than the timing. Each item links to its issue, where you can follow it or tell us what you need; the [release notes](https://github.com/KettuAI/Kettu/releases) list everything that shipped, fixes included. [简体中文](./ROADMAP.zh-CN.md)

## Available now

In [v0.1.13](https://github.com/KettuAI/Kettu/releases/tag/v0.1.13):

- 48 agents, Claude Code, Codex, OpenCode, Pi and more, with your own installs, accounts and settings, each turned off without losing its sessions, and a session handed to another agent between turns
- Parallel sessions, subagents and forks from any reply, Git worktrees Kettu creates and cleans up, and up to nine panes, with the sidebar showing which session is working, waiting for you or done
- Permission requests answered with one key, an agent's questions in one card, its plan in the top bar, a queue to steer a running turn, replies to a selected passage, and notifications
- Hand-offs from one agent to another, Workflows that run a task through steps with a session for each, and an Overview of every session and task
- Diffs, Git status and pull requests, GitHub references in replies, the Files pane in tabs, a terminal for each session, and a built-in browser that agents can drive
- Artifacts: pages, documents, slides and canvases with their versions, comments the agent reads, exports to Word and PowerPoint, and pages published to kettu.page, private, behind an access code or public
- Mobile devices beside the session, for you and the agent, and computer use once you turn it on
- Routines, usage and cost with each account's plan limits, the Marketplace for plugins, skills, MCP servers and workflows, and one command palette for everything
- Your sessions everywhere: any browser at app.kettu.sh through the Kettu relay, your own network without an account, another computer's Kettu, and development machines added over SSH, all end-to-end encrypted
- The iPhone and iPad app, in [public beta on TestFlight](https://testflight.apple.com/join/zsbFyAPQ)
- Light and dark modes, themes, English and Simplified Chinese, and problem reports sent from the app
- Builds for macOS on Apple silicon and Intel, signed and notarized by Apple, and for Windows and Linux on x64 and Arm, plus a daemon and a Docker image for servers

## Next

- [ ] What every session is doing, shown in the MacBook's notch and answered there ([#2053](https://github.com/KettuAI/Kettu/issues/2053), [#2059](https://github.com/KettuAI/Kettu/issues/2059))
- [ ] Antigravity's teamwork sub-agents under their session, and its questions in the question card ([#1695](https://github.com/KettuAI/Kettu/issues/1695), [#1696](https://github.com/KettuAI/Kettu/issues/1696))
- [ ] More of a computer's state on your other devices: whether its cloud and computer use are on, and its diagnostics ([#1584](https://github.com/KettuAI/Kettu/issues/1584), [#1596](https://github.com/KettuAI/Kettu/issues/1596), [#1597](https://github.com/KettuAI/Kettu/issues/1597))

## Being considered

Asked for and being weighed. A thumbs-up on the issue helps:

- [ ] Side-by-side diffs ([#1916](https://github.com/KettuAI/Kettu/issues/1916)), and undoing the file changes of one turn ([#1789](https://github.com/KettuAI/Kettu/issues/1789))
- [ ] Each turn's cost and tokens under its reply ([#1918](https://github.com/KettuAI/Kettu/issues/1918))
- [ ] Handing a task to another agent straight from the composer ([#2058](https://github.com/KettuAI/Kettu/issues/2058))
- [ ] Marking up a page in the built-in browser for the agent ([#1812](https://github.com/KettuAI/Kettu/issues/1812))
- [ ] Exporting a conversation to a file ([#1836](https://github.com/KettuAI/Kettu/issues/1836)), uploading files into a project ([#1838](https://github.com/KettuAI/Kettu/issues/1838)) and previewing PDF and Word files ([#1839](https://github.com/KettuAI/Kettu/issues/1839))
- [ ] Your own font, weight and size for the interface, replies and code ([#1841](https://github.com/KettuAI/Kettu/issues/1841))

## Later

- [ ] A native Android app, after the iPhone and iPad app
- [ ] Devices connecting to your computers directly through NAT traversal ([#1527](https://github.com/KettuAI/Kettu/issues/1527))
- [ ] More agents on their own interfaces instead of ACP: GitHub Copilot, Cursor, OMP, Muse Code and Amp ([#2021](https://github.com/KettuAI/Kettu/issues/2021)), then Kilo Code, Qoder and Factory Droid ([#2022](https://github.com/KettuAI/Kettu/issues/2022))

Missing something? [Open an issue](https://github.com/KettuAI/Kettu/issues/new/choose) and tell us what you need.
