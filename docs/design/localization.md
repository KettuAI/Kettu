# Localization

> Status: Draft · Languages: English and Simplified Chinese · Library approved by the maintainer on 2026-10-21

OverBench's interface speaks English and Simplified Chinese. The user picks one in Settings › General › Language, or lets it follow the system, and the whole app switches at once, without a restart: the window, the macOS menu, native dialog titles, OS notifications and the text the agent host writes. What agents say is never translated.

## Languages and the setting

| Locale  | Name     | Role                                                    |
| ------- | -------- | ------------------------------------------------------- |
| `en`    | English  | The source language, and the fallback for a missing key |
| `zh-CN` | 简体中文 | Translated from English                                 |

- The setting is `general.language`: `system` (the default), `en` or `zh-CN` ([persistence](./persistence.md#settings)). Settings shows each language in its own words, so a user who cannot read the current one still finds theirs.
- **System** takes the first of the operating system's preferred languages that OverBench speaks (`app.getPreferredSystemLanguages()`), else English. Only Simplified Chinese matches `zh-CN`: a tag is expanded with `Intl.Locale.maximize()`, so `zh`, `zh-CN` and `zh-SG` match, while `zh-TW` and `zh-HK`, which expand to the Traditional script, move on down the list.
- Main reads the system's languages once at startup. macOS and Windows ask the user to log out or restart apps after changing them anyway.
- `src/shared/locale.ts` holds the languages, the matching and the resolution; main, the preload and the renderer share it.

## What is translated

Everything OverBench writes itself, in all three processes:

| Process    | Text                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer   | Every screen, menu, tooltip, `aria-label`, empty and error state, and relative times, durations, dates and numbers through `Intl`       |
| Main       | The macOS menu, including Electron's role items, whose own labels are English only; native dialog titles; the native quit confirmation  |
| Agent host | Thread notices it adds, request errors, agent detection and install guidance, the environment warning, OS notification text it composes |

Never translated:

- Agent output: messages, thoughts, tool call titles, notices an agent sends, model, mode and option names, slash commands, and errors an agent returns. They are the agent's own words.
- What the user writes, and what comes from git, GitHub, npm or a shell: branch names, commit subjects, program output.
- Product names (OverBench, Claude Code, Codex, OpenCode, Git, GitHub, npm, Node.js), key names in shortcuts, paths and commands.
- Logs and diagnostics, which stay in English so that a bug report reads the same for everyone.
- What the operating system draws: open and save panels' buttons, the items macOS adds to the Edit menu, and Enter Full Screen, which macOS renames as it toggles. They follow the system's language.

## Switching

The renderer, main and the agent host each translate their own text, as VS Code's processes do, but they switch live instead of on restart.

- **Renderer**: `general.language` changes in the settings store, and `applyLanguage` (`src/renderer/src/lib/i18n.ts`) calls `i18next.changeLanguage`. Every component that reads text through `useTranslation()` re-renders; nothing remounts, so drafts, scroll positions and open popovers stay. It also sets `<html lang>`, which picks the Han glyphs from the font stack (PingFang SC, Microsoft YaHei, Noto Sans CJK SC) and tells screen readers the language.
- **Main**: on a settings change that resolves to another language, main switches its own i18next instance and rebuilds the macOS menu. Dialogs and the quit confirmation read their text when they open.
- **Agent host**: `HostSettings.locale` comes with `host:init` and every `host:settings` ([agent host](./agent-host.md#main-and-host-messages)). On a change the host detects every agent again, so idle agents' install guidance is rewritten, and sends `environment.changed`, whose warning is kept as a message key and translated each time it is sent.
- Text already written stays in the language it was written in: notices in a thread, an error shown in a toast or on a failed card, an OS notification on screen. They are records of something that happened, and the next ones follow the new language.

### The first frame

The renderer's first render waits for `settings:get`, one IPC round trip, so the first frame already has the user's language and text size instead of switching a frame later. Main passes the system's language to each window as `--overbench-system-locale=<locale>` in `additionalArguments`; the preload validates it and exposes it as `window.overbench.systemLocale`, which the renderer needs to resolve **System** on its own. A window reload therefore never shows a stale language.

## Catalogs

```text
src/shared/
├── locale.ts             Languages, matching, resolution, shared i18next options
├── i18next.d.ts          Types every t() key against the English catalog
└── locales/
    ├── en/               One JSON file per namespace
    └── zh-CN/            The same files with the same keys
```

- **Namespaces**: `common` for words several areas share (actions, relative times, plan window names, the file manager's name); one per renderer area (`session`, `composer`, `settings`, `sidebar`, `git`, `files`, `terminal`, `home`, `agents`, `shell`, `updates`, `app`); `main` for main; `host` for the agent host.
- **Loading**: each process bundles only what it shows. The renderer takes every namespace but `main` and `host` with `import.meta.glob`; main imports `main.json`; the host imports `host.json`. Both languages are bundled, since loading one on demand would hold the first paint: with i18next and react-i18next they add 104 kB to the JavaScript a window loads at startup (34 kB gzipped; each language's renderer catalog is about 28 kB of JSON), measured on a production build on 2026-10-21.
- **Types**: `i18next.d.ts` declares every namespace's English JSON as i18next's resources, so a key that does not exist fails the type check in every process.
- **Parity**: `src/shared/locales/locales.test.ts` checks that every language has the same namespaces and keys, a plural `_other` form for every plural key, the same `{{placeholders}}` in every message, non-empty text, and that `i18next.d.ts` types every namespace.

## Writing messages

- Keys are semantic camelCase, nested by area (`notice.cancelUnconfirmed.title`), never the English text. The English value is the source; change the English and the Chinese together.
- One message per sentence, with `{{placeholders}}` for what varies; never glue translated fragments together, since word order differs between languages.
- Plurals pass `count`: English has `_one` and `_other`, Chinese only `_other`.
- Markup inside a sentence (a link, `<code>`, `<Kbd>`) goes through react-i18next's `<Trans>` with named components.
- Components call `useTranslation('<namespace>')`, adding `'common'` when they use it. Code outside React calls `i18n.t()` at the time it shows the text, never at module load, so a language change reaches it.
- A component that shows translated text from anywhere, its own or a helper's such as `shortAgo()`, calls `useTranslation()` itself, so it re-renders on a switch; memoized text lists `t` in its dependencies.

### Chinese copy

Concise, natural Simplified Chinese, as a polished Chinese desktop app writes it: full-width punctuation in Chinese sentences, a space between Chinese and Latin letters or digits ("打开 Claude Code", "3 个文件") but none beside full-width punctuation, "你" rather than "您" and only where needed, and the macOS terms where the menu has them (拷贝, 显示, 前置全部窗口). Terms follow one glossary:

| English                                  | 中文                               |
| ---------------------------------------- | ---------------------------------- |
| session, project                         | 会话，项目                         |
| agent, subagent                          | Agent，子 Agent                    |
| thread, turn, message                    | 对话，本轮对话，消息               |
| composer                                 | 输入框                             |
| permission request; allow, deny          | 授权请求；允许，拒绝               |
| tool call, thinking, plan (an agent's)   | 工具调用，思考，计划               |
| plan (a subscription), usage, limit      | 套餐，用量，限额                   |
| context, token, compaction               | 上下文，token，压缩上下文          |
| model, mode, reasoning level             | 模型，模式，推理强度               |
| terminal, shell                          | 终端，Shell                        |
| branch, commit, push, pull, fetch        | 分支，提交，推送，拉取，抓取       |
| pull request, diff, changes              | Pull Request，差异，更改           |
| sign in, sign out                        | 登录，退出登录                     |
| proxy, environment, diagnostics          | 代理，环境，诊断信息               |
| theme System, Light, Dark; Reduce motion | 跟随系统，浅色，深色；减弱动态效果 |

"Agent" stays in English because "代理" already means the proxy in Settings, and Chinese developer writing uses the English word.

## Adding a language

1. Add it to `LOCALES` and `LOCALE_NAMES` in `src/shared/locale.ts`, and to `matchLocale` with its tests.
2. Copy `src/shared/locales/en/` to the new folder and translate every file; the parity test lists what is missing.
3. Check every screen in it, light and dark, at the narrowest window: longer languages are where labels truncate.

## Alternatives considered

| Option                                | Why not                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **i18next with react-i18next**        | Chosen. What AionUi, Cherry Studio and LobeHub use for the same job; plurals through `Intl.PluralRules`, typed keys, runs in main and the host too, JSON that translation tools read |
| Typed TypeScript catalogs, no library | No bytes added and parameters checked by the compiler, but a message layer of our own and catalogs that translation tools cannot read                                                |
| Paraglide JS                          | Compiled, tree-shaken messages, the smallest runtime; but a compiler step, and switching the language in a running React app needs a re-render of our own                            |
| react-intl (FormatJS)                 | ICU messages, but a larger runtime, and nothing for main and the host                                                                                                                |
| VS Code's NLS                         | Built for VS Code's build, and switching the language needs a restart                                                                                                                |
