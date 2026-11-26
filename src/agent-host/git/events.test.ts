import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GitStatus } from '@shared/git'
import type { GitEventDraft } from './api'
import {
  canOpenPullRequest,
  commandCreatesPullRequest,
  computeGitEvents,
  extractPullRequestUrl,
  isPullRequestCreationToolTitle,
  type ToolCallContext,
} from './events'
import { createGitService } from './service'

const PR_URL = 'https://github.com/KettuAI/Kettu/pull/2730'

function repoStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: '/repo',
    repo: { root: '/repo', gitDir: '/repo/.git' },
    head: { oid: 'aaaaaaa', branch: 'fix/2730', detached: false },
    defaultBranch: 'main',
    upstream: { name: 'origin/fix/2730', ahead: 0, behind: 0 },
    base: { name: 'origin/main', ahead: 1, behind: 0 },
    push: null,
    remote: {
      name: 'origin',
      url: 'https://github.com/KettuAI/Kettu.git',
      github: { owner: 'KettuAI', repo: 'Kettu' },
    },
    changes: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      insertions: 0,
      deletions: 0,
    },
    commits: [],
    operation: null,
    lastFetchedAt: null,
    stale: false,
    updatedAt: 1,
    ...overrides,
  }
}

function executeTool(
  command: string,
  status: ToolCallContext['status'] = 'completed',
  title?: string,
): ToolCallContext {
  return {
    toolKind: 'execute',
    status,
    title: title ?? command,
    rawInput: command,
  }
}

describe('commandCreatesPullRequest', () => {
  it.each([
    'gh pr create',
    'gh pr create --fill',
    'gh pr create --title "fix(git): narrow PR event" --body "Closes #2730"',
    'gh pr create -R KettuAI/Kettu --base main --head fix/2730 --fill',
    'gh pr -R KettuAI/Kettu create --fill',
    'gh pr --repo=KettuAI/Kettu create --fill',
    'gh -R KettuAI/Kettu pr create --fill',
    'gh pr new --title "alias test"',
    'GH_HOST=github.com gh pr create --fill',
    'cd /repo && GH_HOST=github.com gh pr create --title "fix"',
    'git push -u origin HEAD && gh pr create --fill',
    'git push -u origin HEAD && gh pr create --fill | tee /tmp/pr.url',
    'cd /repo; gh pr create --fill',
    '(cd /repo && gh pr create --fill)',
    '{ cd /repo && gh pr create --fill; }',
    'url=$(gh pr create --fill) && echo "$url"',
    'url=`gh pr create --fill` && echo "$url"',
    'if git push; then gh pr create --fill; fi',
    'env GH_HOST=github.com gh pr create --fill',
    'env -u GITHUB_TOKEN GH_HOST=github.com timeout 30 gh pr create --fill',
    'command gh pr create --fill',
    'time gh pr create --fill',
    'nice -n 5 gh pr create --fill',
    'nohup gh pr create --fill',
    '/opt/homebrew/bin/gh pr create --fill',
    'C:\\tools\\gh.exe pr create --fill',
    '"C:\\Program Files\\GitHub CLI\\gh.exe" pr create --fill',
    '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr create --fill',
    '& gh pr create --fill',
    'bash -c \'cd /repo && gh pr create --title "fix"\'',
    'zsh -lc "gh pr create --fill"',
    'pwsh -Command "gh pr create --fill"',
    'gh pr create \\\n  --title "multiline" \\\n  --body "details"',
    'gh pr create --title "Fix -h flag" --body "Document --help, --web, and --dry-run"',
    'gh pr create --title --help --body -w',
    'gh pr create -b -h -t -w',
    'gh pr create --dry-run=false --web=false --fill',
    `gh pr create --title "fix(git): check heredoc" --body "$(cat <<'EOF'\nDon't emit on gh pr view (see #2730)\nEOF\n)"`,
    `gh pr create --title "fix" --body-file - <<'EOF'\nSummary\nEOF`,
  ])('matches PR creation shell command: %s', (command) => {
    expect(commandCreatesPullRequest(command)).toBe(true)
  })

  it.each([
    '',
    '   ',
    'gh pr view 2730',
    'gh pr view https://github.com/KettuAI/Kettu/pull/2730',
    'gh pr list',
    'gh pr list --state open --json url',
    'gh pr status',
    'gh pr checks 2730',
    'gh pr diff 2730',
    'gh pr comment 2730 --body "Use gh pr create next time"',
    'gh pr edit 2730 --title "Updated title"',
    'gh pr merge 2730 --squash --delete-branch',
    'gh pr close 2730',
    'gh pr reopen 2730',
    'gh pr ready 2730',
    'gh pr review 2730 --approve',
    'gh pr checkout 2730',
    'gh pr create --help',
    'gh pr create -h',
    'gh pr create --title "x" --help',
    'gh pr create --dry-run',
    'gh pr create --dry-run=true --fill',
    'gh pr create --web',
    'gh pr create -w',
    'gh pr create -dw',
    'gh pr create -fh',
    'gh pr --help create',
    'gh --help pr create',
    'gh --version',
    'gh help pr create',
    'gh issue view 2730',
    'gh issue create --title "gh pr create false positive"',
    'gh api repos/KettuAI/Kettu/pulls',
    'git log -n 5',
    'git push -u origin HEAD',
    'cat README.md',
    'curl -s https://api.github.com/repos/KettuAI/Kettu/pulls/2730',
    'echo "gh pr create --fill"',
    'rg "gh pr create" src/',
    'command -v gh pr create',
    '# gh pr create --fill\ngh pr view 2730',
    `cat <<'EOF'\ngh pr create --fill\nEOF\ngh pr view 2730`,
    `gh pr comment 2730 --body "$(cat <<'EOF'\nRun \`gh pr create\` instead.\nEOF\n)"`,
  ])('rejects non-PR-creation shell command: %s', (command) => {
    expect(commandCreatesPullRequest(command)).toBe(false)
  })
})

