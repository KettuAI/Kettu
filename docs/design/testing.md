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
- Integration tests connect the host's session layer to the fake agent in-process with the SDK's `ClientApp.connect(agentApp)`, so they need no subprocess and stay fast. The host's connection code therefore accepts either a stream or an in-process agent.
- Tests that touch the file system use a fresh temporary directory.

## Fake agent

`tools/fake-agent/` is an ACP agent built with the SDK's `agent()` API. It never calls a model; it plays scripted scenarios.

- **Running it**: `tools/fake-agent/main.ts` runs directly on Node.js through type stripping, either with Electron's own Node.js (`ELECTRON_RUN_AS_NODE=1`) or with any Node.js 22.18 or later. It has no build step, so its code uses only erasable TypeScript syntax and relative imports with `.ts` extensions; its folder has a `package.json` with `"type": "module"`. `tsconfig.tools.json` type-checks it with `erasableSyntaxOnly` and `allowImportingTsExtensions`, and `pnpm typecheck` includes it.
- **Choosing a scenario**: the prompt text selects it, for example `/scenario long-stream`, so one agent process can run any scenario. The agent also advertises the scenarios as slash commands.
- **In the app**: development builds list it in the agent catalog as Fake agent. A production build lists it only when started with `OVERBENCH_FAKE_AGENT` set to the path of `main.ts`, which is how the performance runs use it. It is never packaged.

| Scenario               | What it does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `basic-turn`           | A short answer with markdown, a code block and one edit with a diff                        |
| `long-stream`          | 200 KB of markdown in small chunks at a configurable rate (default 200 updates per second) |
| `tool-storm`           | 500 tool calls, mixing reads, searches, edits and commands, with updates for each          |
| `permission`           | A command that needs approval, offering all four option kinds                              |
| `parallel-permissions` | Three tool calls asking for permission at the same time                                    |
| `cancel`               | A long turn that honors `session/cancel`; with `--ignore-cancel` it never confirms         |
| `crash`                | Exits mid-turn with a non-zero code                                                        |
| `auth-required`        | Fails `session/new` with `auth_required` until `authenticate` is called                    |
| `large-history`        | `session/load` replays 1,000 entries                                                       |
| `slow-start`           | Takes 20 s to answer `initialize`, printing progress to stderr                             |
| `all-updates`          | Sends every `session/update` variant once, plus an unknown one                             |

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
