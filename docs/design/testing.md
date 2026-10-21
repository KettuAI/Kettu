# Testing and performance verification

> Status: Draft · Set up in [M0.1](../milestones/m0.md#work-packages), budgets verified in M0.5

OverBench runs on macOS, Windows and Linux, and most of what can differ between them lives in the agent host. The strategy follows from that: test the protocol and process logic automatically on all three platforms with a fake agent, and check the interface and the real agents by hand before each milestone is signed off.

## Layers

| Layer       | Tool                            | What it covers                                                                                                                                                                                  | Where it runs          |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Unit        | Vitest                          | `applyPatches`, the ACP v1 mapper, request validators, shell environment parsing, command lookup with `PATHEXT`, shell quoting, path canonicalization, persistence migrations and atomic writes | CI on all platforms    |
| Integration | Vitest with the fake agent      | The host's session logic against a real ACP peer: turns, permissions, cancellation, load and resume, auth errors, unknown updates                                                               | CI on all platforms    |
| Process     | Vitest, spawning the fake agent | Stdio framing, the termination sequence and process tree cleanup, crash detection and restart                                                                                                   | CI on all platforms    |
| Interface   | The running app                 | Every screen and state in both themes, with reduce-motion on, against the fake agent; IME input in the composer; the thread's scroll-following thresholds                                       | By hand, each platform |
| Real agents | The running app                 | The M0 acceptance tasks with Claude Code, Codex and OpenCode                                                                                                                                    | By hand, each platform |
| Performance | CDP script and the fake agent   | The [M0 budgets](../milestones/m0.md#performance-budgets) on a production build                                                                                                                 | By hand, each platform |

React components have no automated tests in M0; they are checked by running the app, as [AGENTS.md](../../AGENTS.md#definition-of-done) requires for every UI change.

## Unit and integration tests

- Test files sit next to the code they test, named `*.test.ts`.
- `vitest.config.ts` at the root runs in the `node` environment and resolves the `@shared` and `@renderer` aliases like `electron.vite.config.ts`.
- `pnpm test` runs everything once; `pnpm test:watch` runs Vitest in watch mode.
- The mapper is tested with fixtures: recorded or hand-written sequences of ACP messages, each with the patches and final snapshot it must produce. A bug found with a real agent becomes a fixture first.
- Integration tests connect the host's session layer to the fake agent in-process: the agent's `AgentApp` and the host's client talk through an in-memory stream pair (`inProcessTransport` in `src/agent-host/acp/connection.ts`), so they need no subprocess and stay fast. The host's connection code therefore accepts either a process's stdio or an in-process agent.
- `src/agent-host/testing/harness.ts` holds what they share. `startTestHost()` runs a whole host, as `index.ts` builds it, on a temporary data directory, with an in-process launcher for the fake agent, a stubbed shell environment and no other agent found. `TestPort` stands in for a renderer port: it structured-clones every message both ways, as a real `MessagePort` does, so a payload that would not survive the port fails the test, and it keeps a replica of each watched thread by applying the batches with `applyPatches`, failing on any `seq` gap. Tests compare that replica with `sessions.snapshot`.
- Timings that matter to a test are options rather than constants: the 16 ms flush, the 10 s cancel fallback, the `initialize` timeouts, restart delays and the idle stop, so tests run them in milliseconds instead of with fake timers.
- Process tests spawn `tools/fake-agent/main.ts` with `process.execPath`, never a shell, so they run the same on every platform. They cover framing and a clean EOF stop, a forced stop of a process tree, `SIGKILL` escalation (skipped on Windows, which has no `SIGTERM` to ignore; `taskkill /F` always ends the tree), and a whole host whose agent crashes mid-turn, restarts and resumes the session.
- Tests that touch the file system use a fresh temporary directory.

## Fake agent

`tools/fake-agent/` is an ACP agent built with the SDK's `agent()` API. It never calls a model; it plays scripted scenarios.

- **Running it**: `tools/fake-agent/main.ts` runs directly on Node.js through type stripping, either with Electron's own Node.js (`ELECTRON_RUN_AS_NODE=1`) or with any Node.js 22.18 or later. It has no build step, so its code uses only erasable TypeScript syntax and relative imports with `.ts` extensions; its folder has a `package.json` with `"type": "module"`. `tsconfig.tools.json` type-checks it with `erasableSyntaxOnly` and `allowImportingTsExtensions`, and `pnpm typecheck` includes it.
- **In process**: `tools/fake-agent/agent.ts` exports `createFakeAgent(options)`, which returns the SDK's `AgentApp`. Integration tests connect it to the host's session layer through an in-memory stream pair; `options.exit` replaces `process.exit` so the `crash` scenario closes the connection instead of ending the test run. Tests load it with a dynamic `import()` of its file URL, because the host's `tsconfig.node.json` does not allow `.ts` import extensions; `tsconfig.tools.json` still type-checks it.
- **Choosing a scenario**: the prompt text selects it with `/scenario <name> [flags]` or `/<name> [flags]`, so one agent process can run any scenario; any other text runs the default (`FAKE_AGENT_SCENARIO`, else `basic-turn`). The agent advertises every scenario as a slash command, plus `scenario` and `compact`.
- **Protocol surface**: it uses the SDK's `unstable` v1 entrypoint so it can send the subagents RFD updates, and it advertises `loadSession`, `session/list`, `session/resume`, `session/close`, `session/delete`, logout, one `agent` sign-in method (`fake-login`) and, when the client supports terminal sign-in, one `terminal` method (`fake-terminal-login`, which runs `main.ts --login`). Its config options are a mode select (Ask, Code, Plan), a grouped model select with three models, a `thought_level` select and one boolean (Fast mode). It pushes `_auth/status_update` once after `initialize` and whenever its sign-in state changes, and sends `usage_update` with `_meta["_claude/rateLimit"]` for the five-hour and weekly windows at the end of most turns, with `utilization` as a fraction and `resetsAt` in Unix seconds, as Claude Code does. It sends subagent updates only when the client advertised `clientCapabilities.subagents`; the RFD has no agent capability.
- **In the app**: development builds list it in the agent catalog as Fake agent. A production build lists it only when started with `OVERBENCH_FAKE_AGENT` set to the path of `main.ts`, which is how the performance runs use it. It is never packaged.

| Scenario               | What it does                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic-turn`           | A short answer with markdown (heading, list, code block, table, inline code, link) and one edit with a diff                                                     |
| `long-stream`          | 200 KB of markdown in 100-character chunks at a configurable rate (default 200 updates per second); `--rate`, `--size`                                          |
| `tool-storm`           | 500 tool calls, mixing reads, searches, edits, commands, fetches and thoughts, with two updates each; `--count`                                                 |
| `permission`           | A command that needs approval, offering all four option kinds; `--withdraw [ms]` withdraws the request after a delay                                            |
| `parallel-permissions` | Three tool calls asking for permission at the same time                                                                                                         |
| `cancel`               | A long turn that honors `session/cancel`; with `--ignore-cancel` it never confirms                                                                              |
| `crash`                | Exits mid-turn with a non-zero code (`--code`, default 3)                                                                                                       |
| `auth-required`        | Signs the agent out and fails the prompt with `auth_required`; `session/new`, `load`, `resume` and `prompt` then fail until `authenticate` or `main.ts --login` |
| `large-history`        | Marks the session so that `session/load` replays 1,000 entries; the importable session `large-history-1` does the same                                          |
| `slow-start`           | Takes 20 s to answer `initialize`, printing progress to stderr; chosen at launch with `FAKE_AGENT_SCENARIO=slow-start`, since it happens before any prompt      |
| `all-updates`          | Sends every `session/update` variant once, including every content block kind, the subagent updates and an unknown `future_update`                              |
| `subagent`             | Announces a child session, sends it a `session_message`, streams its work including one permission request on the child, and ends the child with `idle`         |
| `plan`                 | A four-item plan whose items progress while the agent reads files                                                                                               |
| `thinking`             | A long thought streamed token by token, then an answer                                                                                                          |

Without a scenario it plays `basic-turn`. `/compact` streams a compaction with its summary. Replies stream with tens of milliseconds between chunks, like a real agent.

Environment variables, read when the agent starts:

| Variable                             | Effect                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `FAKE_AGENT_SCENARIO`                | The scenario for prompts that name none; `slow-start` also delays `initialize`             |
| `FAKE_AGENT_RATE`, `_SIZE`, `_COUNT` | Defaults for `--rate`, `--size` (such as `200k`) and `--count`                             |
| `FAKE_AGENT_DELAY_SCALE`             | Multiplies every delay; `0` runs scenarios as fast as possible, which the tests use        |
| `FAKE_AGENT_SLOW_START_MS`           | Delays `initialize` by this long, printing progress                                        |
| `FAKE_AGENT_AUTH=required`           | Starts signed out                                                                          |
| `FAKE_AGENT_LEGACY_MODES=1`          | Reports modes through the legacy `modes` field instead of a mode config option             |
| `FAKE_AGENT_HISTORY_ENTRIES`         | The size of the synthesized `large-history` replay (default 1,000)                         |
| `FAKE_AGENT_LIST_PAGE`               | The `session/list` page size (default 50), to exercise `nextCursor`                        |
| `FAKE_AGENT_IGNORE_EOF=1`            | Keeps running after stdin closes, for the forced-stop process test                         |
| `FAKE_AGENT_IGNORE_SIGTERM=1`        | Ignores `SIGTERM`, so a stop has to escalate to `SIGKILL`                                  |
| `FAKE_AGENT_SPAWN_CHILD=1`           | Starts a long-running child process and prints its pid to stderr, for process-tree cleanup |
| `FAKE_AGENT_LOGIN_MARKER`            | Where `main.ts --login` writes its sign-in marker (default: the temp directory)            |

The fake agent keeps its sessions in memory. `session/load` replays what happened in the same process; a session it does not know, such as one from before a restart, gets a short synthesized history.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, on `macos-latest`, `windows-latest` and `ubuntu-latest`:

1. Install with `pnpm install --frozen-lockfile`.
2. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`.
3. `pnpm test`, which includes the process tests that spawn the fake agent on each platform.
4. `pnpm build`, then `electron-builder --dir` to prove the app packages on each platform.

Real agents never run in CI: they need accounts and cost money.

## Measuring performance

Budgets are measured on a production build, packaged with `pnpm package`, launched with `--remote-debugging-port` and `OVERBENCH_FAKE_AGENT`, and driven by `tools/perf/measure.mjs`, a script with no dependencies that talks to the renderer over the Chrome DevTools Protocol.

| Budget                            | How it is measured                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Launch to first interactive frame | The renderer sends `perf:interactive` after the first frame of the app shell; main records `process.uptime()` then |
| Renderer commits while streaming  | With the `--overbench-perf` launch flag, the renderer counts store updates per animation frame                     |
| Main-thread long tasks            | A `PerformanceObserver` for `long-animation-frame`, during `long-stream` and `tool-storm`                          |
| Session switch                    | A mark when the switch starts and when the first frame of the new session has painted, using `large-history`       |
| Keystroke to paint                | Event timing entries for input in the composer while `long-stream` runs                                            |
| Agent host memory                 | `app.getAppMetrics()` for the process named OverBench Agent Host, after `tool-storm`                               |

The script prints a table; the results for each platform are recorded in `docs/perf/m0.md` with the date, machine, OS and app version. A change that makes a budget fail is not merged.

- Main logs the first `perf:interactive` of a launch to stdout as `perf:interactive <ms> ms after launch`, and later ones, from reloads, separately; diagnostics keep it as `main.launchToInteractiveMs`.
- When main itself was started with `--overbench-perf`, it passes the flag to each page with `additionalArguments`, and the preload sets `window.overbench.perf`.