describe('isPullRequestCreationToolTitle', () => {
  it.each([
    'create_pull_request',
    'createPullRequest',
    'mcp__github__create_pull_request',
    'mcp__github_enterprise__create_pull_request',
    'mcp_github_create_pull_request',
    'Run mcp_github_create_pull_request',
    'github_create_pull_request',
    'github: create_pull_request',
    'github：create_pull_request',
    'github/create_pull_request',
    'github.create_pull_request',
    'github.get_issue, github.create_pull_request',
  ])('matches PR creation MCP tool title: %s', (title) => {
    expect(isPullRequestCreationToolTitle(title)).toBe(true)
  })

  it.each([
    '',
    'mcp__github__get_pull_request',
    'mcp__github__list_pull_requests',
    'mcp__github__update_pull_request',
    'mcp__github__merge_pull_request',
    'mcp__github__create_pull_request_review',
    'mcp__github__create_pull_request_comment',
    'Run mcp_github_get_pull_request',
    'github: get_pull_request',
    'github：list_pull_requests',
    './create_pull_request',
    'Should we call create_pull_request',
  ])('rejects non-PR-creation MCP tool title: %s', (title) => {
    expect(isPullRequestCreationToolTitle(title)).toBe(false)
  })
})

describe('extractPullRequestUrl', () => {
  it('extracts the last PR URL from command output and ignores /pull/new/ push hints', () => {
    expect(
      extractPullRequestUrl(
        'remote: Create a pull request for fix/2730 by visiting:\nremote:   https://github.com/KettuAI/Kettu/pull/new/fix/2730\n',
      ),
    ).toBeNull()
    expect(extractPullRequestUrl(`\`\`\`console\n${PR_URL}\n\`\`\``)).toBe(PR_URL)
  })

  it('prefers top-level JSON html_url for structured MCP responses over URLs in the PR body', () => {
    const payload = JSON.stringify({
      url: 'https://api.github.com/repos/KettuAI/Kettu/pulls/2731',
      html_url: 'https://github.com/KettuAI/Kettu/pull/2731',
      body: 'Follow-up to https://github.com/KettuAI/Kettu/pull/2730',
    })
    expect(extractPullRequestUrl(payload, true)).toBe('https://github.com/KettuAI/Kettu/pull/2731')
    expect(extractPullRequestUrl(`\`\`\`json\n${payload}\n\`\`\``, true)).toBe(
      'https://github.com/KettuAI/Kettu/pull/2731',
    )
  })
})

