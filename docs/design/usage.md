# Usage statistics

> Status: Implemented · Part of the [architecture](../architecture.md) · Not in M0 · Observed on 2026-10-22: claude-agent-acp 0.94.0, codex-acp 2.2.2, opencode 2.0.32, cc-switch at `7da2553`

How much have I used my agents? The usage page answers that across every agent and for any time range: the tokens in total and per day or week, the busiest day, which agents, models and projects took the most, and, next to that, each plan's limits as they stand now.

The numbers come from two sources:

- **OverBench's own record**, always on: every turn OverBench runs adds the tokens its agent reports over ACP. It starts on the day this feature first runs and covers what happens inside OverBench.
- **Usage on this computer**, a choice in Settings, off until the user turns it on: OverBench reads the agents' own local logs, the way [cc-switch](https://github.com/farion1231/cc-switch) does, which brings in the history from before OverBench was installed and whatever the user runs in a terminal.

## Where it stands

Built on 2026-10-22 as designed here, with the dashboard the maintainer chose from three mockups that day ([interface](#interface)). What is left is listed under [testing](#testing).

## OverBench's own record

Each agent reports a turn's tokens when `session/prompt` returns, in the response's `usage` (still unstable in ACP) and, for Claude Code and Codex, split by model in `_meta.quota.model_usage`. The ACP schema calls the fields totals "across session", but every adapter sends the turn's own counts (read in their source on 2026-10-22):

| Agent       | `usage` in the prompt response                                                                                                                                                                      | Split by model                                                                                                                                                           | Input                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Claude Code | The main thread's tally, reset when a turn starts; its subagents' requests are left out. Model cycles that Claude Code starts on its own, such as when a background task finishes, are left out too | `_meta.quota.model_usage`, the turn's increment per model, subagents included                                                                                            | Without cache           |
| Codex       | The prompt's usage, the difference of Codex's running totals over the prompt; `thoughtTokens` is the reasoning part, which `outputTokens` already includes                                          | `_meta.quota.model_usage`, one entry with the session's model and the same counts; its cache write is `cacheWriteInputTokens` where Claude Code's is `cachedWriteTokens` | Cache taken out already |
| OpenCode    | The turn's usage (`usage.turn`); cache and reasoning fields only when above zero                                                                                                                    | None; the session's `model` config option at the turn's end                                                                                                              | Without cache           |

So the record keeps one row per turn and model, written by the agent host when the turn ends ([storage](#storage)). The rows come from `model_usage` when the agent sends it, which is the only place Claude Code counts its subagents, and otherwise from `usage` with the session's model. A subagent's own `usage` in its `idle` state is never added: for Claude Code it is in `model_usage` already, and no adapter sends it today.

- **Tokens**: input without cache, output, cache read, cache write, and reasoning where an agent reports it apart from output. The turn's **total** is input + output + cache read + cache write, plus reasoning only for an agent whose output leaves it out: OpenCode, whose `outputTokens` is the visible output alone and whose own total and prices add the reasoning (its source at v2.0.32).
- **Who and where**: the agent, OverBench's session id and the agent's own session id, the project, and the turn's end time.
- A turn that fails or is cancelled without a response reports nothing, and records nothing.

Cost is not recorded: for a subscription it is not what the user pays ([plan limits](./session-model.md#plan-limits)), and only some agents report it.

The session's own totals, which the usage popover shows, are summed from the same counts ([prompt turns](./session-model.md#prompt-turns)), so they include the subagents too.

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
- **Time and place**: a line without a `timestamp` takes the file's modification time. The project is the line's `cwd` as written.
- Measured on a heavily used development Mac (2026-10-22, macOS arm64, Node.js 22): 838 files, 5.4 GB, 831,530 lines, 113,807 messages after removing 157,056 repeated lines, 98.6% of the tokens cache reads. One pass on one thread took 18.2 s with a first prototype; inside the app, the whole first import, these logs with Codex's and OpenCode's, takes about 10 s ([performance](#performance)).

### Codex

Codex writes running totals, so the reader has to work out each request's own usage. It ports cc-switch's `session_usage_codex.rs` rules and the edge cases its tests pin down, which are ported with it:

- **Per request**: `event_msg` lines of type `token_count` carry `info.last_token_usage`, the request's own usage, and `info.total_token_usage`, the running total. `last` is used when present; otherwise the increase of the total over its highest value so far, field by field. A file can interleave several running totals (one per `rate_limits.limit_id`), which made a plain difference count 6 to 8 times too much; preferring `last` is what fixes that, so, as in cc-switch, there is one highest value per file, not one per `limit_id`.
- **Repeats**: an event whose full snapshot equals the latest one of its `limit_id`, or the event just before it, adds nothing. Older snapshots of other `limit_id`s are not compared, so a real counter reset still counts.
- **Compaction**: a `token_usage_record` (Codex 0.153 and later) is held until the next `token_count`; when that count's `last` is all zero, the record is a request of its own. A record held at the end of a scan waits in the cursor's state.
- **Forks and subagents**: a forked or subagent rollout starts by replaying its parent's events up to its `session_meta` time, compared in nanoseconds. Those are matched against the parent's events in order, gaps allowed, until the first child event that does not match, and skipped. A parent's pages are joined in file-name order, and copies of a parent must agree up to that time. When the parent cannot be read yet, or its ids conflict, the child waits for a later scan instead of being guessed at, and is not read again until it or the files it waits on change. One rule is new: a parent whose files were all last written before the fork already holds everything up to it, so the fork is read at once. cc-switch keeps waiting for such a parent, so a fork of a thread that was archived soon after never counted (one rollout on the development Mac).
- **Continuation pages** (`<thread>_<page>.jsonl`) are not forks. A page whose counts carry only totals starts from the previous page's highest values, and waits while there is no previous page.
- **Input**: Codex's input includes cache reads and cache writes, which are taken out, so input means the same for every agent; output already includes reasoning.
- **Model**: from `turn_context`, `thread_settings_applied` and the event itself, lower-cased, without a provider prefix or a date suffix (`-20261001` or `-2026-10-01`).
- **Time**: a count without a timestamp takes the latest earlier time in the file, else the file's modification time.
- **Key**: `codex:<rollout id>:<n>`, the n-th counted event of that file, replayed ones included, as cc-switch numbers them. A compaction is `codex:usage:<response id>`, without the rollout, so a fork that replays its parent's record counts it once; without a response id it is `codex:usage:<rollout id>:<byte offset>`, and a fork leaves out such a record when the token count that follows it replays the parent's.
- **Resuming**: the reader's running state (the highest values, each `limit_id`'s last snapshot, the held record, `n`, the model, the parent and how far its replay matched) is kept as versioned JSON in the cursor, so a scan reads only what was appended, also of a rollout that Codex has since compressed. State it cannot read back starts the file over, which the keys make safe.
- **Files that move**: a rollout's cursor is its file name without `.zst`, so compressing or archiving it reads nothing again. Copies with the same name, in `sessions/` and `archived_sessions/` or plain beside compressed, share that cursor, and a scan reads one of them: the plain one, else the newest.
- **Reading**: the type of a line is read from its first fields, before `"payload"`, so tool output is never parsed; a line laid out otherwise falls back to a search for the five types the reader uses.
- Measured on the development Mac: 258 rollouts (216 compressed), 232 MB on disk and 614 MB inflated, 13,821 requests in 1.9 to 2.0 s; a second pass with nothing new takes 3 to 4 ms. For each of the 183 rollouts that are not forks, its rows add up exactly to Codex's own last `total_token_usage`.

### OpenCode

- Opened read-only, with a busy timeout, while OpenCode may be writing; a busy database is retried at the next scan.
- OpenCode 2 keeps sessions in `session_v2` and messages in `session_message` (`type` `assistant` or `compaction`); the 1.x tables `session` and `message` are read when the 2.x ones are missing, since a migrated 1.x database is frozen. A relative `OPENCODE_DB` is taken from OpenCode's data folder, as OpenCode does.
- A message counts once it is complete (`time.completed`, or a compaction that `completed` or `failed`), with `tokens.input`, `.output`, `.reasoning`, `.cache.read` and `.cache.write`, the model and `time.created`. An incomplete one holds its session's cursor, so it is read again when done.
- **Key**: `opencode:<session id>:<message id>`; migrated messages keep their ids.
- A change shows in the database file or its `-wal` file, whichever was written last; an empty `-wal` is left out, since SQLite leaves one after every checkpoint.

## Storage

The usage database is `state/usage.db`, a SQLite file of its own, apart from [the thread store](./persistence.md#threads): removing sessions, or a damaged thread store, leaves the usage alone. The agent host runs it in a `usage` worker thread of its own, so a first import never delays opening a session. It follows the thread store's rules for `node:sqlite`, WAL, damage and versioning. A worker that stops on its own, such as one that ran out of memory, is started again up to twice per launch: the requests it was answering fail, the scan's progress clears, and the next scan reads on from the cursors it committed. After that the page says the database cannot be read, with **Export diagnostics**. **Sync now** and a re-import say so in place when their scan fails; the scans OverBench starts by itself only log it. Decided while the maintainer was away; to be reviewed.

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
  cache_write INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_by_agent ON usage (source, agent_id);  -- re-import and clearing the record

CREATE TABLE buckets (
  quarter     INTEGER NOT NULL,  -- floor(at / 900000): a quarter hour, UTC
  source      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  model       TEXT NOT NULL,
  project     TEXT NOT NULL,     -- '' when unknown
  rows        INTEGER NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  reasoning   INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  PRIMARY KEY (quarter, source, agent_id, model, project)
) STRICT, WITHOUT ROWID;

CREATE TABLE cursors (
  id        TEXT PRIMARY KEY,    -- the file's path; a Codex rollout's file name
  agent_id  TEXT NOT NULL,
  size      INTEGER NOT NULL,
  mtime_ns  INTEGER NOT NULL,
  offset    INTEGER NOT NULL,    -- bytes of complete lines read
  tail      INTEGER,             -- 32 bits of a hash of the 4 KB before offset
  state     TEXT,                -- a reader's own state, such as Codex's running totals
  seen_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX cursors_by_agent ON cursors (agent_id);
```

- **Rows are kept**: cc-switch deletes detail rows after 30 days and keeps daily sums, after which a message copied into a new file, or a log folder that moved, imports again and counts twice. The key of every row ever imported is what makes an import safe to repeat, so rows are never pruned. On the development Mac, 130,153 rows (116,262 from Claude Code, 13,821 from Codex, 70 from OpenCode) take a 35 MB file.
- **Buckets** hold the sums per quarter hour, agent, model and project, written in the same transaction as the rows they sum, and every chart, total and breakdown reads them, never the rows. Summing the rows per project took 90 to 180 ms on the development Mac; the buckets answer in a few. Every time zone's offset is a multiple of 15 minutes, so a local day is an exact range of quarters in whatever zone the user is in today; cc-switch's daily sums keep the zone they were made in.
- **The session** stays in the rows, which no breakdown reads yet.
- A row whose counts grow (a half-written Claude Code message) changes its buckets by the difference.

## Scanning

- **When**: with **Usage on this computer** on, 8 s after launch, so startup settles first, then every 10 minutes, at once when the usage page opens or the setting is turned on, and on **Sync now**. Scans run one at a time in the worker, which answers the page's reads between files; a scan asked for while one runs joins it, and a re-import waits for it. Turning the setting off cancels the scan that runs and drops those waiting; turning it on again starts a new import after the cancelled scan ends, rather than joining it. A cancelled scan leaves no file marked for later: what it did not finish is read at the next scan. A session that OverBench deletes has its transcript removed by the agent (`session/delete`), so the deletion first waits for a scan of that agent's logs, after any scan that runs.
- **Which files**: one whose size and modification time both match its cursor is skipped (cc-switch looks at the time alone, which misses an append within the same tick).
- **Reading**: from the cursor's offset, complete lines only; a last line without its newline is left for the next scan. When the 4 KB before the offset no longer hash to `tail`, or the file is shorter than the offset, the file was rewritten: it is read again from the start, which the keys make safe.
- **Writing**: a file's new rows, their buckets and its cursor commit in one transaction. If reading fails halfway, the cursor keeps its old modification time so the file is tried again.
- **Progress**: a scan reports files and bytes planned and done at most every 200 ms, which the page shows while a scan has more than 50 MB to read, and Settings always. A scan that adds rows sends a change at most once a second: each change has an open page read its figures again, and more often made the worker spend more time answering the page than reading the logs (30 s instead of 11 s for the development Mac's first import). Before passing a change on, the host reads each source's first day and row count again, so the page's **All time** and the record's start are current when it reads. The page reads once at a time: changes that arrive meanwhile make one more read after it.
- **Re-import**, per agent in Settings: deletes that agent's log rows, their share of the buckets and its cursors, then scans it again. History whose files the agent has since deleted cannot come back, and the confirmation says so.

## Host protocol

| Method              | Params                           | Result         | Notes                                                                                   |
| ------------------- | -------------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `usage.summary`     | `{ dayStarts, from, to, scope }` | `UsageSummary` | Sums per day (an index into `dayStarts`) and agent, per model and per project in range  |
| `usage.total`       | `{ from, to }`                   | `UsageTotal`   | The tokens in a range from the counted sources, for the sidebar's today                 |
| `usage.status`      | none                             | `UsageStatus`  | Whether the logs are read, the scan running, the record's start and each reader's state |
| `usage.sync`        | none                             | none           | Scans now and resolves when the scan ends; nothing while the logs are off               |
| `usage.reimport`    | `{ agentId }`                    | none           | Forgets the agent's imported rows and cursors, then scans it                            |
| `usage.clearRecord` | none                             | none           | Deletes OverBench's own record                                                          |

- `dayStarts` are the local midnights the renderer works out, ascending, at most 50 years of them, so days stay right across daylight saving time; `scope` is `computer` or `overbench`. The host validates both like every request.
- `usage.changed` (no payload) says the figures changed; `usage.status` carries the new `UsageStatus` whenever the setting, a scan's progress or a reader's state changes. Both go to all ports.

## What the page shows

The figures, for the agent, time range and source chosen (all agents, all time and this computer by default):

- **Tokens**: the total, then its parts: input, output, cache read, cache write, and the cache's share of the input side. cc-switch and the agents count cache reads in the total too; on the development Mac measured above they are 98.6% of it, so the parts always sit next to the total.
- **Days**: the active days in the range (a local day with any usage), the daily average over them, and the peak day with its tokens.
- **Trend**: the tokens per day, or per week for a range longer than 92 days, split by agent.
- **Breakdowns** by model and by project, with each one's tokens and share of the range; by agent through the agent filter and the trend.
- **Activity**: the last 53 weeks as a heatmap, a column per week, whatever the range; the days outside it are dimmed. A day's shade is its quartile among the days with usage (cc-switch), so a few peak days do not wash out the rest. The week starts on the locale's first day. One pointer listener on the grid names the day under the pointer, its date and tokens, in the panel's header, and only an outline moves, so hovering re-renders no cell of the 371; the grid is one Tab stop with arrow keys between days (left and right a week, up and down a day). Without a chosen day, the header names the busiest one.
- **Plan limits**: each agent's windows as they stand, from the existing [plan limits](./session-model.md#plan-limits), with nothing new to read.
- Numbers use one formatter everywhere ("41.7B", "274.5M", "1.2K"; 万 and 亿 in Chinese), with the exact value in a tooltip; the tables show exact values.

## Interface

A **Usage** screen of its own, laid out as a dashboard. Of the three mockups (a Settings › Usage page, a profile-like page, a dashboard) the maintainer chose the dashboard on 2026-10-22, with the time range free to choose.

- **Opening it**: a **Usage** row in the sidebar (`ChartNoAxesColumn`), after **Artifacts**. The row's end shows today's tokens or the tightest plan limit ([interface](./ui.md#sidebar), [settings](#settings)).
- **Header**: the title, when the logs last synced ("Reading the logs…" during a scan, "OverBench's record" while the logs are off, "Could not sync" in `--destructive` with the reason in its tooltip when **Sync now** failed), and **Sync now**.
- **Filters**, one row that every panel follows, wrapping on a narrow window:
  - the agent: **All**, or one agent, each with its mark; shown once two agents have usage, since with one, **All** is the only choice;
  - the range: **7 days**, **30 days**, **90 days**, **A year** and **All time** (from the first day with usage), then **Custom**, which shows the chosen dates once applied;
  - the source: **This computer** or **OverBench only**, shown only while **Usage on this computer** is on.
- **Figures**: four cards, total tokens with the range's dates and length, the daily average with how many of the range's days were active, the busiest day, and the cache share. Each number is compact with the exact value in a tooltip.
- **Trend** and **Plan limits** side by side. The trend is a bar chart, stacked by agent with a legend when all are shown; the busiest bar, or the one under the pointer or chosen with the arrow keys, puts its date (or week) and tokens in the panel's header, and its date labels name the year when the bars cross one. Plan limits give one block per agent with its plan, the [plan limits](./session-model.md#plan-limits) rows and when they were read, which is the better place [problem 41](../milestones/m0-feedback.md#41-the-plan-usage-strip-is-unclear-and-needs-a-better-place) asks for; the page reads them afresh when it opens.
- **Activity** and **Tokens by type** side by side: the heatmap, and a table of the parts (reasoning only when an agent reported it) and their sum with exact counts and shares.
- **By model** and **By project** side by side: the six largest in the range, with exact counts and shares; a model in the mono face, a project by its folder name with the path in a tooltip. Sessions without a project count as one row, "No project".
- **Layout**: a centred column of at most 960 px. Container queries put the figures four in a row and the panels side by side from 48 rem, and stack them below it.
- The filters are kept in the usage store while the app runs, and reset to the defaults on launch. The page and its calendar load with dynamic `import()` the first time it opens.

**Custom** opens a `Popover` holding the range picker:

- **Presets** in a column on the left: Today, Yesterday, This week, Last week, This month, Last month, Last 7, 30 and 90 days, This year, All time. A preset fills the calendar; it applies only with **Apply**.
- **Two months** side by side, with previous and next buttons, from the month of the first day with usage, or last month if that is later, to the current month, so two months always show. The first click picks the start, the second the end (in either order); between them, hovering previews the range. Days after today are disabled, today is marked as the `Calendar` marks it, and a dot marks the days with usage. The week starts on the locale's first day, as in the heatmap.
- **A footer** with the start and end as text fields in ISO form (`2026-10-22`), which accept typing and move the calendar to the typed date; the number of days; **Cancel** and **Apply**. A start without an end, or an end without a start, applies as that one day. What is typed stays as typed: a field is checked once it holds ten characters or is left, and a date that does not exist, a day after today, or a start after the end is said in place of the number of days, in `--destructive`, while **Apply** waits for it to be fixed and the calendar keeps the last range the fields made. Decided while the maintainer was away; to be reviewed.
- It is the shadcn/ui `Calendar` in range mode, inside the `Popover`, with react-day-picker 9 (approved on 2026-10-22, in `devDependencies` at `^9.14.0`, the major shadcn builds the component against; the CLI would install 10). date-fns, which the CLI also adds, stays out of `package.json`: the component does not import it, react-day-picker brings its own, and the page formats dates with `Intl`.

Every state is designed with it: loading (`Skeleton`), no data yet (`Empty`, with the offer to turn on **Usage on this computer**), the first import in progress, the database unavailable or a read that failed (an `Alert`, with **Retry** for the latter), a reader that failed or an agent whose logs were not found (in Settings), and a range with no usage, where the figures show "—" and the tables say so. **OverBench only** with an empty record keeps the dashboard, so the filters stay to switch back.

## Settings

A **Usage** section in Settings, after Agents, in four groups:

- **Count from**: **Usage on this computer**, off by default. Its description names the agents and says that only counts, models and times are read and nothing leaves the computer. Turning it on starts the first import.
- **Logs**, while that is on, with the number of agents and **Sync now** at the label's end, and the scan's progress beside it while one runs: one row per agent with its mark, what its history covers ("Since Jun 16, 2026 · 116,262 requests · synced just now"; "Reading the logs…", "Not read yet" or "No logs found"; or the reader's error), the folders or file it reads, and **Re-import…**, which asks first.
- **Sidebar**: **Show in the sidebar**, what the end of the sidebar's **Usage** row shows: today's tokens (the default), the tightest plan limit, or nothing. Together with the plan limits on the page, this is how OverBench keeps the plan-limit checks the maintainer asked to keep (confirmed 2026-10-22).
- **Danger zone**: **Clear OverBench's record…**, after a confirmation; disabled while the record is empty.

They are stored as `usage.fromComputer` and `usage.sidebar` in [settings](./persistence.md#settings); main sends `usage.fromComputer` to the agent host.

## Privacy

The readers take token counts, model names, times, session ids and working folders, and nothing of what was said. Nothing leaves the computer. Reading another program's files waits for the user to turn the setting on (cc-switch reads them from its first launch without asking).

## Performance

Measured on the development Mac (2026-10-22, macOS arm64, production build), with 5.5 GB of logs:

- **First import**: about 10 s with the page closed and 11 s with it open and reading as rows arrive, for 130,153 rows. Later scans read only what was appended; one with nothing new takes 19 to 27 ms.
- **The page's data**: a summary for all time (13 months) takes 17 ms from the renderer and one for 30 days 13 ms, under the 20 ms target; today's total and the status take 1 ms.
- **Size**: `usage.db` is 35 MB; the page and its calendar are a 100 kB chunk that loads on first use.

## Testing

- Each reader is tested against fixture logs that cover the cases cc-switch's tests pin down: for Claude Code, repeated lines per message, half-written messages, resumed files, workflow subagents and rewritten files; for Codex, interleaved running totals, repeats, compaction records, forks with missing or conflicting parents, continuation pages, `.zst` files and archived files; for OpenCode, incomplete messages, compactions and both database layouts.
- The database (buckets, grown rows, local days, cursors, damage, a newer schema), line reading and resuming, the record's rows, the page's model (ranges, weeks, trend, heat levels, breakdowns, presets), the token formatter and the store's coalesced reads have unit tests.
- The record is tested through the fake agent, which reports usage per turn with `model_usage`, from the turn to `usage.summary` and `usage.status`.
- **Not built yet**: the performance script's generated log corpus, to time a first import and a scan with nothing new in CI. The figures above were measured by hand.

## What we do differently

From cc-switch, OverBench leaves out the routing proxy and its request log, prices and costs (its models.dev price list), speed and latency estimates, and the provider dimension. It changes:

- rows are never pruned, so repeating an import can never count twice;
- quarter-hour buckets keep days right in any time zone;
- the agents' own environment variables find the logs;
- reading the logs waits for the user's choice;
- a scan skips a file only when both its size and time are unchanged;
- Codex: a rollout resumes where the last scan stopped instead of being parsed again from its first line, a fork of a parent that was finished before it counts at once, a compaction replayed by a fork counts once, and copies of a rollout share one cursor ([Codex](#codex));
- one token formatter, not three, and a heatmap whose cells never re-render on hover.

Other references: the reference app's profile page, which puts lifetime tokens, the peak day, the longest task and both streaks over a 53-week heatmap with daily, weekly and cumulative views (the dashboard keeps the totals, the peak day and the heatmap, and leaves out the streaks and the longest task); and Claude Code's `/stats`, which keeps its own daily tokens per model in `~/.claude/stats-cache.json`.

## Measurements

The questions the first draft left open, answered on 2026-10-22 on the development Mac:

- **Subagents in a Claude Code turn** (claude-agent-acp 0.94.0): a turn that sent one subagent reported `usage` of 89,289 tokens, exactly the main transcript's requests, while the subagent's transcript held 76,846 more. `model_usage` reported 166,135, the sum of both. Hence the record reads `model_usage`.
- **Claude Code's own cycles between turns**: the cycles that follow a background task's notification hold 1.81 billion of the 41.8 billion Claude Code tokens in the logs, 4.3% (6.1% in the 222 sessions that have any). The record leaves them out, since the adapter adds them to no turn; **Usage on this computer** counts them.
- **OpenCode's reasoning**: kept apart from its output (`visibleOutputTokens` and `reasoningTokens` in its source at v2.0.32), so its total adds the two, as cc-switch does.
- `~/.claude/stats-cache.json` holds daily tokens per model from before Claude Code pruned its transcripts (on the development Mac, from 2026-06-16, while the transcripts start on 2026-08-27). It is an internal file, at version 5, updated only when the user runs `/stats`, so it is left out.
