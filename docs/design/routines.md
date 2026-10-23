# Routines

> Status: Draft for [issue #22](https://github.com/overbench/overbench/issues/22), not built yet · Part of the [architecture](../architecture.md) · Choices marked _pending_ wait for the maintainer's pick ([open questions](#open-questions))

A routine is a prompt with its project, agent and model that OverBench sends on a schedule: once at a date and time, or repeating every few minutes or hours, daily or weekly at a time, or by a cron expression. Each run starts a session the user can open later, like any other, and ends with a notification. The sidebar's **Routines** row opens the routines and their runs.

Routines are meant to grow into complete workflows, where one routine's result starts the next. That chaining is not in this first version, but the model leaves room for it ([chaining later](#chaining-later)).

## Decided

The maintainer settled these on 2026-10-22, and the design works within them:

1. A run due while the app was closed or the computer asleep gets one catch-up run at the next launch or wake; the others are skipped.
2. Routines run only while OverBench is open, which an optional **Open at login** helps with. No tray icon, and the computer is never woken.
3. Each routine says when it is created what it may do, its permission scope. A permission request beyond that pauses the run and notifies.
4. Chaining stays out of this version, with extension points left for it.
5. A run due while the routine's previous run is still going is skipped.
6. Near a plan limit, runs pause and notify.
7. Cron expressions use the local time zone and follow its daylight saving changes.
8. A run's sessions are kept like any other session and listed under their routine, so scheduled work does not flood the projects in the sidebar.

## Model

The types below are normative, as in the [session model](./session-model.md#types). They live in `src/shared/routines.ts`, and the schedule engine in `src/shared/schedule.ts`, which the renderer uses for the form's preview, so the preview and the scheduler agree.

### Routine

```ts
interface Routine {
  id: string // 'r-' and 12 hex digits
  name: string // the user's, or the prompt's first line cut to 60 characters
  prompt: string // sent as written, up to 100,000 characters
  agentId: AgentId
  projectPath: string | null // null: the routine's own scratch folder
  options: { id: string; value: string | boolean }[] // model, model_config and thought_level values, as sessions.create takes them
  trigger: { kind: 'schedule'; schedule: Schedule } // other kinds come with chaining
  scope: PermissionScope
  timeLimitMinutes: 15 | 30 | 60 | 120 | 240
  enabled: boolean
  createdAt: number
  updatedAt: number
  checkedThrough: number // every scheduled time up to here has run, been skipped or been caught up
}
```

- The options hold what [New session](./ui.md#agent-menu) chooses, from the same per-agent values; the mode is not among them, because the scope decides it ([permission scope](#permission-scope)).
- A routine with no project gets one scratch folder of its own, `<userData>/scratch/routine-<id>`, made at its first run and kept for every later one, so a run can read what the run before it wrote. Like other [scratch folders](./session-model.md#sessions-without-a-project), it is never removed.
- A one-time routine turns itself off after its run and shows as done.

### Schedule

```ts
type Schedule =
  | { kind: 'once'; at: string } // local date and time, 'YYYY-MM-DDTHH:mm'
  | { kind: 'every'; minutes: number; from: number } // elapsed time, counted from an instant
  | { kind: 'weekly'; days: number[]; time: string } // 0 is Sunday, all seven for every day; 'HH:mm' local
  | { kind: 'cron'; expression: string } // five fields, local time
```

- **Once**, **weekly** and **cron** are wall-clock times in the system's time zone, read at each evaluation, so 9:00 stays 9:00 across daylight saving changes and after a move to another zone.
- **Every** is a length of time, 5 to 720 minutes, counted from `from` (by default the next whole hour). It is elapsed time, not the clock face: an hourly routine never runs twice in the hour that repeats when the clocks go back, nor skips the one they jump over. After such a change its runs fall an hour off the clock face (8:00 and 10:00 become 9:00 and 11:00), which the form's preview shows.
- A schedule is valid when it can run: a cron expression parses, some date matches it within the next five years, no two of its next 200 runs are less than **5 minutes** apart (_pending_), and a one-time run is in the future when saved.

**Cron syntax**, the classic five fields:

| Field        | Values                     | Names     |
| ------------ | -------------------------- | --------- |
| Minute       | 0–59                       |           |
| Hour         | 0–23                       |           |
| Day of month | 1–31                       |           |
| Month        | 1–12                       | `JAN–DEC` |
| Day of week  | 0–7, both 0 and 7 a Sunday | `SUN–SAT` |

- Each field is `*`, a value, a range `a-b`, a list `a,b`, or a step: `*/n`, `a-b/n`, or `a/n`, from `a` to the field's end. Names are case-insensitive.
- `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly` and `@annually` stand for their five fields.
- When both day fields are restricted, a day matches if either does, as cron has always read them; a day field is restricted unless it is a lone `*`.
- Seconds, years, `L`, `W`, `#`, `?` and `@reboot` are not supported; the form names the field that has them.

**Clock changes** (decision 7), for every wall-clock schedule:

- A local time that does not exist, because the clocks go forward, runs once at the first minute after the gap: with 2:00 jumping to 3:00, a 2:30 run goes at 3:00; with a 30-minute shift, at 2:30. Several times in one gap collapse into that one run.
- A local time that occurs twice, because the clocks go back, runs once, at its first occurrence. The repeated hour adds no runs, also for a cron expression that runs every few minutes.
- Times are converted with the platform's time zone data (`Intl`), the same in the host and in the preview.

A prototype of the engine passed these rules for New York, Berlin, Lord Howe's 30-minute shift and Shanghai, minified to 4.5 KB (2.1 KB gzipped), and took 0.05 ms for the next three runs and 3.8 ms to validate the next 200 (Node.js 22, 2026-10-22). It is written for OverBench, without a dependency (_pending_).

### Permission scope

```ts
interface PermissionScope {
  level: 'read' | 'edit' | 'commands'
  web: boolean
}
```

| Level                     | What a run may do without asking                                        |
| ------------------------- | ----------------------------------------------------------------------- |
| **Read only**, by default | Read and search the project                                             |
| **Edit the project**      | Also create, change, move and delete files inside the project folder    |
| **Edit and run commands** | Also run commands, which can do anything the user can, as the form says |
| **Use the web**, a switch | Fetch pages and search the web, at any level                            |

How the host holds a run to it is in [permission scope on ACP](#permission-scope-on-acp) (_pending_, against the agent's own modes).

### Run

```ts
interface RoutineRun {
  id: string
  routineId: string
  trigger: 'schedule' | 'catch-up' | 'manual'
  scheduledFor: number | null // the scheduled time it stands for; null for Run now
  count: number // scheduled times it stands for: more than 1 for a catch-up or merged skips
  status: RunStatus
  reason: 'overlap' | 'plan_limit' | null // why it was skipped
  sessionId: string | null // null for a skip, and once the session is deleted
  startedAt: number | null
  endedAt: number | null
  workingMs: number // time working, without the time waiting for approval
  stopReason: StopReason | null
  error: { message: string; detail?: string } | null
  output: string | null // the turn's answer, up to 64 KB
  usage: TokenTotals | null
  changedFiles: string[] // paths its edits touched, relative to the project
  seen: boolean
}

type RunStatus =
  | 'queued' // due, waiting for a free slot
  | 'starting' // its session is being created
  | 'running'
  | 'waiting' // a permission request beyond its scope waits for the user
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled' // stopped by the user
  | 'interrupted' // stopped by quitting, or by the agent host stopping
  | 'skipped'
```

- **Active** runs are `queued`, `starting`, `running` and `waiting`; at most one per routine.
- Consecutive skips of one routine for one reason merge into one record with a `count`, so a routine whose runs outlast its interval does not fill its history with skips.
- `output`, `usage`, `changedFiles` and the status are the run's result as data, the record a later step of a chain reads ([chaining later](#chaining-later)).

## Storage

- **Routines** are a JSON file of the agent host, `state/routines.json`, written and recovered by the rules of the other [state files](./persistence.md#writing-safely): debounced, atomic, versioned, and moved aside when it does not parse.

  ```ts
  interface RoutinesFile {
    version: 1
    routines: Routine[]
  }
  ```

  It changes when the user edits a routine and when a run is recorded (`checkedThrough`), so at most a few times an hour.

- **Runs** are a table in `state/threads.db`, beside the threads their sessions keep, through the same worker. The table raises the database's `user_version` to 2, with a migration from 1 ([versioning](./persistence.md#threads)).

  ```sql
  CREATE TABLE routine_runs (
    routine_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,   -- per routine, from 1; newest last
    run_id     TEXT NOT NULL,
    session_id TEXT,
    status     TEXT NOT NULL,
    json       TEXT NOT NULL,      -- the RoutineRun
    PRIMARY KEY (routine_id, seq)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX routine_runs_by_id ON routine_runs (run_id);
  ```

- **Sessions** of runs are sessions like any other, in the session index and the thread store, with `origin: 'routine'` and `routine` naming the routine and the run ([session model](./session-model.md#routine-runs)).
- **Keeping them**: as decided, a run's session stays until the user deletes it. The session index is one JSON file written whole, which costs 4.3 MB and 5.9 ms per write at 10,000 sessions and 22 MB and 29 ms at 50,000 (measured on 2026-10-22, Node.js 22, Apple silicon); a routine every 5 minutes makes 10,000 sessions in 35 days. Whether to keep only the sessions of each routine's latest runs is _pending_.

## The scheduler

### Where it runs

The agent host runs the scheduler, in `src/agent-host/routines/`:

- A run is a session, and the host owns sessions, their agents and their storage.
- The host runs while the app does, with or without a window: on macOS OverBench keeps running when its last window closes, and routines keep running with it.
- Main has the operating system's power events, since `powerMonitor` exists only in main, and forwards them as `host:power` ([main process](#main-process)).
- The renderer only shows; nothing scheduled waits for a window.

After a host crash the new host reads `routines.json` and treats the time it was down like time the app was closed ([sleep, wake and launch](#sleep-wake-and-launch)); a run that was working is `interrupted`.

### Keeping time

- **One timer** is set for the earliest next run among the enabled routines, at most 60 s ahead. When it fires, the host compares the date (`Date.now()`) with each routine's next run time, starts what is due, and sets the timer again. A run starts within a second of its time while the computer is awake, and a check never lies more than a minute ahead. With no enabled routine there is no timer.
- **The date decides.** Timers count on a clock that stops while the computer sleeps, on macOS and Linux, so a timer is only an alarm; what is due is always read from the date.
- **`checkedThrough`** is the latest scheduled time a routine has accounted for, by a run, a skip or a catch-up. A routine never runs a time at or before it, so setting the clock back runs nothing twice.
- **A jump forward**: when the date moved more than 2 minutes further than the monotonic clock since the last check, the time between counts as missed, by the catch-up rule below. Turning a routine on or changing its schedule sets `checkedThrough` to now, so neither catches up the time it was off.
- **The time zone** is read at each check. Node.js keeps the zone it started with, so the scheduler's pull request settles how the host reads it afresh without a restart, with main's zone as the fallback; a changed zone sets every wall-clock routine's next run again.

### Sleep, wake and launch

- At launch, and on `host:power` `resume`, each enabled routine's scheduled times after `checkedThrough` and up to now were missed. When there is one or more, the routine gets **one catch-up run**, for the latest of them, with `count` saying how many it stands for; the rest are skipped without records of their own (decision 1). `checkedThrough` moves to now.
- A one-time routine whose time passed while OverBench was closed runs once at launch, as its catch-up, then is done.
- Catch-ups wait **60 s after launch** and **30 s after a wake**, so launch stays fast and the network is back, then start in the order of their scheduled times, within the [limit](#when-a-run-may-start).
- A run working when the computer went to sleep continues on wake: its agent's turn either goes on or fails, and the run ends with it.

### When a run may start

A run that comes due goes through these in order:

1. **Overlap** (decision 5): while the routine has an active run, the new one is skipped, `reason: 'overlap'`. A run waiting for approval keeps its later runs skipped until it is answered or stopped.
2. **Plan limits** (decision 6): while the routine's agent is paused, the run is skipped, `reason: 'plan_limit'` ([below](#plan-limits)).
3. **Concurrency**: at most **two** runs work at once across all routines (_pending_); one due beyond that is `queued` and starts when a slot frees, first due first. The user's own sessions do not count.
4. **Readiness**: the agent must be installed and signed in, and the project folder must exist. Otherwise the run fails at once, with the reason ("Claude Code needs you to sign in", "The project folder is missing") and a notification; the next scheduled time tries again.

**Run now** starts a run at once, outside the concurrency limit and a plan-limit pause, since the user asked for it; it is refused only while the routine has an active run.

### Plan limits

- **Near** means a current window of the agent's [plan limits](./session-model.md#plan-limits) that is `reached`, or whose `usedPercent` is **90 or more**: the level the interface already draws in `--destructive` ([usage levels](./design-system.md#meaning); _pending_). A window whose `resetsAt` has passed does not count.
- Before a run starts, the host reads the agent's limits again when the last reading is more than 10 minutes old, with `agents.refreshLimits`, which costs no model call. An agent that reports no limits, such as OpenCode or an API key account, never pauses.
- When a window is near, every routine of that agent **pauses** until the window's `resetsAt`, or for an hour when it has none, then the host reads the limits again. Runs due meanwhile are skipped, merged into one record, and are not caught up. The pause is announced once, by notification and on the Routines page.
- A run already working goes on; if the limit is reached during it, the agent's own error ends it.

## A run

### Starting its session

1. The run is recorded as `starting`, and `checkedThrough` moves to its scheduled time.
2. The host creates the session as `sessions.create` does, in the project or the routine's scratch folder, with the routine's options, then sets the mode its scope names for that agent ([below](#permission-scope-on-acp)). A mode that cannot be set fails the run before anything is sent: a run never starts in a broader mode than its scope.
3. The session is a routine session: `origin: 'routine'`, `routine` naming the routine and the run. It is not listed under its project, and `sessions.list` leaves it out ([session model](./session-model.md#routine-runs)).
4. The prompt is sent as the session's first prompt, and the run is `running`.

A model the agent no longer offers is skipped as New session skips it, and the run starts with the agent's default; the run's record notes it.

### Permission scope on ACP

A run's session runs in the agent's strictest mode that still asks, and the host answers each `session/request_permission` against the scope (_pending_):

| Tool call `kind`          | Read only    | Edit the project | Edit and run commands |
| ------------------------- | ------------ | ---------------- | --------------------- |
| `read`, `search`, `think` | Allowed      | Allowed          | Allowed               |
| `edit`, `delete`, `move`  | Pauses       | Allowed          | Allowed               |
| `execute`                 | Pauses       | Pauses           | Allowed               |
| `fetch`                   | With **web** | With **web**     | With **web**          |
| `switch_mode`, `other`    | Pauses       | Pauses           | Pauses                |

- **Inside the project**: a request is allowed only when every location it names resolves inside the project folder by the [platform's path rules](./agent-host.md#platform-differences), and an edit's only outside `.git`. A request that names no location is allowed only for `think`, `fetch` and `execute`, where the level and the web switch decide.
- **How it answers**: with the request's `allow_once` option, never an `allow_always` one, which would outlive the run in the agent's own settings. A request with no `allow_once` option pauses. The tool entry records the answer as the routine's (`permissionResult.by: 'routine'`), so the thread shows what the routine allowed.
- **Pausing**: anything else stays pending in the run's session, as any [permission request](./session-model.md#permissions) does. The run is `waiting`, the user is notified, and the time limit stops counting until the request is answered or the run is stopped.
- **The agent's own rules come first**: what an agent's settings already allow, it does without asking, in a routine as in any session. The scope narrows only what the agent asks about.

The mode each level uses, observed on 2026-10-22 with claude-agent-acp 0.94.0, codex-acp 2.2.2 and OpenCode 2.0.32:

| Level                 | Claude Code       | Codex                               | OpenCode |
| --------------------- | ----------------- | ----------------------------------- | -------- |
| Read only             | `default`, Manual | `read-only`, Read-only              | `plan`   |
| Edit the project      | `default`, Manual | `workspace-write`, Workspace access | `build`  |
| Edit and run commands | `default`, Manual | `workspace-write`, Workspace access | `build`  |

- **Claude Code** asks before edits and most commands in Manual mode, so the host answers each.
- **Codex** keeps its own sandbox: in Workspace access it runs commands inside the project without asking and without network, so **Edit the project** also runs such commands; leaving the project or reaching the network asks.
- **OpenCode** asks only for what its own permission settings mark `ask`, and by default nothing, and its Plan mode refuses edits but not commands. The host cannot hold it to a scope, and the form says so (_pending_).
- A routine never uses a mode that answers for the user: Claude Code's Auto and Bypass permissions, Codex's Auto review and Full access.

### Ending

The run ends with its first turn: the host watches the turn as any [prompt turn](./session-model.md#prompt-turns).

| The turn                                                           | The run       |
| ------------------------------------------------------------------ | ------------- |
| Ends with `end_turn`                                               | `succeeded`   |
| Ends with `refusal`, `max_tokens` or `max_turn_requests`, or fails | `failed`      |
| Reaches the time limit, which cancels it as **Stop** does          | `timed_out`   |
| Is stopped by the user                                             | `cancelled`   |
| Ends because the agent exited                                      | `failed`      |
| Ends because the app quit or the agent host stopped                | `interrupted` |

- `output` is the turn's answer, its last agent messages as the thread folds them ([tool calls](./ui.md#tool-calls)), up to 64 KB; `usage` the turn's token counts; `changedFiles` the locations of its edits.
- The **time limit** counts while the run works; time waiting for approval does not count.
- Quitting while a run works asks first, since its session is busy ([shutdown](./agent-host.md#shutdown)). An interrupted run is not run again.
- Afterwards the session is an ordinary one: it lets its agent go when idle, and the user can open it, continue it, fork or delete it. A later turn changes nothing in the run's record. Deleting the session clears the run's `sessionId` and keeps the record.

### Notifications

Through `host:attention` and main's [notification rules](./agent-host.md#main-and-host-messages): shown only while no OverBench window is focused, one per session at a time, each kind behind its switch in Settings › Notifications.

| Event                      | Kind             | Switch             | Title and body                                                            |
| -------------------------- | ---------------- | ------------------ | ------------------------------------------------------------------------- |
| A run succeeded            | `routine-ended`  | **Routine runs**   | The routine's name; the first line of its output                          |
| A run failed or timed out  | `error`          | **Errors**         | "Morning briefing failed"; the reason                                     |
| A run waits for approval   | `permission`     | **Needs approval** | "Morning briefing needs approval"; the tool call's title                  |
| An agent's routines paused | `routine-paused` | **Routine runs**   | "Routines paused for Claude Code"; the window, its use and when it resets |

- A run's session sends `routine-ended` in place of `turn-ended`, so a finished run notifies once.
- A click opens the run's session, or the Routines page for a pause (`app:command` `open-routines`).
- While a window is focused, the [sidebar row](#sidebar-row) carries the signal instead.

## Host protocol

Requests, on the [renderer's port](./host-protocol.md#requests):

| Method               | Params                   | Result                                       | Notes                                                                                  |
| -------------------- | ------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `routines.list`      | none                     | `RoutineView[]`                              |                                                                                        |
| `routines.create`    | `RoutineDraft`           | `RoutineView`                                | Validated as below; the routine starts on                                              |
| `routines.update`    | `{ routineId, changes }` | `RoutineView`                                | Any fields of the draft; a changed schedule or turning on sets `checkedThrough` to now |
| `routines.delete`    | `{ routineId }`          | none                                         | Deletes its runs and their sessions; the interface confirms first                      |
| `routines.runNow`    | `{ routineId }`          | `RoutineRun`                                 | `busy` while the routine has an active run                                             |
| `routines.cancelRun` | `{ runId }`              | none                                         | Drops a queued run, or stops a working one as **Stop** does                            |
| `routines.runs`      | `{ routineId, before? }` | `{ runs: RunView[], older: number \| null }` | 50 at a time, newest first, each with its session's summary                            |
| `routines.markSeen`  | `{ routineId }`          | none                                         | The routine's page is shown: its ended runs count as seen                              |

```ts
type RoutineDraft = Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'checkedThrough' | 'enabled'>

interface RoutineView extends Routine {
  state: 'on' | 'off' | 'done' | 'paused'
  nextRunAt: number | null // null while off, done or paused
  pause: {
    agentId: AgentId
    window: string
    usedPercent: number | null
    resetsAt: number | null
  } | null
  activeRun: RoutineRun | null
  lastRun: RoutineRun | null
  unseen: { failed: number; ended: number } // runs not seen since they ended
}

interface RunView extends RoutineRun {
  session: SessionSummary | null
}
```

Events, to all ports: `routine.changed` with a `RoutineView` whenever a routine, its state or its next run changes; `routine.removed` with `{ routineId }`; and `routine.run` with a `RoutineRun` whenever a run's status changes, which is also the hook a later trigger listens to.

**Validation**, in `validate.ts` like every request: a name of at most 120 characters (an empty one is made from the prompt), a prompt of 1 to 100,000 characters, a known `agentId`, a `projectPath` that is null or an existing folder, at most 20 options with ids and string values of at most 200 characters, a schedule that passes the [engine's](#schedule) validation, a scope and a time limit from their sets.

## Main process

- **Power**: main forwards `powerMonitor`'s `suspend` and `resume` to the host as `host:power`.
- **Open at login**, the setting `general.openAtLogin`:
  - **macOS** and **Windows**: `app.setLoginItemSettings({ openAtLogin })`, on Windows with `args: ['--opened-at-login']`. When macOS reports the item `requires-approval`, the setting's row says to allow OverBench in System Settings › General › Login Items.
  - **Linux**, where Electron has no login items: main writes an autostart entry, `~/.config/autostart/overbench.desktop`, whose `Exec` is the app with `--opened-at-login` (the AppImage's own path when run from one), and deletes it when the setting is turned off.
  - Opened at login, OverBench starts **without a window on macOS** (`wasOpenedAtLogin`), where the app runs without one, and **with its window minimized** on Windows and Linux, where closing the last window quits.
  - In a development build the setting is disabled, since a login item would start the development copy.
- **Keeping awake**: while a run works, main holds a `powerSaveBlocker` of type `prevent-app-suspension`, which stops idle sleep but never wakes the computer or overrides a closed lid (_pending_).
- **Notifications**: the kinds `routine-ended` and `routine-paused` follow a new switch, `notifications.routines`, on by default, beside `notifications.turnEnded`.

## Interface

> Recommended: page A, schedule builder 1 and the scope levels, all _pending_. The options page lets the maintainer try each against the others.

### Sidebar row

A **Routines** row (`CalendarClock`) follows **Usage**. It opens the Routines page and stays highlighted while that page, a routine's page or a run's session is shown. Its end carries the strongest signal of the runs, with a session row's priorities: the `--attention` count of runs waiting for approval, the error mark for a failed run not yet seen, the running dot while a run works, the unread dot for an ended run not yet seen; otherwise nothing. Its accessible name says it ("Routines, 1 waiting for approval"). Showing a routine's page counts its ended runs as seen, since their results are on it.

### Routines page

Option **A**, list and page (recommended): one centred column in the composer's 760 px, like New session's.

- **Header**: "Routines" at the page title role, one line in the small role ("Prompts that run on a schedule while OverBench is open, each run in a session you can open later."), and **New routine** (`Plus`, the `primary` button) at its end.
- **Notices** under it, as `Alert`s: a plan-limit pause (`info`, `ChartNoAxesColumn`: "Claude Code's routines are paused", its window, its use and when they resume), and a `routines.json` that could not be read (`error`, with what happened to it).
- **The list**, under two group labels with their counts, **On** sorted by next run and **Off** by name, done one-time routines last among them. Each routine is a two-line [row](./visual-style.md#rows): the agent's 14 px mark; its name at weight 500 and, on the second line in the caption role, the schedule in words and the project's name; at the end its state and a `Switch` that turns it on or off.
- **The state** at a row's end, in this order: "Waiting for approval" as a `warning` pill; the running dot with "Running"; "Resumes at 14:30" during a pause; the next run ("Tomorrow, 9:00 AM"); "Off"; "Done". A failed last run adds a 12 px `CircleAlert` in `--destructive` after the name.
- **A row** opens the routine's page through a button laid under its content, so the switch stays a control of its own. Its context menu holds **Run now**, **Duplicate** and, after a separator, **Delete…**.
- **At the foot**, while Open at login is off: "Routines run only while OverBench is open." with **Open at login**, which turns the setting on.

Option **B**, split view: the list in a 280 px column on the left and the chosen routine on the right, its runs and settings as tabs. It switches routines in one click but adds a fourth column beside the sidebar, cramped at 960 px, and no other screen is laid out that way.

Option **C**, composer first: the page opens on a composer like New session's, the schedule, permissions and time limit as parts of its route line, with the routines listed under it, each unfolding its runs in place. It is the fastest way to write a routine, but editing one in a composer made for creating reads oddly, and the scope and time limit hide behind chips.

### A routine's page

- **← Routines** leads back, as `Esc` does.
- **The title row**: the agent's tile, as on an agent's page in Settings; the name at the page title role, which a click renames in place as a session's title does; under it, in the small role, the state ("Next run tomorrow, 9:00 AM · in 14 h", "Off", "Done", "Paused until 14:30: Claude Code's 5-hour limit is 92% used"). At the row's end, **Run now** (`Play`, `outline`), the `Switch`, and **More** (`Ellipsis`) with **Duplicate** and **Delete…**.
- **Notices**: a run waiting for approval (`warning`: "A run is waiting for your approval", "It asked to do something outside its permissions. Runs due meanwhile are skipped.", **Open the run**), the plan-limit pause, and a run that could not start, with its way forward (**Choose a project…**, **Sign in…**).
- **Task**, in Settings rows with the name and description on the left and the control on the right, under it when the column is narrow:
  - **Prompt**: a field in the composer's look that grows with its text and saves when it loses focus; emptied, it keeps the last prompt.
  - **Project**: New session's project menu, with **No project** for the routine's own folder.
  - **Agent and model**: New session's [agent menu](./ui.md#agent-menu), without the mode, which the scope decides.
- **How it runs**:
  - **Schedule**: the builder with its preview ([below](#schedule-builder)).
  - **Permissions**: the scope picker ([below](#permissions-picker)).
  - **Time limit**: a quiet select of 15 and 30 minutes, 1, 2 and 4 hours, 1 hour by default.
- **Runs**: the history, newest first, 50 at a time with **Show more**. Each run is a row: its status icon, when it was due (or started, for **Run now**) with a muted "Catch-up" or "Run now" after it, the first line of its output or why it did not run, and its duration in the meta role, or how long it has waited. A row with a session opens it; a skipped one is not a button. "No runs yet." until the first.

  | Run                             | Icon                                  |
  | ------------------------------- | ------------------------------------- |
  | Succeeded                       | `CircleCheck`, `--success`            |
  | Failed, timed out               | `CircleAlert`, `--destructive`        |
  | Skipped, cancelled, interrupted | `CircleSlash`, `--muted-foreground`   |
  | Waiting for approval            | The `--attention` dot                 |
  | Running, starting               | The running dot; a `Spinner` starting |
  | Queued                          | None, with "Queued" in the summary    |

Every field applies at once, as Settings does: the schedule once it is valid, the prompt when it loses focus. An invalid schedule is not saved, and the field says the routine still runs on the last valid one.

**New routine** opens the same page with a name field ("Untitled routine"), the prompt focused, and defaults: the project of the shown session or the last one used, New session's agent and model, weekdays at 9:00, Read only without the web, 1 hour. **Create routine** (`primary`) and **Cancel** end it; Create is disabled until the prompt, the project and the agent are set and the schedule is valid, and its tooltip says what is missing. Created, the routine is on and its page shows, where **Run now** tries it.

### Schedule builder

Option **1**, kinds as segments (recommended): a [segmented control](./design-system.md#segmented-controls) of **Once**, **Every**, **Daily**, **Weekly** and **Cron**, then that kind's fields:

- **Once**: a date, from the `Calendar` in a `Popover` as the usage page's range picker uses it, in single-date mode with past days disabled, and a time.
- **Every**: a select of 5, 10, 15 and 30 minutes and 1, 2, 3, 4, 6, 8 and 12 hours, then "counted from" and a time.
- **Daily**: a time. **Weekly**: seven day toggles in the locale's week order, at least one on, in the [pressed look](./design-system.md#toggle-buttons), then a time.
- **Cron**: a mono field; under it the five fields' names, the one at the caret marked in `--checked-tint`, and one caption line of the syntax ("* any · a-b range · a,b list · \*/n every n · names like MON or JAN").
- Times are `Input` `type="time"`, in the locale's 12- or 24-hour form.

Under the fields, the **preview**, a quiet block on `--muted`: the schedule in words at weight 500 ("Weekdays at 9:00 AM", "工作日 09:00") and the next three runs, each with its day and time ("Tomorrow, 9:00 AM") and, at the end in the meta role, how far off it is. A run a clock change moves carries a neutral note ("Clock change: runs when the skipped hour ends"). A schedule that cannot run replaces the runs with what is wrong, in `--destructive` with `CircleAlert`, naming the field ("The hour field is out of range."), once the value is complete: when the field loses focus, or 800 ms after typing stops ([text input](./ux-guidelines.md#text-input)); meanwhile the last valid runs stay, dimmed.

Option **2**, a sentence: "Runs [every weekday ▾] at [9:00]", one select of phrases (once on…, every 15 or 30 minutes, every hour, every 2 or 4 hours, every day, every weekday, every weekend day, every week on…, a cron expression) that brings in the fields it needs. It reads as what it does, but the select is long to scan and the sentence's word order does not survive translation. Option **3**, cron first: quick picks fill a cron field that is always shown. One model for every schedule, but cron sits in front of everyone, and once and odd intervals need picks of their own.

### Permissions picker

With the scope levels (recommended): the three levels as a radio list, one Tab stop moved with the arrow keys, each with its name and its description, then **Use the web** as a `Switch` row. Under them, one caption line for the routine's agent from the [mode table](#permission-scope-on-acp), such as OpenCode's "OpenCode asks only for what its own permission settings mark “ask”; by default it asks nothing, so OverBench cannot hold it to this scope."

The alternative lists the agent's own modes, as the session's mode menu does, and pauses on every request the agent sends. OverBench then never answers a request, but each agent offers different choices, and Claude Code has no mode between Accept edits and Auto for a routine that runs tests.

### A run's session

- The top bar starts with the routine's name as a link back to its page, as a sub-session's starts with its parent's.
- The first message, the prompt, carries a muted label under its bubble: `CalendarClock` "Sent by Morning briefing · due Tue 9:00 AM" ("Catch-up for Tue 9:00 AM", "Run now").
- A tool call the routine allowed shows "Allowed by the routine" where an answer shows. A request beyond the scope is the usual [permission card](./ui.md#permission-requests), with one more line: "Outside this routine's permissions: Read only."
- The composer works as in any session.

### Settings

- **General** gains a group, **Startup**, with **Open at login**: "Routines run only while OverBench is open." With macOS waiting for approval, its description says where to give it.
- **Notifications**' **Notify me** gains **Routine runs**: "A routine's run ended, or its routines paused at a plan limit."

### States

| State                    | What shows                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| No routines              | One `Empty`: `CalendarClock`, "No routines yet", what a routine is, and **New routine**                       |
| Loading                  | `Skeleton` rows at the rows' height                                                                           |
| `routines.json` unusable | The `error` notice, with the file set aside; the list is empty and New routine works                          |
| Paused for a plan limit  | The notice on the page, "Resumes at 14:30" on the rows, "Paused until 14:30" on the routine's page            |
| Waiting for approval     | The pill on the row, the notice on the routine's page, the count on the sidebar row, the run's session's card |
| A run that cannot start  | The failed run in the history with its reason, a notice with its way forward, the error mark in the sidebar   |
| Agent host restarting    | The page keeps what it showed and refetches once connected                                                    |

### Motion and keyboard

- Rows, switches, segments and menus follow their [patterns](./design-system.md#patterns); a new run row enters with the new entry pattern; the preview changes in place without motion.
- The list is one Tab stop moved with the arrow keys; `Enter` opens a routine; a focused row's switch is its next Tab stop. On a routine's page, `Esc` goes back. No new global shortcut.
- An `aria-live="polite"` region announces a run's end while the Routines page or the routine's page is shown.

## Chaining later

Not built now; what this version leaves for it:

- **Triggers** are a union with one kind, `schedule`. Chaining adds `{ kind: 'after'; routineId; on: 'succeeded' | 'failed' | 'ended' }`, and later kinds such as a manual-only routine or a repository event. The scheduler's question becomes "has a trigger fired", and overlap, plan limits and concurrency apply unchanged.
- **Results as data**: every run keeps its status, `output`, `usage`, `changedFiles` and session, and `routine.run` announces each change. A chained routine reads its upstream run's record when it starts.
- **Templates**: a prompt will be able to name the upstream result (`{{previous.output}}`, `{{previous.status}}`, `{{run.date}}`). This version sends prompts as written; a routine created with templates is marked so in its file, so an older prompt that happens to hold braces never changes meaning.
- **Lineage**: a chained run's `routine` reference will carry the run that caused it, so the history can show a chain, and a chain is checked for cycles when it is saved.

## Testing

- **Unit**, in `src/shared/schedule.test.ts`: the engine with fixed zones through `Intl`, the gap and overlap rules in New York, Berlin, Lord Howe (30 minutes) and Santiago (a change at midnight), names, macros, steps, the either-day rule, validation and the minimum interval; the words for schedules in both languages, in the renderer.
- **Scheduler**: with an injected clock and timer, as the host's other timings are options ([testing](./testing.md#unit-and-integration-tests)): due runs, overlap, the concurrency queue, a launch after missed runs giving one catch-up, wake, the date jumping forward and back, a plan-limit pause and its end.
- **Integration**, with the [fake agent](./testing.md#fake-agent): a run through `basic-turn`; `permission` both inside and beyond a scope, with `by: 'routine'` recorded; the time limit with `cancel`; `crash` failing a run; a run's session left out of `sessions.list`.
- **By hand, per platform**: sleep and wake with a routine due, the login item, and the notifications.

## Building it

The design merges first; then each part is a sub-issue of #22 with one pull request, useful on its own, in this order:

1. **Routines run by hand**: the store, the Routines page and a routine's page, **Run now**, runs as sessions under their routine, the run history, the sidebar row and the run-end notification. Without a scope picker yet, every permission request pauses.
2. **Schedules**: the shared engine, the builder and its preview, the scheduler with catch-up at launch and wake (`host:power`), overlap and the concurrency limit.
3. **Permission scopes**: the picker, the modes per agent, the host's answers inside the scope, and the security rule that allows them.
4. **Plan-limit pauses**: the check, the pause and its end, the notice and the notification.
5. **Open at login**: the setting and the login item on each platform.

Parts 3 to 5 can go in any order after 2.

## Open questions

Each with the recommendation first.

1. **Page**: A, a list and a page per routine · B, a split view · C, composer first.
2. **Schedule builder**: 1, kinds as segments · 2, a sentence · 3, cron first.
3. **Permission scope**: the three levels, with OverBench allowing what they cover once at a time · the agent's own modes, every request pausing.
4. **Cron parsing**: our own engine, 4.5 KB minified, with the gap rule above · `croner` (MIT, 22.7 KB minified, 6.8 KB gzipped by its own figures), which skips a time in a gap, so the rule would need a wrapper.
5. **Near a plan limit**: 90% used or reached · 80% · a setting.
6. **Shortest interval**: 5 minutes · 1 minute · 15 minutes · 1 hour.
7. **Runs at once across routines**: 2 · 1 · 3 · a setting.
8. **Keeping run sessions**: the sessions of each routine's latest 100 runs, older runs keeping their records · every session, as decided, with the index moved to SQLite before it grows.
9. **OpenCode in routines**: allowed, with the note that its own settings decide · left out until it can be held to a scope.
10. **Keep the computer awake while a run works**: yes, idle sleep only · no.
11. **Deleting a routine**: deletes its runs' sessions, after one confirmation that names how many · keeps them, and they join their projects' lists.

## Alternatives considered

- **The operating system's schedulers** (a launch agent, a scheduled task, a user crontab) could start runs with the app closed, but decision 2 keeps routines to while the app is open, and they would need a background OverBench to hand runs to anyway.
- **Scheduling in main**: main would still drive sessions through the host, and it stays thin. **In the renderer**: it stops with its window.
- **A timer per routine**: timers stop in sleep and drift across clock changes, and many timers do what one does.
- **A one-minute tick**: as robust, but runs start up to a minute late; the capped timer starts them on time for the same cost.
- **Wall-clock intervals**: "every 2 hours" as clock hours would run twice or skip once at each change and restart at midnight for intervals that do not divide a day; elapsed time has neither problem.
- **Skipping times in a gap**: a daily run would vanish once a year; running at the gap's end keeps it.
- **Runs in a JSON file**: run outputs make it large, and the history is read a page at a time, which the thread database already does.
