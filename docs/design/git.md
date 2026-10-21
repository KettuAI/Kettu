# Git and pull requests

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.4](../milestones/m0.md#work-packages) · Observed on 2026-10-20: `gh` 2.x

Almost every project an agent works on is a git repository, and what the agent leaves behind is commits, pushes and pull requests. OverBench shows that state wherever you look at a session: the branch and its sync state in the top bar, the full picture in a branch popover, commits and pushes as they happen in the thread, and pull requests as live chips. The interface is in [ui.md](./ui.md#git-in-the-top-bar).

M0 only reads. Committing, pushing and opening pull requests stay with the agent and the [terminal](./terminal.md); OverBench offers no staging area or commit form. The one write it performs is **Fetch**, which updates remote-tracking refs and nothing else.

## Where it runs

The git service lives in the agent host (`src/agent-host/git/`), next to the agents, because it needs the same resolved environment to find `git` and `gh`, and the session events that tell it when to look.

- Every git and `gh` call is an asynchronous child process in the project folder, with a 10 s timeout (60 s for **Fetch**). A repository has at most one status run in flight; requests that arrive meanwhile coalesce into one follow-up run.
- The environment adds `GIT_OPTIONAL_LOCKS=0`, so a status run never takes `index.lock` and never collides with a git command the agent is running, and `GIT_TERMINAL_PROMPT=0`, so a fetch that needs credentials fails instead of waiting for input. Both are what VS Code's git extension sets.
- Output is parsed from machine formats only: `--porcelain=v2 -z`, `--format` with NUL separators, and `gh --json`. Nothing depends on the user's locale or git config.
- `git` missing: the top bar shows nothing, and Settings › Git says so. `gh` missing or signed out: everything works except pull requests.

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
}

interface CommitSummary {
  oid: string
  subject: string
  authoredAt: number
  pushed: boolean // reachable from the upstream
}
```

One refresh runs these, in order, and skips what a previous answer makes pointless:

| Step | Command                                                                                                                     | Gives                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1    | `git status --porcelain=v2 --branch -z --untracked-files=normal`                                                            | `head`, `upstream` with ahead and behind, and the change counts       |
| 2    | `git diff --shortstat HEAD`, only when there are changes                                                                    | `insertions`, `deletions`                                             |
| 3    | `git rev-list --left-right --count <base>...HEAD`                                                                           | `base`                                                                |
| 4    | `git log -n 20 --format=%H%x00%s%x00%at <base>..HEAD` and `git rev-list <upstream>..HEAD`                                   | `commits`, and which of them are not pushed                           |
| 5    | `stat` on `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `FETCH_HEAD` in the git dir | `operation`, the rebase step from `msgnum` and `end`, `lastFetchedAt` |

- The **base** is the remote's default branch, from `git symbolic-ref refs/remotes/<remote>/HEAD`, cached per repository. Without it, `main` and then `master` are tried; with none, `base` is `null` and the commit list falls back to the upstream.
- The **remote** is the upstream's remote, else `origin`. A `github.com` URL, in HTTPS or SSH form, fills `github`; any other host leaves it `null`, and pull requests are not shown.
- `HEAD` on the base branch itself (working on `main`) has no base comparison; the popover then lists the commits not pushed.

### When it refreshes

Only projects shown in some window are kept live. A project that comes into view refreshes at once.

- **The git dir changes**: one recursive `fs.watch` on the git dir, debounced by 300 ms, ignoring `objects/`, `logs/` and `*.lock`. It catches commits, checkouts, pushes and fetches from the agent, the terminal or any other tool. Where a recursive watch is not available, the triggers below still keep the status current.
- **A tool call ends** in a session of the project, for the kinds that can change the repository (`edit`, `delete`, `move`, `execute`, `other`), and **a turn ends**.
- **The window gains focus**, at most once every 2 s.
- **Fetch in the background** (Settings › Git, off by default) runs `git fetch --prune` every 5 minutes for shown projects with a remote, so behind counts do not go stale.

## Pull requests

Pull requests come from the GitHub CLI, so OverBench never handles a GitHub token: `gh` keeps the user's own sign-in.

- At host start and on **Reload environment**, `gh auth status --hostname github.com` decides the state: `not-installed`, `signed-out` or `ready`.
- **The current branch**: `gh pr view --json number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt` in the project folder. It runs when the branch changes, when a push lands (`upstream.ahead` falls), on window focus at most once a minute, every minute while checks are pending, and otherwise every 5 minutes while the project is shown.
- **Session branches**: one `gh pr list --state all --limit 50 --json number,title,state,isDraft,url,headRefName` per repository maps branches to pull requests for the sidebar, on the same schedule.
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

- `checks` sums `statusCheckRollup`: any failure is `failing`, else any pending run is `pending`, else `passing`; no checks at all is `none`.
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

- The before status is the last one the service holds when the tool call starts; the after status is the refresh that follows the tool call's end.
- A change is attributed only when exactly one session of the project had a tool call running in that interval. Otherwise the top bar still updates, and no session claims the change.
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
