# Roadmap

What Kettu has and what comes next, release by release. Releases have no fixed dates: a core feature ships as soon as it is done, and smaller fixes with the next release, so the order here is firmer than the timing. Each item links to its issue, where you can follow it or tell us what you need; the [milestones](https://github.com/KettuAI/Kettu/milestones) hold the full lists, fixes included. [简体中文](./ROADMAP.zh-CN.md)

## Available now

In [v0.0.30](https://github.com/KettuAI/Kettu/releases/tag/v0.0.30):

- Claude Code, Codex, OpenCode, Pi and more than 40 other agents side by side, with Claude Code and Codex through their own interfaces, each agent turned off without losing its sessions, and a session handed to another agent between turns
- Parallel sessions, subagents and forks from any reply, split into up to nine panes, with the sidebar showing which session is working, waiting for you or done
- Permission cards answered with one key, an agent's questions answered in one card, its plan in the top bar, a queue to steer a running turn, replies to a selected passage, and notifications
- Diffs, Git status and pull requests, GitHub references in replies, the Files pane in tabs, a terminal for each session, and a built-in browser that agents can drive
- Artifacts: pages, documents, slides and canvases with their versions; comments the agent reads, a canvas edited directly, presenting, exports to Word, Markdown, PowerPoint and PDF, and pages published to kettu.page, private, behind an access code or public
- Mobile devices: iOS simulators, Android emulators and real phones beside the session, for you and the agent
- Computer use: agents use the apps on your computer once you turn it on
- Routines, token usage and cost with each account's plan limits, and one command palette for sessions, artifacts, routines, projects, settings and actions
- Your sessions on your other devices over your own network: pairing, direct connections, another computer's Kettu, and development machines added over SSH with the daemon set up for you
- The official cloud with a Kettu account: the relay that reaches your computers from any network, and the web client at app.kettu.sh
- Problem reports sent from the app, light and dark modes, themes from a file or the online catalog, and English and Simplified Chinese
- Builds for macOS on Apple silicon, signed and notarized by Apple, and for Windows and Linux on x64 and Arm, with updates that install when you choose

## v0.1.0: the desktop app complete

- [ ] Every part of the desktop app finished and checked against its design
- [ ] Windows builds signed by Microsoft, and one-click macOS updates checked from one release to the next ([#68](https://github.com/KettuAI/Kettu/issues/68))
- [ ] Take a session back to before any message, with the agent's file changes after it undone ([#615](https://github.com/KettuAI/Kettu/issues/615))
- [ ] Each session's MCP servers with their status ([#617](https://github.com/KettuAI/Kettu/issues/617))
- [ ] Parallel sessions in their own Git worktrees ([#618](https://github.com/KettuAI/Kettu/issues/618)), and the changes of a session or a turn reviewed in one place ([#619](https://github.com/KettuAI/Kettu/issues/619))
- [ ] A session's pull request watched, with its agent woken when checks fail, conflicts appear or a review comes in ([#621](https://github.com/KettuAI/Kettu/issues/621))

## v0.2.0: your sessions on your other devices, over your own network

Available now, apart from:

- [ ] Files read-only in the web client on a phone, where edits are left to the agent ([#749](https://github.com/KettuAI/Kettu/issues/749))

## v0.3.0: the official cloud

The relay, the web client at app.kettu.sh and the Kettu account are available now. Still to come:

- [ ] Notifications on your other devices when a session needs you ([#388](https://github.com/KettuAI/Kettu/issues/388))
- [ ] The web client laid out for a phone's width, which Android phones use until there is an app ([#712](https://github.com/KettuAI/Kettu/issues/712))

## v0.4.0: the iOS app

- [ ] A native app for iPhone and iPad ([#383](https://github.com/KettuAI/Kettu/issues/383)): your sessions, permission requests answered from the lock screen and notifications, a share extension and a usage widget

## Later

- [ ] A native Android app
- [ ] Search across all sessions by what was said in them ([#622](https://github.com/KettuAI/Kettu/issues/622))
- [ ] Word, PowerPoint and Excel files agents create shown as artifacts ([#365](https://github.com/KettuAI/Kettu/issues/365)), artifacts built from a project's design system ([#370](https://github.com/KettuAI/Kettu/issues/370)), and exports to PNG ([#367](https://github.com/KettuAI/Kettu/issues/367))
- [ ] Skills and plugins managed in Settings ([#488](https://github.com/KettuAI/Kettu/issues/488), [#489](https://github.com/KettuAI/Kettu/issues/489)), and a session's background tasks ([#495](https://github.com/KettuAI/Kettu/issues/495))

Missing something? [Open an issue](https://github.com/KettuAI/Kettu/issues/new/choose) and tell us what you need.