describe('computeGitEvents', () => {
  const before = repoStatus()
  const after = repoStatus()

  it('emits pull_request when `gh pr create` succeeds and prints a PR URL', () => {
    const events = computeGitEvents({
      before,
      after,
      newCommits: [],
      output: `\`\`\`console\n${PR_URL}\n\`\`\``,
      tool: executeTool('gh pr create --title "fix" --body "Closes #2730"'),
    })
    expect(events).toEqual([{ kind: 'git', event: 'pull_request', url: PR_URL }])
  })

  it('emits pull_request for chained commands with env vars and `gh pr create`', () => {
    const events = computeGitEvents({
      before,
      after,
      newCommits: [],
      output: PR_URL,
      tool: executeTool('cd dir && GH_HOST=github.com gh pr create --title "fix"'),
    })
    expect(events).toEqual([{ kind: 'git', event: 'pull_request', url: PR_URL }])
  })

  it('falls back to title for execute tools when rawInput is absent', () => {
    const events = computeGitEvents({
      before,
      after,
      newCommits: [],
      output: PR_URL,
      tool: { toolKind: 'execute', status: 'completed', title: 'gh pr create --fill' },
    })
    expect(events).toEqual([{ kind: 'git', event: 'pull_request', url: PR_URL }])
  })

  it.each([
    'gh pr view 2730',
    'gh pr list',
    'gh pr status',
    'gh pr checks 2730',
    'gh pr comment 2730 --body "looks good"',
    'gh pr edit 2730 --title "rename"',
    'gh pr merge 2730 --squash',
    'git log -n 5',
    'cat notes.md',
  ])('does not emit pull_request for `%s` even when output contains a PR URL', (command) => {
    const events = computeGitEvents({
      before,
      after,
      newCommits: [],
      output: `View this pull request on GitHub: ${PR_URL}\n`,
      tool: executeTool(command),
    })
    expect(events).toEqual([])
  })

  it('does not emit pull_request when `gh pr create` fails or runs with `--help`', () => {
    expect(
      computeGitEvents({
        before,
        after,
        newCommits: [],
        output: `a pull request for branch "fix/2730" into branch "main" already exists:\n${PR_URL}`,
        tool: executeTool('gh pr create --fill', 'failed'),
      }),
    ).toEqual([])

    expect(
      computeGitEvents({
        before,
        after,
        newCommits: [],
        output: PR_URL,
        tool: executeTool('gh pr create --fill', 'cancelled'),
      }),
    ).toEqual([])

    expect(
      computeGitEvents({
        before,
        after,
        newCommits: [],
        output: `Example: ${PR_URL}`,
        tool: executeTool('gh pr create --help', 'completed'),
      }),
    ).toEqual([])
  })

  it('emits pull_request for completed PR creation MCP tools and ignores read-only MCP tools', () => {
    expect(
      computeGitEvents({
        before,
        after,
        newCommits: [],
        output: JSON.stringify({ html_url: PR_URL }),
        tool: {
          toolKind: 'other',
          status: 'completed',
          title: 'mcp__github__create_pull_request',
        },
      }),
    ).toEqual([{ kind: 'git', event: 'pull_request', url: PR_URL }])

    expect(
      computeGitEvents({
        before,
        after,
        newCommits: [],
        output: JSON.stringify({ html_url: PR_URL }),
        tool: {
          toolKind: 'other',
          status: 'failed',
          title: 'mcp__github__create_pull_request',
        },
      }),
    ).toEqual([])

    for (const title of [
      'mcp__github__get_pull_request',
      'mcp__github__list_pull_requests',
      'Run mcp_github_get_pull_request',
      'github: list_pull_requests',
    ]) {
      expect(
        computeGitEvents({
          before,
          after,
          newCommits: [],
          output: JSON.stringify({ html_url: PR_URL }),
          tool: { toolKind: 'other', status: 'completed', title },
        }),
      ).toEqual([])
    }
  })

  it('does not emit pull_request for non-execute/other tools or when tool metadata is omitted', () => {
    expect(
      canOpenPullRequest({ toolKind: 'edit', status: 'completed', title: 'Write notes.md' }),
    ).toBe(false)
    expect(
      computeGitEvents({
        before,
        after,
        newCommits: [],
        output: PR_URL,
        tool: { toolKind: 'edit', status: 'completed', title: 'Write notes.md' },
      }),
    ).toEqual([])
    expect(
      computeGitEvents({
        before,
        after,
        newCommits: [],
        output: PR_URL,
      }),
    ).toEqual([])
  })

  it('still reports branch, commit, and push events when a command fails', () => {
    const events = computeGitEvents({
      before: repoStatus({
        head: { oid: '1111111', branch: 'main', detached: false },
        upstream: { name: 'origin/main', ahead: 0, behind: 0 },
      }),
      after: repoStatus({
        head: { oid: '2222222', branch: 'fix/2730', detached: false },
        upstream: { name: 'origin/fix/2730', ahead: 0, behind: 0 },
        commits: [{ oid: '2222222', subject: 'fix: bug', authoredAt: 1, pushed: true }],
      }),
      newCommits: [{ oid: '2222222', subject: 'fix: bug' }],
      output: PR_URL,
      tool: executeTool('git switch -c fix/2730 && git commit -m "fix" && gh pr create', 'failed'),
    })
    expect(events).toEqual([
      { kind: 'git', event: 'branch', branch: 'fix/2730' },
      { kind: 'git', event: 'commit', commits: [{ oid: '2222222', subject: 'fix: bug' }], more: 0 },
      { kind: 'git', event: 'push', upstream: 'origin/fix/2730', count: 1 },
    ])
  })
})

