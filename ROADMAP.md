# Roadmap

What Kettu has and what comes next, release by release. Releases have no fixed dates: a core feature ships as soon as it is done, and smaller fixes with the next release, so the order here is firmer than the timing. Each item links to its issue, where you can follow it or tell us what you need; the [milestones](https://github.com/KettuAI/Kettu/milestones) hold the full lists, fixes included. [简体中文](./ROADMAP.zh-CN.md)

## Available now

In [v0.0.1](https://github.com/KettuAI/Kettu/releases/tag/v0.0.1):

- Claude Code, Codex, opencode and more than 40 other agents side by side, with Claude Code and Codex through their own interfaces
- Session history, parallel sessions, sub-sessions and forks from any reply, and an outline of your messages to jump between them
- Permission cards answered with one key, notifications, and a prompt cache countdown
- Git status and pull requests, a files pane and a terminal for each project, and a built-in browser that agents can drive and that keeps your sign-ins
- Token usage, requests and cost across agents, with plan limits
- Artifacts: the pages and canvases agents create, with their versions, an isolated viewer and a link to share them online
- Attachments: files, folders and images from the composer, the clipboard or `@` mentions, with images, video and audio shown in replies, tool calls and the files pane
- Routines: agent tasks that run on a schedule within a permission scope, pause near a plan limit and keep their runs
- Themes from a file or an online catalog, in light and dark, with the Paper look built in
- Kettu keeps running in the background, with a tray icon, after you close its window
- Preview builds for macOS, Windows and Linux, the macOS ones signed and notarized by Apple, with updates that install when you choose

## v0.1.0: the desktop app complete

- [ ] Every part of the desktop app finished and checked against its design
- [ ] Windows builds signed by Microsoft, and one-click macOS updates checked from one release to the next ([#68](https://github.com/KettuAI/Kettu/issues/68))
- [ ] Take a session back to before any message, with the agent's file changes after it undone ([#615](https://github.com/KettuAI/Kettu/issues/615))
- [ ] An agent's multiple-choice questions as cards you answer with a click ([#616](https://github.com/KettuAI/Kettu/issues/616)), and each session's MCP servers with their status ([#617](https://github.com/KettuAI/Kettu/issues/617))
- [ ] Parallel sessions in their own Git worktrees ([#618](https://github.com/KettuAI/Kettu/issues/618)), and the changes of a session or a turn reviewed in one place ([#619](https://github.com/KettuAI/Kettu/issues/619))
- [ ] A session's pull request watched, with its agent woken when checks fail, conflicts appear or a review comes in ([#621](https://github.com/KettuAI/Kettu/issues/621))

## v0.2.0: your sessions on your other devices, over your own network

- [ ] Use your sessions from your other devices ([#377](https://github.com/KettuAI/Kettu/issues/377)): pair them and choose which can connect ([#380](https://github.com/KettuAI/Kettu/issues/380)), and connect directly over any network you set up, such as the same network, a VPN like Tailscale or a forwarded port ([#581](https://github.com/KettuAI/Kettu/issues/581)), with Kettu running without its window ([#378](https://github.com/KettuAI/Kettu/issues/378)); no account needed
- [ ] Kettu as a daemon on Linux and macOS development machines, started with the system ([#649](https://github.com/KettuAI/Kettu/issues/649)) and installed with one command ([#658](https://github.com/KettuAI/Kettu/issues/658)), added from the desktop app by its SSH address, with Kettu installed or upgraded there for you ([#650](https://github.com/KettuAI/Kettu/issues/650))
- [ ] Use another computer's Kettu from the desktop app ([#384](https://github.com/KettuAI/Kettu/issues/384)), with every host's sessions in one place and the ones that need you easy to spot
- [ ] Answer permission requests ([#385](https://github.com/KettuAI/Kettu/issues/385)), see files, changes and artifacts ([#386](https://github.com/KettuAI/Kettu/issues/386)) and open the terminal ([#387](https://github.com/KettuAI/Kettu/issues/387)) on a remote device, work in one session from several devices at once ([#389](https://github.com/KettuAI/Kettu/issues/389)), and let an agent on another host use the browser ([#651](https://github.com/KettuAI/Kettu/issues/651))

## v0.3.0: the official cloud

- [ ] Reach your hosts from outside your network through the official relay ([#381](https://github.com/KettuAI/Kettu/issues/381)), with a Kettu account, which only the official services need
- [ ] A web client, which Android phones and tablets use too ([#382](https://github.com/KettuAI/Kettu/issues/382))
- [ ] Notifications on remote devices ([#388](https://github.com/KettuAI/Kettu/issues/388))

## v0.4.0: the iOS app

- [ ] A native app for iPhone and iPad ([#383](https://github.com/KettuAI/Kettu/issues/383)): your sessions, permission requests answered from the lock screen and notifications, a share extension and a usage widget

## Later

- [ ] A native Android app
- [ ] Search across all sessions by what was said in them ([#622](https://github.com/KettuAI/Kettu/issues/622))
- [ ] Slide decks as artifacts ([#368](https://github.com/KettuAI/Kettu/issues/368)), exports to PDF, PNG and PowerPoint ([#367](https://github.com/KettuAI/Kettu/issues/367)), comments on part of an artifact ([#366](https://github.com/KettuAI/Kettu/issues/366)), and the data an artifact's page keeps reaching the agent ([#369](https://github.com/KettuAI/Kettu/issues/369))
- [ ] Skills and plugins managed in Settings ([#488](https://github.com/KettuAI/Kettu/issues/488), [#489](https://github.com/KettuAI/Kettu/issues/489)), and a session's background tasks ([#495](https://github.com/KettuAI/Kettu/issues/495))
- [ ] Artifacts built from a project's design system ([#370](https://github.com/KettuAI/Kettu/issues/370)), a canvas page edited directly ([#371](https://github.com/KettuAI/Kettu/issues/371)), and Word, PowerPoint and Excel files as artifacts ([#365](https://github.com/KettuAI/Kettu/issues/365))

Missing something? [Open an issue](https://github.com/KettuAI/Kettu/issues/new/choose) and tell us what you need.
