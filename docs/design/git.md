# Git and pull requests

> Status: Draft · Part of the [architecture](../architecture.md) · Built in [M0.4](../milestones/m0.md#work-packages) · Observed on 2026-10-20: `gh` 2.x

Almost every project an agent works on is a git repository, and what the agent leaves behind is commits, pushes and pull requests. OverBench shows that state wherever you look at a session: the branch and its sync state in the top bar, the full picture in a branch popover, commits and pushes as they happen in the thread, and pull requests as live chips. The interface is in [ui.md](./ui.md#git-in-the-top-bar).

OverBench reads the repository and performs a few writes that move work between the machine and its remote: **Fetch**, **Pull** (fast-forward only), **Push** (never forced), publishing a branch or a whole repository, and creating a pull request ([operations](#operations)). Staging, committing, rebasing and merging stay with the agent and the [terminal](./terminal.md); OverBench offers no staging area or commit form. The writes were added on 2026-10-22 for [problem 13](../milestones/m0-feedback.md#13-the-git-popover-only-displays-and-repeats-the-terminal-toggle), decided while the maintainer was away; to be reviewed.

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
  defaultBranch: string | null // the base's branch name, such as "main", also when HEAD is on it
  push: PushTarget | null // null when HEAD is not on a branch with a commit
  lastFetchedAt: number | null
  updatedAt: number
  stale: boolean // the last refresh failed; the values are the previous ones
}

type PushTarget =
  | {
      kind: 'remote'
      remote: string
      github: { owner: string; repo: string } | null
      branch: string // the branch on the remote, without refs/heads/
      setUpstream: boolean // the branch has no upstream yet, so the push sets one
    }
  | { kind: 'noRemote' } // the repository has no remote at all
  | { kind: 'unknownRemote' } // several remotes and nothing says which one
  | { kind: 'localUpstream' } // the upstream is a branch of this repository
  | { kind: 'otherName'; upstream: string } // push.default refuses an upstream of another name

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
- The **remote** is the upstream's remote (`branch.<name>.remote`), else `origin`, else the only remote, read with one `git config --get-regexp` call for the remotes' URLs, the branches' `remote`, `merge` and `pushRemote`, `remote.pushDefault` and `push.default`. It reads the user's own config too, since `push.default` usually lives there, and is cached until the repository's config file or the user's (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, or `GIT_CONFIG_GLOBAL`) changes. A `github.com` URL, in HTTPS, `ssh://` or `git@github.com:owner/repo` form, fills `github`; any other host leaves it `null`, and pull requests are not shown. `url.<base>.insteadOf` rewrites are not applied.
- **`defaultBranch`** is the base's branch name without its remote (`origin/main` gives `main`), so the interface can tell when a push goes to the default branch.
- **`push`** is where Push sends the branch, by git's own rules, so the interface asks about and shows the push that happens. The remote is `branch.<name>.pushRemote`, then `remote.pushDefault`, then the upstream's remote, then `origin` or the only remote. When the upstream is on that remote, the branch goes to the upstream's branch if `push.default` is `upstream`, or to its own name if the names match or `push.default` is `current`; otherwise git would refuse (`simple`, the default), and so does OverBench: `otherName`. A first push, or one to another remote than the upstream's, goes to the branch's own name, and only a first push sets the upstream. An upstream remote of `.` is a branch of this repository: `localUpstream`. With no remote at all, `noRemote`; with several and none named, `unknownRemote`. `git for-each-ref`'s `%(push)` atoms were tried first; they leave the remote branch empty in these cases, so the rules are applied here.
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
    runs: CheckRun[] // each check, failing first, then pending, then passed, by name
  }
  review: 'approved' | 'changes_requested' | 'review_required' | null
  mergeable: 'clean' | 'conflicting' | 'blocked' | 'unknown'
  updatedAt: number
}
```

- `runs` keeps each entry of `statusCheckRollup` as `{ name, outcome: 'passed' | 'failed' | 'pending', url, startedAt, completedAt }`: the name is a check run's `name` (with its `workflowName` in front when there is one, as GitHub shows it) or a status context's `context`, the URL its `detailsUrl` or `targetUrl` when it is an `https://` link, the times in milliseconds or null.
- `checks` sums `statusCheckRollup`: any failure is `failing`, else any pending run is `pending`, else `passing`; no checks at all is `none`. Entries are either check runs (`status` and `conclusion`) or status contexts (`state`). A check run counts as passed with the conclusion `SUCCESS`, `NEUTRAL` or `SKIPPED`, as pending until its status is `COMPLETED`, and as failed with any other conclusion (`FAILURE`, `TIMED_OUT`, `CANCELLED`, `STARTUP_FAILURE`, `ACTION_REQUIRED`, `STALE`). A status context counts as passed with `SUCCESS`, failed with `FAILURE` or `ERROR`, and pending otherwise.
- `state` is `draft` for an open draft; `MERGED` and `CLOSED` win over the draft flag. `review` maps `APPROVED`, `CHANGES_REQUESTED` and `REVIEW_REQUIRED`; an empty decision is `null`. `mergeable` maps `mergeStateStatus`: `CLEAN`, `HAS_HOOKS` and `UNSTABLE` (mergeable, with checks that are not required failing) are `clean`, `DIRTY` is `conflicting`, `BLOCKED`, `BEHIND` and `DRAFT` are `blocked`, anything else is `unknown`.
- The details for a chip are cached for a minute per URL, and simultaneous requests share one lookup. The URL must match the GitHub pull request pattern before anything runs.
- GitHub API rate limits are far above this schedule (one or two calls per shown repository per minute at most). A `gh` failure keeps the last value and marks it stale.

## Details on demand

The popover asks for what the status does not carry when it needs it, and asks again while it is open when the status changes. Paths are relative to the repository root, as git prints them; reading a file of the working tree joins the path to `repo.root` and refuses one that leaves it.

| Request        | Command                                                                                                                                                      | Gives                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `git.commit`   | `git show -s --format=%H%x00%an%x00%ae%x00%at%x00%B <oid>`, with `git show -z -M --diff-merges=first-parent --name-status <oid>` and `--numstat` in parallel | The full message, author, date and changed files with their added and removed lines |
| `git.changes`  | `git status --porcelain=v2 -z --untracked-files=all` and `git diff --numstat -z HEAD`                                                                        | The working tree's changed files, at most 500                                       |
| `git.incoming` | `git log -n 20 --format=… HEAD..<upstream>` or `HEAD..<base>`                                                                                                | The commits to pull, or the base's commits since the branch started                 |
| `git.fileDiff` | `git cat-file -s` then `git cat-file blob <rev>:<path>` for each side; the working tree's side read from disk                                                | The two texts of one file's change, for the diff view                               |

- **`git.fileDiff`** compares `HEAD` with the working tree when `ref` is null, and a commit with its first parent otherwise; a file that is new on one side has `null` text there. A side over 1 MB, or with a NUL byte in its first 8 KB, is not sent: the result says `tooLarge` or `binary` instead.
- Against the working tree, `HEAD`'s side comes from `git cat-file --filters`, as a checkout writes it, so `core.autocrlf` on Windows does not make every line differ. `GIT_LFS_SKIP_SMUDGE=1` keeps an LFS file a pointer there rather than downloading it; such a file shows as changed.
- **The working tree's side** follows no link out of the repository: the folder holding the file is resolved with `realpath` and must lie inside the repository's real path, as for [project files](./agent-host.md#project-files); the file itself is read with `lstat` and opened with `O_NOFOLLOW`, and a symbolic link shows as its target's text, as git shows it.
- A commit id must be 4 to 64 hexadecimal characters; a path is checked as for [project files](./agent-host.md#project-files).

```ts
interface ChangedFile {
  path: string // relative to the repository root
  oldPath: string | null // the path before a rename or copy
  status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'typechange'
    | 'untracked'
    | 'conflicted'
  insertions: number | null // null for a binary file or an untracked one
  deletions: number | null
}

interface CommitDetails {
  oid: string
  subject: string
  body: string // the message after the subject line, trimmed
  authorName: string
  authorEmail: string
  authoredAt: number
  files: ChangedFile[]
}

interface FileDiff {
  path: string
  oldText: string | null
  newText: string | null
  binary: boolean
  tooLarge: boolean
}
```

## Operations

The writes OverBench performs, each from the popover. They run in the project folder like every other command, with the same environment, so `GIT_TERMINAL_PROMPT=0` makes a push that needs a password fail at once with git's message rather than wait. One operation runs per project at a time; a second request while one runs is refused with `busy`. Every operation ends with a status refresh, and its result carries git's output, which the interface keeps for **Show log**.

| Operation           | Command                                                                                                        | Timeout | When it is offered                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| Fetch               | `git fetch --prune`                                                                                            | 60 s    | A remote exists                                                      |
| Pull                | `git pull --ff-only --no-rebase`                                                                               | 60 s    | The upstream is ahead and the branch is not                          |
| Push                | `git push --porcelain <remote> refs/heads/<branch>:refs/heads/<target>`, from `push`                           | 60 s    | `push` is a remote; to the upstream, ahead and not behind            |
| Publish branch      | The same with `--set-upstream`, to the branch's own name                                                       | 60 s    | `push` is a remote and the branch has no upstream                    |
| Publish repository  | `gh repo create <name> --private` or `--public`, `--source <root> --remote origin --push`                      | 120 s   | The repository has no remote at all, `gh` ready                      |
| Create pull request | `gh pr create --repo <owner/repo> --head <branch or owner:branch> --base <base> --title --body`, `--draft` too | 60 s    | The branch is pushed to GitHub, is not the base, has no pull request |

- **Never forced, never merged by OverBench.** A branch that is both ahead and behind its upstream has diverged: pull and push are both refused, and the interface says to rebase or merge first, in the terminal or by asking the agent. `--ff-only` makes a pull that would need a merge fail instead.
- **Where a push goes** is the status's `push`, and the request names it: `git.push` carries the remote and branch the interface showed, and the service refuses when a fresh refresh gives another, so neither a config change nor a checkout in between sends it elsewhere. The branch is pushed by its ref, never `HEAD`.
- **The default branch.** The service performs a push to the default branch like any other; asking first, whenever `push.branch` is the default branch, is the interface's part ([branch popover](./ui.md#branch-popover)). Behind the upstream refuses a push only when the push goes to the upstream itself; a push to a fork goes ahead.
- **Publishing a repository** runs in `repo.root`, names the repository after the folder unless the user changes it, and is refused when a remote already exists. The name may hold letters, digits, `.`, `-` and `_`, at most 100 characters.
- **A pull request** is created on the status's remote's repository, named with `--repo`; its head is `push.branch`, as `owner:branch` when `push` is another repository, a fork. The title is required and at most 256 characters, the body at most 65,536. It runs under the project's lock like the other writes. On success the service polls gh at once, so the new pull request shows without waiting for the next poll; when `gh pr view` cannot find it yet, the result is what creating it told: number, title, branches and draft or open, with no checks.
- **A timeout** ends the command and what it started, such as the `git push` under `gh repo create --push`: `taskkill /T /F` on Windows, and elsewhere its descendants, listed from `ps` while it still runs, since they share the agent host's process group.
- **A failure** rejects with `git_error` and git's or gh's own output as the message (the last 64 KB), which the interface shows in its log. `gh` missing or signed out rejects with `git_error` before anything runs, saying which.

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

| Method or event         | Params or payload                           | Result            | Notes                                                         |
| ----------------------- | ------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| `git.status`            | `{ projectPath }`                           | `GitStatus`       | Also starts keeping the project live for this port            |
| `git.unwatch`           | `{ projectPath }`                           | none              |                                                               |
| `git.fetch`             | `{ projectPath }`                           | `GitOperation`    | `git fetch --prune`; fails with `git_error` and git's message |
| `git.pull`              | `{ projectPath }`                           | `GitOperation`    | [Operations](#operations)                                     |
| `git.push`              | `{ projectPath, remote, branch }`           | `GitOperation`    | To the status's `push`, which must still be `remote`/`branch` |
| `git.publish`           | `{ projectPath, name, visibility }`         | `GitOperation`    | `visibility` is `private` or `public`                         |
| `git.createPullRequest` | `{ projectPath, title, body, base, draft }` | `PullRequest`     |                                                               |
| `git.commit`            | `{ projectPath, oid }`                      | `CommitDetails`   | [Details on demand](#details-on-demand)                       |
| `git.changes`           | `{ projectPath }`                           | `ChangedFile[]`   |                                                               |
| `git.incoming`          | `{ projectPath, from }`                     | `CommitSummary[]` | `from` is `upstream` or `base`                                |
| `git.fileDiff`          | `{ projectPath, path, oldPath, ref }`       | `FileDiff`        | `ref` null: the working tree against `HEAD`                   |
| `git.pullRequest`       | `{ url }`                                   | `PullRequest`     | For chips; the URL must match the GitHub pull request pattern |
| `git.changed`           | `GitStatus`                                 |                   | Event, to ports keeping that project live                     |
| `git.pr`                | `{ projectPath, pr: PullRequest \| null }`  |                   | Event, the current branch's pull request                      |

`GitOperation` is `{ status: GitStatus; log: string }`, the status after the refresh and git's output. Every request but `git.pullRequest` acts only on a registered project or a scratch folder.

`SessionSummary` gains `branch: string | null` and `pr: { number: number; state: PullRequest['state']; url: string } | null` for the sidebar.

## Alternatives considered

- **A git library (isomorphic-git, nodegit)**: either slow on large repositories or a native build; the `git` binary is what the agent itself uses, so its view matches. Rejected.
- **The GitHub REST API with a token**: OverBench would have to store a credential. `gh` already holds the user's sign-in. Rejected.
- **Polling `git status` on a timer**: wasteful on large repositories, and late. The git dir watcher plus session events react at once and cost nothing while idle.
