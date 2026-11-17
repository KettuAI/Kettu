# Harness checks

`.github/workflows/harness-checks.yml` runs once a day, and by hand, apart from pull request CI. It checks the new versions of the harnesses whose versions the ACP Registry does not check: the Claude Agent SDK, Codex, DeepSeek Harness, Qoder CN, Autohand Code and Muse Code. The run holds no credentials for them, so each check goes as far as a harness goes without a sign-in. Its results are the run's `harness-checks` artifact, the input the published compatibility manifest is built from.

The checks load Kettu's own catalog, installers and version order from the source through Vite's module runner, so a harness is installed as the app installs it (npm without install scripts, the vendor's download checked by its SHA-256) and its range is the one the catalog gives.

## Which versions

- **In range:** the versions the catalog's range accepts: the Claude Agent SDK's and DeepSeek Harness's update ranges, Codex from the oldest version the mapping is written against, Qoder CN, Autohand Code and Muse Code from the version Kettu bundles for them. npm decides what an npm range matches, as the app's updates do.
- **Published 6 hours ago:** a version is checked once it was published at least 6 hours before the run, so npm has every platform package of it. Muse Code's channel gives no publish time, so its versions count from the run that first saw them.
- **New:** newer than every version checked before, at most 3 of a harness in a run, the newest first. A harness checked for the first time gets only its newest version.
- **Again:** a version whose one check so far failed is checked again in the next run, so a passing retry clears it and a second failure in a row marks it broken.

What was checked before comes from the last successful run's artifact on the same branch. Without one, or once it has expired after 90 days, a run starts afresh.

## The checks

| Harness          | Steps                                                 | Where it stops without a sign-in                         |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Claude Agent SDK | `install`, `cli`, `initialize`, `types`               | After `initialize`: a turn needs a sign-in               |
| Codex            | `install`, `schema`, `initialize`, `models`, `thread` | After an ephemeral `thread/start`: a turn needs one      |
| DeepSeek Harness | `install`, `initialize`, `session`                    | After a local command in a session: a prompt needs one   |
| Qoder CN         | `install`, `initialize`, `session`                    | At `session/new`, which answers that a sign-in is needed |
| Autohand Code    | `install`, `initialize`, `session`                    | At `session/new`, which answers that a sign-in is needed |
| Muse Code        | `download`, `initialize`, `session`                   | At `session/new`, which answers that a sign-in is needed |

- **Claude Agent SDK:** `install` installs the SDK without the CLI it brings, as the app does. `cli` installs the Claude Code version the SDK names in its `claudeCodeVersion` from npm, as a user's own `claude`. `initialize` runs it through the SDK and expects that version, its models and its commands. `types` checks Kettu's own SDK types (`src/agent-host/claude/sdk.ts`) against the new SDK's declarations: every field Kettu names, through the module's exports, options, messages and answers, must be declared somewhere. A few of Kettu's fields are in no published declaration, so only a field the oldest SDK in the range declares and the new one does not fails it.
- **Codex:** `install` installs `@openai/codex` from npm, as a user may, and expects `codex --version` to name it. `schema` runs `codex app-server generate-json-schema --experimental` and compares it with `src/agent-host/codex/app-server.schema.json`, the protocol the mapping is written against, cut to the methods the mapping calls or handles and the fields and values its source names: what the new schema adds passes, and a method, field, tagged variant or value of the cut that it lacks fails. `initialize` starts `codex app-server` and expects the version in its user agent, then `models` expects `model/list` to list models and `thread` expects an ephemeral `thread/start` to give a thread.
- **DeepSeek Harness:** `install` as the app installs it, then `initialize` starts `dsh --profile sdk` with Kettu's default model, and `session` runs `/plan` in a session, which needs no model.
- **Qoder CN, Autohand Code and Muse Code:** `install` from npm (Autohand Code's ACP adapter, `@autohandai/autohand-acp`), or `download` of the file the vendor's release manifest names for the platform, checked by its SHA-256; then their ACP mode answers `initialize` with protocol version 1 and its version, and `session/new` either opens a session or refuses with ACP's auth_required error. Any other answer fails.

## The artifact

The artifact `harness-checks` holds one file, `harness-checks.json`. Fields may be added; none is renamed or removed.

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
- `seen`: per harness whose vendor gives no publish time, when each version it offers was first seen, which the next run reads.

A run whose checks fail still succeeds, so its artifact is the latest result. A harness whose versions cannot be read that day, from npm or its vendor, keeps its earlier results. A run fails only when the tooling itself does, such as a slip in these scripts, so a fault of theirs never marks a version broken.

## Repeated failures

When a version has failed twice in a row, `report.mjs` opens one issue for it in this repository, titled `Harness check fails: <harness> <version>`, of type Bug with `area:agents` and `state:needs-triage`, carrying the step and the end of the log. It opens none when an issue of that title exists, open or closed, so a version gets at most one. Only runs on `main` open issues; on another branch the step prints what it would open.

## Running it

After `pnpm install`:

```sh
# Every harness, as the workflow does; --previous takes an earlier harness-checks.json
node tools/harness-checks/check.mjs --out harness-checks.json

# One harness at one version, whatever its state
node tools/harness-checks/check.mjs --only codex --version 0.169.0 --out codex.json

# What a run would file
GH_REPO=KettuAI/Kettu node tools/harness-checks/report.mjs harness-checks.json --dry-run
```

When the Codex mapping reads something new, or is moved to a newer Codex, write the cut again from the version it is written against, and compare a schema with it:

```sh
node tools/harness-checks/codex-schema.mjs write [<codex version>]
node tools/harness-checks/codex-schema.mjs compare <folder generate-json-schema wrote>
```
