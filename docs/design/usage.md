# Usage statistics

> Status: Draft · Part of the [architecture](../architecture.md) · Not in M0 · Observed on 2026-10-22: claude-agent-acp 0.94.0, codex-acp 2.2.2, opencode 2.0.32, cc-switch at `7da2553`

How much have I used my agents? The usage page answers that across every agent: the tokens in total and per day, the streak of active days, the longest task, which agents, models and projects took the most, and, next to that, each plan's limits as they stand now.

The numbers come from two sources:

- **OverBench's own record**, always on: every turn OverBench runs adds the tokens its agent reports over ACP. It starts on the day this feature first runs and covers what happens inside OverBench.
- **Usage on this computer**, a choice in Settings, off until the user turns it on: OverBench reads the agents' own local logs, the way [cc-switch](https://github.com/farion1231/cc-switch) does, which brings in the history from before OverBench was installed and whatever the user runs in a terminal.

## Where it stands

The data design below is settled enough to build. The interface (where the page lives and how it looks) is not: it waits for mockups the maintainer chooses from ([interface](#interface)).

## OverBench's own record

Each agent reports a turn's tokens when `session/prompt` returns, in the response's `usage` (still unstable in ACP), and a subagent's in the `usage` of its `idle` state. The ACP schema calls the fields totals "across session", but every adapter sends the turn's own counts (read in their source on 2026-10-22):

| Agent       | `usage` in the prompt response                                                                                                                                  | Split by model                                                | Input                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------- |
| Claude Code | The turn's tally, reset when a turn starts. Model cycles that Claude Code starts on its own, such as when a background task finishes, are left out of the tally | `_meta.quota.model_usage`, the turn's increment per model     | Without cache           |
| Codex       | The prompt's usage, the difference of Codex's running totals over the prompt; `thoughtTokens` is the reasoning part, which `outputTokens` already includes      | `_meta.quota.model_usage`, one entry with the session's model | Cache taken out already |
| OpenCode    | The turn's usage (`usage.turn`); cache and reasoning fields only when above zero                                                                                | None; the session's `model` config option at the turn's end   | Without cache           |

So the record keeps one row per turn and model, written by the agent host when the turn ends ([storage](#storage)):

- **Tokens**: input without cache, output, cache read, cache write, and reasoning where an agent reports it apart from output. The turn's **total** is input + output + cache read + cache write, plus reasoning only for an agent whose output leaves it out (OpenCode, to be checked).
- **Who and where**: the agent, OverBench's session id and the agent's own session id, the project, and the turn's end time.
- **The turn's duration**, from the `turn_end` entry, for the longest task.
- A turn that fails or is cancelled without a response reports nothing, and records nothing.

Cost is not recorded: for a subscription it is not what the user pays ([plan limits](./session-model.md#plan-limits)), and only some agents report it.

Today the usage popover labels the last turn's counts as "This session" ([interface](./ui.md#usage-popover)); with the record, the session's real totals are the sum of its turns. That fix is separate from this feature.

## Usage on this computer

The agents keep their own logs on disk, which hold the usage of every session they ran, in OverBench or not. cc-switch (MIT, © 2025 Jason Young) imports them for its usage page, and its readers handle years of format changes and edge cases its users ran into. OverBench ports those readers and their tests to TypeScript, keeping the license notice and a comment with the source URL in each ported file, and changes what is listed under [what we do differently](#what-we-do-differently).

### Which source counts

For an agent that has a reader, turning **Usage on this computer** on makes its logs the only source of its numbers, the sessions OverBench ran included, since those are in the logs too. OverBench's own record keeps being written, and counts again when the setting goes off. So there is nothing to match between the two sources and no turn is counted twice, and each view has a one-line meaning: "in OverBench since <date>" or "on this computer".

An agent with no reader, such as one added later from the ACP Registry, always counts from OverBench's record.

### Finding the logs

Each reader looks where its agent writes, using the environment OverBench resolved to launch the agents, so `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_DB` and `XDG_DATA_HOME` set in the user's shell are honored ([agent configuration](./agent-host.md#agent-configuration) resolves the same folders). cc-switch reads none of these variables, since a GUI process does not inherit the shell's.

| Agent       | Files                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `<config>/projects/<project>/*.jsonl`, its subagents' `<session>/subagents/*.jsonl` and workflow subagents' `<session>/subagents/workflows/wf_*/*.jsonl`; `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude` |
| Codex       | `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `<home>/archived_sessions/`, each also as `.jsonl.zst`, which Codex makes of a rollout untouched for 7 days; `<home>` is `CODEX_HOME` or `~/.codex`       |
| OpenCode    | The SQLite database `OPENCODE_DB`, else `$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db` on every platform                                                                |

Electron 44's Node.js (24.22) decompresses zstd with `zlib` and opens SQLite with `node:sqlite`, so the readers need no new dependency.

### Claude Code

- **Lines**: `type: "assistant"` with `message.id` and `message.usage`. From each: the model, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, the line's `timestamp`, `sessionId` and `cwd` (read per line; cc-switch takes the file's first `sessionId`).
- **One row per message**: Claude Code writes a line per content block, all with the same `message.id`. The line with a `stop_reason` wins, else the one with the most output. A message counts when any of its four counters is above zero, which includes subagent and workflow requests that end without a `stop_reason` (cc-switch measured 4.1% missing under a stricter rule).
- **Key**: `claude:<message.id>`, across all files, so a resumed or forked session that copies earlier lines into a new file adds nothing. A message imported half-written is updated when a later scan finds more output.
- Measured on a heavily used development Mac (2026-10-22, macOS arm64, Node.js 22): 838 files, 5.4 GB, 831,530 lines, 113,807 messages after removing 157,056 repeated lines, 98.6% of the tokens cache reads. One pass on one thread took 18.2 s.

### Codex

Codex writes running totals, so the reader has to work out each request's own usage. It ports cc-switch's `session_usage_codex.rs` rules and the edge cases its tests pin down:

- **Per request**: `event_msg` lines of type `token_count` carry `info.last_token_usage`, the request's own usage, and `info.total_token_usage`, the running total. `last` is used when present; otherwise the increase of the total over its highest value so far, field by field. A file can interleave several running totals (one per `rate_limits.limit_id`), which made a plain difference count 6 to 8 times too much.
- **Repeats**: an event whose total and last both equal the previous event of the same `limit_id`, or the event just before it, adds nothing.
- **Compaction**: a `token_usage_record` (Codex 0.153 and later) followed by a `token_count` whose `last` is all zero counts as a request of its own.
- **Forks and subagents**: a forked or subagent rollout starts by replaying its parent's events up to its `session_meta` time. Those are matched against the parent's events in order and skipped; when the parent cannot be read yet, the child waits for the next scan instead of being guessed at. Pages that continue a thread (`<thread>_<page>.jsonl`) are not forks.
- **Input**: Codex's input includes the cached part, which is taken out, so input means the same for every agent; output already includes reasoning.
- **Model**: from `turn_context`, `thread_settings_applied` and the event itself, lower-cased, without a provider prefix or a date suffix.
- **Key**: `codex:<rollout id>:<n>`, the n-th counted event of that file, and `codex:usage:<response id>` for compaction.
- **Files that move**: a rollout that Codex compresses or archives keeps its cursor by its file name, so it is not read again.

### OpenCode

- Opened read-only, with a busy timeout, while OpenCode may be writing; a busy database is retried at the next scan.
- OpenCode 2 keeps messages in `session_message` (`type` `assistant` or `compaction`); the 1.x tables `session` and `message` are read when the 2.x ones are missing, since a migrated 1.x database is frozen.
- A message counts once it is complete (`time.completed`, or a compaction that `completed` or `failed`), with `tokens.input`, `.output`, `.reasoning`, `.cache.read` and `.cache.write`, the model and `time.created`. An incomplete one holds its session's cursor, so it is read again when done.
- **Key**: `opencode:<session id>:<message id>`; migrated messages keep their ids.
- A change shows in the database file or its `-wal` file, whichever was written last.

## Storage

The usage database is `state/usage.db`, a SQLite file of its own, apart from [the thread store](./persistence.md#threads): removing sessions, or a damaged thread store, leaves the usage alone. The agent host runs it in a `usage` worker thread of its own, so a first import never delays opening a session. It follows the thread store's rules for `node:sqlite`, WAL, damage and versioning.

```sql
CREATE TABLE usage (
  key         TEXT PRIMARY KEY,  -- see each reader; 'ob:<session>:<turn end entry>:<model>' for the record
  source      TEXT NOT NULL,     -- 'overbench' or 'log'
  agent_id    TEXT NOT NULL,
  session_id  TEXT,              -- the agent's own session id
  project     TEXT,              -- canonical path, when known
  model       TEXT NOT NULL,     -- normalized; '' when unknown
  at          INTEGER NOT NULL,  -- ms since the epoch: the request's time, or the turn's end
  input       INTEGER NOT NULL,  -- without cache
  output      INTEGER NOT NULL,
  reasoning   INTEGER,           -- only where reported apart from output
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  turn_ms     INTEGER            -- the record's turns only
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_by_time ON usage (at);

CREATE TABLE buckets (
  quarter     INTEGER NOT NULL,  -- floor(at / 900000): a quarter hour, UTC
  source      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  model       TEXT NOT NULL,
  rows        INTEGER NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  reasoning   INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  PRIMARY KEY (quarter, source, agent_id, model)
) STRICT, WITHOUT ROWID;

CREATE TABLE cursors (
  path      TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL,
  size      INTEGER NOT NULL,
  mtime_ns  INTEGER NOT NULL,
  offset    INTEGER NOT NULL,    -- bytes of complete lines read
  tail      INTEGER,             -- 32 bits of a hash of the 4 KB before offset
  state     TEXT,                -- a reader's own state, such as Codex's running totals
  seen_at   INTEGER NOT NULL
) STRICT;
```

- **Rows are kept**: cc-switch deletes detail rows after 30 days and keeps daily sums, after which a message copied into a new file, or a log folder that moved, imports again and counts twice. The key of every row ever imported is what makes an import safe to repeat, so rows are never pruned. The development Mac's 114,000 Claude Code messages are an estimated 10 to 15 MB; to be measured with the first build.
- **Buckets** hold the sums per quarter hour, written in the same transaction as the rows they sum, and every chart and total reads them, never the rows. Every time zone's offset is a multiple of 15 minutes, so a local day is an exact range of quarters in whatever zone the user is in today; cc-switch's daily sums keep the zone they were made in.
- **The project and the session** come from the rows, for the breakdowns that need them.
- A row whose counts grow (a half-written Claude Code message) changes its buckets by the difference.

## Scanning

- **When**: with **Usage on this computer** on, once after launch when startup has settled, then every 10 minutes, at once when the usage page opens, and on **Sync now**. One scan runs at a time; asking while one runs waits for it. A session that OverBench deletes has its transcript removed by the agent (`session/delete`), so its files are scanned first.
- **Which files**: one whose size and modification time both match its cursor is skipped (cc-switch looks at the time alone, which misses an append within the same tick).
- **Reading**: from the cursor's offset, complete lines only; a last line without its newline is left for the next scan. When the 4 KB before the offset no longer hash to `tail`, or the file is shorter than the offset, the file was rewritten: it is read again from the start, which the keys make safe.
- **Writing**: a file's new rows, their buckets and its cursor commit in one transaction. If reading fails halfway, the cursor keeps its old modification time so the file is tried again.
- **Progress**: the first import reports files and bytes done, and the page shows it. When a scan adds rows, the host sends one `usage:changed` event, at most every 200 ms, and the open page reads again.
- **Re-import**, per agent in Settings: deletes that agent's log rows, their share of the buckets and its cursors, then scans again. History whose files the agent has since deleted cannot come back, and the confirmation says so.

## What the page shows

The figures, for the agents and time range chosen (all agents and all time by default):

- **Tokens**: the total, then its parts: input, output, cache read, cache write, and the cache's share of the input side. cc-switch and the agents count cache reads in the total too; on the development Mac measured above they are 98.6% of it, so the parts always sit next to the total.
- **Days**: active days (a local day with any usage), the current streak (consecutive active days up to today or yesterday), the longest streak, and the peak day with its tokens.
- **Longest task**: the longest turn in OverBench's record. Logs carry no turn boundaries, so this figure always comes from the record.
- **Breakdowns** by agent, model and project, with each one's tokens and share.
- **Heatmap**: the last 53 weeks, a column per week, with **Daily**, **Weekly** and **Cumulative** views as in the reference. A day's shade is its quartile among the days with usage (cc-switch), so a few peak days do not wash out the rest, and earlier years can be shown below with the same scale. The week starts on the locale's first day. One pointer listener on the grid drives the tooltip (the date, total and parts), so hovering re-renders one tooltip and not 371 cells; the grid is one Tab stop with arrow keys between days.
- **Plan limits**: each agent's windows as they stand, from the existing [plan limits](./session-model.md#plan-limits), with nothing new to read.
- Numbers use one formatter everywhere ("41.7B", "274.5M", "1.2K"; 万 and 亿 in Chinese), with the exact value in a tooltip.

## Interface

Not decided. To be drawn as options for the maintainer to choose from, among them:

- a **Settings › Usage** page, holding both the figures and the settings;
- a **Usage** screen of its own, opened from the sidebar, which could also be the better place for the plan limits that [problem 41](../milestones/m0-feedback.md#41-the-plan-usage-strip-is-unclear-and-needs-a-better-place) asks for.

Every state is designed with it: no data yet (with the offer to turn on **Usage on this computer**), the first import in progress, a reader that failed, and an agent whose logs were not found.

## Settings

A **Usage** section in Settings:

- **Usage on this computer**, off by default. Its description names the agents and the folders it reads. Turning it on starts the first import. While on, one row per agent shows its folder, the dates its history covers, when it last synced and how many requests it found, with **Sync now** and **Re-import**.
- **Show in the sidebar**: what the sidebar's usage entry shows, plan limits or today's tokens. To be confirmed with the maintainer.
- **Clear OverBench's record**, after a confirmation.

They are stored as `usage.fromComputer` and `usage.sidebar` in [settings](./persistence.md#settings).

## Privacy

The readers take token counts, model names, times, session ids and working folders, and nothing of what was said. Nothing leaves the computer. Reading another program's files waits for the user to turn the setting on (cc-switch reads them from its first launch without asking).

## Performance

- The first import runs in the usage worker: about 18 s for 5.4 GB of Claude Code logs on the development Mac ([Claude Code](#claude-code)). Later scans read only what was appended.
- The page reads only buckets: a year is at most 35,000 quarters per agent and model, and far fewer in practice. Target: the page's data in under 20 ms, measured with the first build.
- The page and its chart load with dynamic `import()`, so startup does not pay for them.

## Testing

- Each reader is tested against fixture logs that cover the cases cc-switch's tests pin down: for Claude Code, repeated lines per message, half-written messages, resumed files, workflow subagents and rewritten files; for Codex, interleaved running totals, repeats, compaction records, forks with missing or conflicting parents, continuation pages, `.zst` files and archived files; for OpenCode, incomplete messages, compactions and both database layouts.
- The record is tested through the fake agent, which reports usage per turn.
- The performance script gains a generated log corpus to time a first import and a scan with nothing new.

## What we do differently

From cc-switch, OverBench leaves out the routing proxy and its request log, prices and costs (its models.dev price list), speed and latency estimates, and the provider dimension. It changes:

- rows are never pruned, so repeating an import can never count twice;
- quarter-hour buckets keep days right in any time zone;
- the agents' own environment variables find the logs;
- reading the logs waits for the user's choice;
- a scan skips a file only when both its size and time are unchanged;
- one token formatter, not three, and a heatmap that re-renders one tooltip on hover.

Other references: the reference app's profile page, which puts lifetime tokens, the peak day, the longest task and both streaks over a 53-week heatmap with daily, weekly and cumulative views; and Claude Code's `/stats`, which keeps its own daily tokens per model in `~/.claude/stats-cache.json`.

## Open questions

- Does a Claude Code turn's `usage` include its subagents'? If it does, the record must not add the subagents' own `idle` usage on top. To be measured with a live session before the record is built.
- Claude Code's own model cycles between turns are missing from the record; the logs have them. How much that is, to be measured.
- Does OpenCode count reasoning inside its output? cc-switch adds the two.
- `~/.claude/stats-cache.json` holds daily tokens per model from before Claude Code pruned its transcripts (on the development Mac, from 2026-06-16, while the transcripts start on 2026-08-27). It could fill those older days, but it is an internal file, at version 5, updated only when the user runs `/stats`. Left out for now.