describe('GitService toolCallEnded pull_request attribution', () => {
  it('only emits pull_request session events for successful PR creation tool calls', async () => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-git-pr-events-')))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env, stdio: 'ignore' })
      await writeFile(path.join(dir, 'a.txt'), 'hello\n')
      execFileSync('git', ['add', '.'], { cwd: dir, env, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env, stdio: 'ignore' })

      const service = createGitService({ env, log: () => {} })
      const received: GitEventDraft[] = []
      service.onSessionEvents((_sessionId, events) => received.push(...events))
      await service.status(dir)

      // 1. Viewing a PR whose output includes a PR URL must not emit pull_request.
      service.toolCallStarted(dir, 's1', 'call-view')
      service.toolCallEnded(dir, 's1', 'call-view', {
        toolKind: 'execute',
        status: 'completed',
        title: 'gh pr view 2730',
        rawInput: 'gh pr view 2730',
        output: `View this PR on GitHub: ${PR_URL}`,
      })
      await service.status(dir)
      expect(received).toEqual([])

      // 2. A failed `gh pr create` printing an existing PR URL must not emit pull_request.
      service.toolCallStarted(dir, 's1', 'call-failed')
      service.toolCallEnded(dir, 's1', 'call-failed', {
        toolKind: 'execute',
        status: 'failed',
        title: 'gh pr create --fill',
        rawInput: 'gh pr create --fill',
        output: `a pull request already exists:\n${PR_URL}`,
      })
      await service.status(dir)
      expect(received).toEqual([])

      // 3. A successful `gh pr create` emits pull_request.
      service.toolCallStarted(dir, 's1', 'call-create')
      service.toolCallEnded(dir, 's1', 'call-create', {
        toolKind: 'execute',
        status: 'completed',
        title: 'gh pr create --title "fix"',
        rawInput: 'gh pr create --title "fix"',
        output: `${PR_URL}\n`,
      })
      await vi.waitFor(() => {
        expect(received).toEqual([{ kind: 'git', event: 'pull_request', url: PR_URL }])
      })
      await service.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
