# Roadmap

What OverBench has and what comes next, release by release. Releases have no fixed dates: a core feature ships as soon as it is done, and smaller fixes with the next release, so the order here is firmer than the timing. Each item links to its issue, where you can follow it or tell us what you need; the [milestones](https://github.com/overbench/overbench/milestones) hold the full lists, fixes included. [简体中文](./ROADMAP.zh-CN.md)

## Available now

In v0.0.5:

- Claude Code, Codex CLI and opencode side by side, over the Agent Client Protocol
- Session history, parallel sessions, sub-sessions and forks from any reply, and an outline of your messages to jump between them
- Permission cards answered with one key, notifications, and a prompt cache countdown
- Git status and pull requests, a files pane and a terminal for each project, and a browser pane that keeps your sign-ins
- Token usage, requests and cost across agents, with plan limits
- Artifacts: the pages and canvases agents create, with their versions, an isolated viewer and a link to share them online
- Attachments: files, folders and images from the composer, the clipboard or `@` mentions, with images, video and audio in replies shown in place
- Routines: agent tasks that run on a schedule within a permission scope, pause near a plan limit and keep their runs
- Themes from a file or an online catalog, in light and dark
- A redrawn model menu, slash command list, usage popover and terminal tabs, with quiet depth on controls and surfaces
- Preview builds for macOS, Windows and Linux, with updates on Windows and Linux that install when you choose

## v0.0.6: the rest of the core features

Merged, and shipping with this release:

- [x] On macOS, a command that sends Apple Events gets the system's permission prompt instead of a refusal ([#133](https://github.com/overbench/overbench/issues/133))

Still to come:

- [ ] Images, audio and video in tool calls and the Files pane ([#43](https://github.com/overbench/overbench/issues/43), [#312](https://github.com/overbench/overbench/issues/312)), zoom, step and copy in the image viewer ([#311](https://github.com/overbench/overbench/issues/311)), and audio and video bytes in the conversation ([#313](https://github.com/overbench/overbench/issues/313))
- [ ] The sidebar's header and footer ([#34](https://github.com/overbench/overbench/issues/34)), the logo, app icon and license in About ([#33](https://github.com/overbench/overbench/issues/33)), and the code aligned with the design guides ([#29](https://github.com/overbench/overbench/issues/29))
- [ ] Smaller fixes: long reasoning folded into its run ([#333](https://github.com/overbench/overbench/issues/333)), clickable links in notices ([#345](https://github.com/overbench/overbench/issues/345)), a slash command highlighted as it is typed ([#363](https://github.com/overbench/overbench/issues/363)), Recent artifacts hidden while the composer has input ([#391](https://github.com/overbench/overbench/issues/391)), a redesigned link confirmation ([#246](https://github.com/overbench/overbench/issues/246)), collapsed work rows without the gaps between them ([#244](https://github.com/overbench/overbench/issues/244)), Codex thoughts from history with their headings apart ([#267](https://github.com/overbench/overbench/issues/267)), and more in the [milestone](https://github.com/overbench/overbench/milestone/11)

## v0.0.7: the built-in browser and more agents

- [ ] A built-in browser agents can drive ([#47](https://github.com/overbench/overbench/issues/47), [#317](https://github.com/overbench/overbench/issues/317)), asking before an agent opens a new site ([#318](https://github.com/overbench/overbench/issues/318))
- [ ] Cursor, GitHub Copilot CLI, Gemini CLI and Pi as agents ([#350](https://github.com/overbench/overbench/issues/350), [#351](https://github.com/overbench/overbench/issues/351), [#352](https://github.com/overbench/overbench/issues/352), [#353](https://github.com/overbench/overbench/issues/353))

## v0.1.0: more agents and artifacts

- [ ] Qwen Code, Kimi Code, Amp, Factory Droid, Devin CLI, Goose, Cline, Kilo Code and Grok as agents ([#354](https://github.com/overbench/overbench/issues/354), [#355](https://github.com/overbench/overbench/issues/355), [#356](https://github.com/overbench/overbench/issues/356), [#357](https://github.com/overbench/overbench/issues/357), [#358](https://github.com/overbench/overbench/issues/358), [#359](https://github.com/overbench/overbench/issues/359), [#360](https://github.com/overbench/overbench/issues/360), [#361](https://github.com/overbench/overbench/issues/361), [#362](https://github.com/overbench/overbench/issues/362))
- [ ] Slide decks as artifacts ([#368](https://github.com/overbench/overbench/issues/368)), export as PDF, PNG, PowerPoint or a zip of pages ([#367](https://github.com/overbench/overbench/issues/367)), comments on a part of an artifact sent to the agent ([#366](https://github.com/overbench/overbench/issues/366)), and artifact data reaching the agent and its exports ([#369](https://github.com/overbench/overbench/issues/369))

## v0.2.0: your sessions from other devices

- [ ] Control OverBench from a web client and an app for phones and tablets ([#377](https://github.com/overbench/overbench/issues/377), [#382](https://github.com/overbench/overbench/issues/382), [#383](https://github.com/overbench/overbench/issues/383))
- [ ] Pair devices and choose which can connect ([#380](https://github.com/overbench/overbench/issues/380)), reach the computer from outside the home network ([#381](https://github.com/overbench/overbench/issues/381)), and keep OverBench running without its window ([#378](https://github.com/overbench/overbench/issues/378))
- [ ] Answer permission requests ([#385](https://github.com/overbench/overbench/issues/385)), follow files, changes and artifacts ([#386](https://github.com/overbench/overbench/issues/386)), open the terminal ([#387](https://github.com/overbench/overbench/issues/387)) and get notified ([#388](https://github.com/overbench/overbench/issues/388)) from a remote device
- [ ] Use another computer's OverBench from the desktop app ([#384](https://github.com/overbench/overbench/issues/384)), and work in one session from several devices ([#389](https://github.com/overbench/overbench/issues/389))

## Later

- [ ] A changes panel for reviewing diffs
- [ ] Search across sessions and a command palette
- [ ] Builds signed by Apple and Microsoft, and macOS updates that install in one click ([#68](https://github.com/overbench/overbench/issues/68))
- [ ] Artifacts built from a project's design system ([#370](https://github.com/overbench/overbench/issues/370)), a canvas page edited directly ([#371](https://github.com/overbench/overbench/issues/371)), and Word, PowerPoint and Excel files as artifacts ([#365](https://github.com/overbench/overbench/issues/365))

Missing something? [Open an issue](https://github.com/overbench/overbench/issues/new/choose) and tell us what you need.
