# Harness checks

`.github/workflows/harness-checks.yml` runs every 6 hours, and by hand, apart from pull request CI. It checks the new versions of the harnesses whose versions the ACP Registry does not check: the Claude Agent SDK, Codex, DeepSeek Harness, Qoder CN, Autohand Code and Muse Code. It also checks the new versions of the harnesses that have a preferred interface beside their protocol, on that interface: OpenCode's server and Cline's SDK. The run holds no credentials for them, so each check goes as far as a harness goes without a sign-in. Its results are the run's `harness-checks` artifact, the input the published compatibility manifest is built from.

The checks load Kettu's own catalog, installers, version order and the connections of the preferred interfaces from the source through Vite's module runner, so a harness is installed as the app installs it (npm without install scripts, the vendor's download checked by its SHA-256), its range is the one the catalog gives, and a preferred interface is driven by the code the app runs.

## Which versions

- **In range:** the versions the catalog's range accepts: the Claude Agent SDK's and DeepSeek Harness's update ranges, Codex from the oldest version the mapping is written against, Qoder CN, Autohand Code and Muse Code from the version Kettu bundles for them. For a preferred interface, the catalog's `checked` range, which the app takes the interface on by default, and the next major version after it, which only the manifest can let take it: OpenCode from 2.3.2 to before 4.0.0, Cline from 3.0.74 to before 5.0.0. npm decides what an npm range matches, as the app's updates do.
- **Published 6 hours ago:** a version is checked once it was published at least 6 hours before the run, so npm has every platform package of it. Muse Code's channel gives no publish time, so its versions count from the run that first saw them.
- **New:** newer than every version checked before, at most 3 of a harness in a run, the newest first. A harness checked for the first time gets only its newest version.
- **Again:** a version whose one check so far failed is checked again in the next run, so a passing retry clears it and a second failure in a row marks it broken.

What was checked before comes from the last successful run's artifact on the same branch. Without one, or once it has expired after 90 days, a run starts afresh.

## The checks

| Harness          | Steps                                                 | Where it stops without a sign-in                         |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Claude Agent SDK | `install`, `cli`, `initialize`, `types`               | After `initialize`: a turn needs a sign-in               |
| Codex            | `install`, `schema`, `initialize`, `models`, `thread` | After an ephemeral `thread/start`: a turn needs one      |
| DeepSeek Harness | `install`, `models`, `initialize`, `session`          | After a local command in a session: a prompt needs one   |
| Qoder CN         | `install`, `initialize`, `session`                    | At `session/new`, which answers that a sign-in is needed |
| Autohand Code    | `install`, `initialize`, `session`                    | At `session/new`, which answers that a sign-in is needed |
| Muse Code        | `download`, `initialize`, `session`                   | At `session/new`, which answers that a sign-in is needed |
| OpenCode server  | `install`, `initialize`, `options`, `session`         | After a session is made and deleted: a prompt needs one  |
| Cline SDK        | `install`, `initialize`, `session`                    | At the session, which the SDK refuses as needing one     |

- **Claude Agent SDK:** `install` installs the SDK without the CLI it brings, as the app does. `cli` installs the Claude Code version the SDK names in its `claudeCodeVersion` from npm, as a user's own `claude`. `initialize` runs it through the SDK and expects that version, its models and its commands. `types` checks Kettu's own SDK types (`src/agent-host/claude/sdk.ts`) against the new SDK's declarations: every field Kettu names, through the module's exports, options, messages and answers, must be declared somewhere. A few of Kettu's fields are in no published declaration, so only a field the oldest SDK in the range declares and the new one does not fails it.
- **Codex:** `install` installs `@openai/codex` from npm, as a user may, and expects `codex --version` to name it. `schema` runs `codex app-server generate-json-schema --experimental` and compares it with `src/agent-host/codex/app-server.schema.json`, the protocol the mapping is written against, cut to the methods the mapping calls or handles and the fields and values its source names: what the new schema adds passes, and a method, field, tagged variant or value of the cut that it lacks fails. `initialize` starts `codex app-server` and expects the version in its user agent, then `models` expects `model/list` to list models and `thread` expects an ephemeral `thread/start` to give a thread.
- **DeepSeek Harness:** `install` as the app installs it, then `models` reads dsh's models with the app's own listing, which lists none without a sign-in, so the check then takes the model dsh starts its own sessions on. `initialize` starts `dsh --profile sdk` on that model, and `session` runs `/plan` in a session, which needs no model request.
- **OpenCode server:** `install` installs `@opencode/cli` from npm without its install script and runs the binary of the platform package that script would copy into place, checking it is the same version. `initialize` has Kettu's own connection start `opencode serve --stdio` on it and expects the server to name that version. `options` reads a folder's agents, which must include `build`, and its models, of which there are none without a sign-in. `session` makes a session in the folder and deletes it.
- **Cline SDK:** `install` installs `cline` as the app does, which brings `@cline/sdk`. `initialize` builds Kettu's own process for the SDK (`src/agent-host/cline/cline-host.ts`) and has Kettu's own connection start it on that install, expecting the package's version and its providers. `session` asks for a session, which passes when it opens or when the SDK answers that a sign-in is needed.
- **Qoder CN, Autohand Code and Muse Code:** `install` from npm (Autohand Code's ACP adapter, `@autohandai/autohand-acp`), or `download` of the file the vendor's release manifest names for the platform, checked by its SHA-256; then their ACP mode answers `initialize` with protocol version 1 and its version, and `session/new` either opens a session or refuses with ACP's auth_required error. Any other answer fails.

## The artifact

The artifact `harness-checks` holds one file, `harness-checks.json`. Fields may be added; none is renamed or removed. A harness version's results and those of a preferred interface are kept in two lists, so a failing interface never marks the harness's own version broken.

```json
{
  "generatedAt": "2026-11-18T05:31:12.000Z",
  "commit": "559211d33...",
  "results": [
    {
      "harness": "claude-code",
      "version": "0.3.327",
      "publishedAt": "2026-11-17T19:02:44.517Z",
      "status": "pass",
      "step": null,
      "log": "...",
      "checkedAt": "2026-11-18T05:31:12.000Z",
      "failures": 0
    }
  ],
  "interfaces": [
    {
      "harness": "opencode",
      "protocol": "opencode-server",
      "beyondCatalog": false,
      "version": "2.4.1",
      "publishedAt": "2026-11-23T15:56:19.960Z",
      "status": "pass",
      "step": null,
      "log": "...",
      "checkedAt": "2026-11-23T21:23:40.000Z",
      "failures": 0
    }
  ],
  "seen": { "muse": { "1.4.23-R8977.1": "2026-11-17T05:30:40.000Z" } }
}
```

- `generatedAt`: when the run started, ISO 8601.
- `commit`: the code commit the run checked out.
- `results`: per harness, the latest result of each version checked, in this run or carried over from earlier runs, while the version is in the catalog's range; at most 20 per harness, the newest versions. Sorted by harness, then newest version first.
  - `harness`: the catalog id, one of `claude-code` (whose versions are the Claude Agent SDK's), `codex`, `deepseek`, `qoder-cn`, `autohand` (whose versions are its ACP adapter's) and `muse`.
  - `version`: the version checked.
  - `publishedAt`: when it was published, ISO 8601; for Muse Code, when a run first saw it.
  - `status`: `pass` or `fail`.
  - `step`: the step that failed, from the table above, or `null` when it passed.
  - `log`: the end of the check's log, at most 4 KB of UTF-8.
  - `checkedAt`: the `generatedAt` of the run that checked it; equal to this file's for a version checked in this run.
  - `failures`: how many checks of this version in a row failed, `0` once one passed. `2` or more means it failed twice in a row and is not checked again.
- `interfaces`: the results of the preferred interfaces, kept as `results` are, with the same fields and two more. A run from before these checks has none.
  - `harness`: the catalog id, `opencode` or `cline`.
  - `protocol`: the interface checked, the catalog's `opencode-server` or `cline-sdk`.
  - `beyondCatalog`: `true` for a version past the catalog's `checked` range, which takes the interface only when the manifest lets it through; `false` for one the app takes it on by default.
- `seen`: per harness whose vendor gives no publish time, when each version it offers was first seen, which the next run reads.

A run whose checks fail still succeeds, so its artifact is the latest result. A harness whose versions cannot be read that day, from npm or its vendor, keeps its earlier results. A run fails only when the tooling itself does, such as a slip in these scripts, so a fault of theirs never marks a version broken.

## Repeated failures

When a version has failed twice in a row, `report.mjs` opens one issue for it in this repository, titled `Harness check fails: <harness> <version>`, of type Bug, carrying the step and the end of the log; for a preferred interface the title names it, as in `Harness check fails: OpenCode server 2.5.1`. It opens none when an issue of that title exists, open or closed, so a version gets at most one. Only runs on `main` open issues; on another branch the step prints what it would open.

## Running it

After `pnpm install`:

```sh
# Every harness, as the workflow does; --previous takes an earlier harness-checks.json
node tools/harness-checks/check.mjs --out harness-checks.json

# One harness at one version, whatever its state
node tools/harness-checks/check.mjs --only codex --version 0.169.0 --out codex.json

# A preferred interface, by its harness's id
node tools/harness-checks/check.mjs --only opencode --version 2.4.1 --out opencode.json

# What a run would file
GH_REPO=KettuAI/Kettu node tools/harness-checks/report.mjs harness-checks.json --dry-run
```

When the Codex mapping reads something new, or is moved to a newer Codex, write the cut again from the version it is written against, and compare a schema with it:

```sh
node tools/harness-checks/codex-schema.mjs write [<codex version>]
node tools/harness-checks/codex-schema.mjs compare <folder generate-json-schema wrote>
```
