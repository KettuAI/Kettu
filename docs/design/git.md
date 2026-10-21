# Git and pull requests

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.4](../milestones/m0.md#work-packages) · Observed on 2026-10-20: `gh` 2.x

Almost every project an agent works on is a git repository, and what the agent leaves behind is commits, pushes and pull requests. OverBench shows that state wherever you look at a session: the branch and its sync state in the top bar, the full picture in a branch popover, commits and pushes as they happen in the thread, and pull requests as live chips. The interface is in [ui.md](./ui.md#git-in-the-top-bar).

M0 only reads. Committing, pushing and opening pull requests stay with the agent and the [terminal](./terminal.md); OverBench offers no staging area or commit form. The one write it performs is **Fetch**, which updates remote-tracking refs and nothing else.

## Where it runs

The git service lives in the agent host (`src/agent-host/git/`), next to the agents, because it needs the same resolved environment to find `git` and `gh`, and the session events that tell it when to look.

- Every git and `gh` call is an asynchronous `execFile` child process in the project folder, never through a shell, with a 10 s timeout (60 s for **Fetch**); a child that outlives its timeout is killed. Standard input is closed at once, so nothing can wait for input. A project has at most one status run in flight; requests that arrive meanwhile coalesce into one follow-up run, and everyone who asked meanwhile gets that run's result.
- The command is looked up in the `PATH` of the resolved agent environment. On macOS and Linux `execFile` does that. On Windows the service does it itself, in `PATH` order with the `.com` and `.exe` entries of `PATHEXT` (`git.exe` and `gh.exe` are what both install), and skips relative `PATH` entries, because `CreateProcess` would look in the working directory first and a repository could plant a `git.exe` there. A `.cmd` or `.bat` shim is never started, since that needs a shell. The path found is cached per `PATH`; a miss is looked up again next time.
- The environment adds `GIT_OPTIONAL_LOCKS=0`, so a status run never takes `index.lock` and never collides with a git command the agent is running, and `GIT_TERMINAL_PROMPT=0` with `GCM_INTERACTIVE=never`, so a fetch that needs credentials fails instead of waiting for input or opening a Git Credential Manager window. The first two are what VS Code's git extension sets. `gh` gets `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`.
- Output is parsed from machine formats: `--porcelain=v2 -z`, `--format` with NUL separators, and `gh --json`. The few human-readable texts that are matched (`--shortstat`, git's "not a git repository" error, `gh auth status`) are read under `LC_ALL=C`, which every child runs with, so a translated git cannot break them.
- `git` missing: `repo` is `null`, `GitTools.git.found` is `false`, the top bar shows nothing, and Settings › Git says so. `gh` missing or signed out: everything works except pull requests.
- A refresh that fails (timeout, a locked repository, git exiting with an error) never throws: the last good status is returned with `stale: true`, the failure is logged once until it changes, and the next successful refresh clears the flag. A folder that does not exist or is not a repository is a result (`repo: null`), not a failure.

## Repository status

```ts
interface GitStatus {
  projectPath: string
  repo: { root: string; gitDir: string } | null // null: not a repository
  head: {
    branch: string | null // null when detached or unborn
    oid: string | null // null on an unborn branch
    detached: boolean
  }
  upstream: { name: string; ahead: number; behind: number } | null // null: not published
  base: { name: string; ahead: number; behind: number } | null // against the default branch
  changes: {
    staged: number
    unstaged: number
    untracked: number
    conflicted: number
    insertions: number
    deletions: number
  }
  operation: { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert'; step?: [number, number] } | null
  commits: CommitSummary[] // on HEAD but not on the base, newest first, at most 20
  remote: { name: string; url: string; github: { owner: string; repo: string } | null } | null
  lastFetchedAt: number | null
  updatedAt: number
  stale: boolean // the last refresh failed; the values are the previous ones
}

interface CommitSummary {
  oid: string
  subject: string
  authoredAt: number
  pushed: boolean // reachable from the upstream
}
```

One refresh runs these, and skips what a previous answer makes pointless. Independent steps run in parallel.

| Step | Command                                                                                                                     | Gives                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0    | `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir`, only when the answer is not cached                     | `repo`, and where refs and config live (they differ in a worktree)    |
| 1    | `git status --porcelain=v2 --branch -z --untracked-files=normal`                                                            | `head`, `upstream` with ahead and behind, and the change counts       |
| 2    | `git diff --shortstat HEAD`, only when something tracked has changed                                                        | `insertions`, `deletions`                                             |
| 3    | `git rev-list --left-right --count <base>...HEAD`                                                                           | `base`                                                                |
| 4    | `git log -n 20 --format=%H%x00%s%x00%at <range>` and `git rev-list <upstream>..HEAD`                                        | `commits`, and which of them are not pushed                           |
| 5    | `stat` on `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `FETCH_HEAD` in the git dir | `operation`, the rebase step from `msgnum` and `end`, `lastFetchedAt` |

- Step 0 is cached per project and trusted while `HEAD` exists in the git dir. A linked worktree has its own git dir (its `HEAD`, index and rebase state) and shares the common dir with the main working tree (branches, remotes, config).
- **`head`**: an unborn branch (no commit yet) has `branch: null` and `oid: null`, like a detached head has `branch: null` and `detached: true`. Steps 2 to 4 are skipped for an unborn branch.
- **`upstream`** is `null` when the branch has none, and also when the configured upstream branch no longer exists (deleted on the remote and pruned); git reports no counts for it.
- The **base** is the remote's default branch, from the `refs/remotes/<remote>/HEAD` symbolic ref. Without it, `<remote>/main`, then `main`, then `<remote>/master`, then `master`, whichever exists first; with none, `base` is `null`. One `git for-each-ref` call answers all of it, so nothing needs caching.
- **`commits`** come from `<base>..HEAD`. With no base, or with `HEAD` on the base branch itself (working on `main`), there is no base comparison and the list holds the commits not pushed: `<upstream>..HEAD`, or the latest ones when there is no upstream either. `pushed` is true for a commit reachable from the upstream; the unpushed set is read with `--max-count=1000`.
- The **remote** is the upstream's remote (`branch.<name>.remote`), else `origin`, read from the repository's config with one `git config --local --get-regexp` call that is cached until the config file changes. A `github.com` URL, in HTTPS, `ssh://` or `git@github.com:owner/repo` form, fills `github`; any other host leaves it `null`, and pull requests are not shown. `url.<base>.insteadOf` rewrites are not applied.
- **`operation`**: `rebase-merge/` or `rebase-apply/` is a rebase (the step is `msgnum` of `end`, or `next` of `last`); `rebase-apply/` with `applying` is `git am`, which is not shown. Then `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD`. `lastFetchedAt` is the newest `FETCH_HEAD` modification time in the git dir and the common dir.

### When it refreshes

Only projects shown in some window are kept live. A project that comes into view refreshes at once.

- **The git dir changes**: one recursive `fs.watch` on the git dir, debounced by 300 ms (a burst that keeps going is reported after 2 s at the latest), ignoring `objects/`, `logs/` and `*.lock`. It catches commits, checkouts, pushes and fetches from the agent, the terminal or any other tool. In a linked worktree the shared `refs/` and the common dir are watched too, because a branch is committed to there. Where a recursive watch is not available, the service watches the git dir, `refs/heads`, `refs/remotes` and each remote's folder one level deep, and the triggers below keep the status current. A watcher that fails is replaced on the next refresh.
- **A tool call ends** in a session of the project, for the kinds that can change the repository (`edit`, `delete`, `move`, `execute`, `other`), and **a turn ends**. Calls of other kinds neither refresh nor produce events.
- **The window gains focus**: the host calls `status()`, at most once every 2 s. The service coalesces runs but does not throttle on its own.
- **Fetch in the background** (Settings › Git, off by default) runs `git fetch --prune` every 5 minutes, one project after another, for shown projects with a remote, so behind counts do not go stale. A failing background fetch is logged once and retried at the next interval.
- A project that no window shows keeps its last status, but no watcher, timer or fetch; a request such as `status()` still refreshes it.

## Pull requests

Pull requests come from the GitHub CLI, so OverBench never handles a GitHub token: `gh` keeps the user's own sign-in.

- The host asks for the tools at start and after **Reload environment**; `gh auth status --hostname github.com` decides the state: `not-installed` when `gh` is not found, `signed-out` on a non-zero exit, `ready` otherwise, with the account name when gh prints one. Versions come from `git --version` and `gh --version`. The answer is cached until the next reload, and shown projects start looking for pull requests when a reload turns `gh` ready.
- **The current branch**: `gh pr view --json number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt` in the project folder. It runs when a project is first shown, when the branch changes, when a push lands (`upstream.ahead` falls), on window focus at most once a minute (the host's `status()` call), every minute while checks are pending, and otherwise every 5 minutes while the project is shown. A branch with no pull request (gh exits 1 with "no pull requests found") is a known answer, `null`. A detached or unborn head has no pull request and is not looked up. When the branch changes, the previous branch's pull request is announced as `null` at once, so it does not show on the new branch while gh answers.
- **Session branches**: one `gh pr list --state all --limit 50 --json number,title,state,isDraft,url,headRefName` per shown project maps branches to pull requests for the sidebar, on the same schedule. Projects that are worktrees of one repository each ask separately. When several pull requests share a head branch, an open one wins, then the newest.
- Nothing is looked up for a project without a `github.com` remote, and gh commands never write: only `pr view`, `pr list`, `auth status` and `--version` run.
- **Links in the thread**: a pull request URL in agent text or tool output (`https://github.com/<owner>/<repo>/pull/<n>`) becomes a chip. Its details load with `gh pr view <url> --json …` when the chip first scrolls into view, cached for a minute.

```ts
interface PullRequest {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  head: string
  base: string
  checks: {
    state: 'none' | 'pending' | 'passing' | 'failing'
    passed: number
    failed: number
    pending: number
  }
  review: 'approved' | 'changes_requested' | 'review_required' | null
  mergeable: 'clean' | 'conflicting' | 'blocked' | 'unknown'
  updatedAt: number
}
```

- `checks` sums `statusCheckRollup`: any failure is `failing`, else any pending run is `pending`, else `passing`; no checks at all is `none`. Entries are either check runs (`status` and `conclusion`) or status contexts (`state`). A check run counts as passed with the conclusion `SUCCESS`, `NEUTRAL` or `SKIPPED`, as pending until its status is `COMPLETED`, and as failed with any other conclusion (`FAILURE`, `TIMED_OUT`, `CANCELLED`, `STARTUP_FAILURE`, `ACTION_REQUIRED`, `STALE`). A status context counts as passed with `SUCCESS`, failed with `FAILURE` or `ERROR`, and pending otherwise.
- `state` is `draft` for an open draft; `MERGED` and `CLOSED` win over the draft flag. `review` maps `APPROVED`, `CHANGES_REQUESTED` and `REVIEW_REQUIRED`; an empty decision is `null`. `mergeable` maps `mergeStateStatus`: `CLEAN`, `HAS_HOOKS` and `UNSTABLE` (mergeable, with checks that are not required failing) are `clean`, `DIRTY` is `conflicting`, `BLOCKED`, `BEHIND` and `DRAFT` are `blocked`, anything else is `unknown`.
- The details for a chip are cached for a minute per URL, and simultaneous requests share one lookup. The URL must match the GitHub pull request pattern before anything runs.
- GitHub API rate limits are far above this schedule (one or two calls per shown repository per minute at most). A `gh` failure keeps the last value and marks it stale.

## Sessions and branches

Sessions in a project share its working tree, so the branch belongs to the project, not the session. A session remembers the branch it worked on, which links it to that branch's pull request.

- When a turn ends, the session's `branch` is set to the branch checked out at that moment and saved in the [index](./persistence.md#what-is-stored-and-where).
- A session's pull request is the one whose head is its `branch`. It shows as a badge on its sidebar row, as in the reference, where the session list carries `branch`, `prNumber` and `prState`.

## Git events in the thread

When the repository changes while a session's tool call runs, the thread says so, so the commits and pushes an agent makes are visible where they happened, not only in the top bar.

| Event        | Detected when, comparing the status before and after the tool call                        | Entry                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Commit       | New commits on `HEAD`                                                                     | "Committed `3f2a1c1` fix(auth): read the clock once", one line per commit, at most 3 and then "and 2 more" |
| Push         | `upstream.ahead` falls, or the branch gains an upstream                                   | "Pushed 2 commits to origin/fix/flaky-login"                                                               |
| Branch       | `head.branch` changes                                                                     | "Switched to fix/flaky-login"                                                                              |
| Pull request | A pull request appears for the branch, or a pull request URL appears in the tool's output | "Opened pull request" with the chip                                                                        |

- The before status is the last one the service holds when the tool call starts; the after status is the refresh that follows the tool call's end, which is a run that starts after the end, never one already in flight. Parallel calls of one session share what is already reported, so a change appears once.
- A change is attributed only when exactly one session of the project had a tool call running in that interval. Otherwise the top bar still updates, and no session claims the change. A turn end forgets the session's unfinished calls, and a call older than 30 minutes stops counting, so an agent that crashed mid-call does not block attribution for good.
- **Commit**: the commits in `before.oid..after.oid` that were committed at or after the start of the tool call (committer time, whole seconds). That keeps commits a pull or a checkout brought in out of the list; an amended or rebased commit is new and is listed. The entry carries full object ids, newest first.
- **Push**: with the same upstream, the commits that were unpushed before or were made during the call, minus those still unpushed, so a commit pushed in the same call counts. When the branch gains an upstream, the count is the pushed commits in the list (it can be 0 for a branch published at its base). After a branch switch only commits made during the call that are already on the upstream count.
- **Branch**: from one branch to another. A detached head before or after is not reported, because a finished rebase looks the same.
- **Pull request**: the last pull request URL in the output of a tool of a kind that can change the repository, once per URL; or, after a push to a branch known to have no pull request, a pull request that `gh` then reports for it.
- These entries are OverBench's own observations, not part of the agent's history, so they are kept in the host's snapshot and not restored by `session/load` after a restart. Their entry ids are `g:<n>`.

## Host protocol

Requests and events on the agent host port ([host protocol](./host-protocol.md)):

| Method or event   | Params or payload                          | Result        | Notes                                                         |
| ----------------- | ------------------------------------------ | ------------- | ------------------------------------------------------------- |
| `git.status`      | `{ projectPath }`                          | `GitStatus`   | Also starts keeping the project live for this port            |
| `git.unwatch`     | `{ projectPath }`                          | none          |                                                               |
| `git.fetch`       | `{ projectPath }`                          | `GitStatus`   | `git fetch --prune`; fails with `git_error` and git's message |
| `git.pullRequest` | `{ url }`                                  | `PullRequest` | For chips; the URL must match the GitHub pull request pattern |
| `git.changed`     | `GitStatus`                                |               | Event, to ports keeping that project live                     |
| `git.pr`          | `{ projectPath, pr: PullRequest \| null }` |               | Event, the current branch's pull request                      |

`SessionSummary` gains `branch: string | null` and `pr: { number: number; state: PullRequest['state']; url: string } | null` for the sidebar.

## Alternatives considered

- **A git library (isomorphic-git, nodegit)**: either slow on large repositories or a native build; the `git` binary is what the agent itself uses, so its view matches. Rejected.
- **The GitHub REST API with a token**: OverBench would have to store a credential. `gh` already holds the user's sign-in. Rejected.
- **Polling `git status` on a timer**: wasteful on large repositories, and late. The git dir watcher plus session events react at once and cost nothing while idle.
