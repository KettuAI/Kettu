import { describe, expect, it } from 'vitest'
import type { PermissionScope } from '@shared/routines'
import { leavesWorktree, scopeAnswer, withinScope } from './scope'

const allow = [
  { id: 'once', kind: 'allow_once' as const },
  { id: 'always', kind: 'allow_always' as const },
  { id: 'no', kind: 'reject_once' as const },
]
const commands: PermissionScope = { level: 'commands', web: false }
const read: PermissionScope = { level: 'read', web: false }
const worktree = '/repo-worktrees/feat-1'

describe('withinScope relative to a worktree', () => {
  it('allows edits inside the worktree and refuses the project beside it', () => {
    const edit = (path: string) =>
      withinScope(commands, worktree, { toolKind: 'edit', locations: [path] }, 'darwin')
    expect(edit('/repo-worktrees/feat-1/src/a.ts')).toBe(true)
    expect(edit('src/a.ts')).toBe(true)
    expect(edit('/repo/src/a.ts')).toBe(false)
    expect(edit('../feat-1-other/a.ts')).toBe(false)
    expect(edit('/repo-worktrees/feat-10/a.ts')).toBe(false)
    expect(edit('/repo-worktrees/feat-1/.git/config')).toBe(false)
  })

  it('keeps a read-only stage to reads', () => {
    expect(
      withinScope(read, worktree, { toolKind: 'read', locations: ['src/a.ts'] }, 'darwin'),
    ).toBe(true)
    expect(
      withinScope(read, worktree, { toolKind: 'edit', locations: ['src/a.ts'] }, 'darwin'),
    ).toBe(false)
    expect(withinScope(read, worktree, { toolKind: 'execute', locations: [] }, 'darwin')).toBe(
      false,
    )
  })

  it('answers only with allow once', () => {
    expect(
      scopeAnswer(
        commands,
        worktree,
        { toolKind: 'execute', locations: [], options: allow },
        'darwin',
      ),
    ).toBe('once')
    expect(
      scopeAnswer(
        commands,
        worktree,
        { toolKind: 'execute', locations: [], options: allow.slice(1) },
        'darwin',
      ),
    ).toBeNull()
  })

  it('compares Windows paths without case', () => {
    expect(
      withinScope(
        commands,
        'C:\\work\\feat-1',
        { toolKind: 'edit', locations: ['c:\\Work\\FEAT-1\\a.ts'] },
        'win32',
      ),
    ).toBe(true)
  })
})

describe('leavesWorktree', () => {
  it('finds pushes and pull requests however they are written', () => {
    for (const command of [
      'git push',
      'git push --force origin feat',
      'git -C /tmp/x push',
      '/usr/bin/git push -u origin HEAD',
      'npm test && git push',
      'GIT_TRACE=1 git push',
      'env FOO=1 git push',
      'sudo -u me git push',
      "bash -lc 'git push origin feat'",
      'sh -c "git commit -m x && git push"',
      'eval git push',
      'gh pr create --fill',
      'gh -R a/b pr merge 3 --squash',
      'gh pr ready 3',
      'gh release create v1',
      'git push $(echo origin)',
      'x=`git push`',
    ]) {
      expect(leavesWorktree(command), command).toBe(true)
    }
  })

  it('finds commands that move refs every worktree shares', () => {
    for (const command of [
      'git update-ref refs/heads/main HEAD',
      'git symbolic-ref HEAD refs/heads/main',
      'git replace abc def',
      'git branch -f main HEAD',
      'git branch -D main',
      'git branch -M feat main',
      'git branch --force main',
      'git tag v1',
      'git tag -f v1',
      'git checkout -B main',
      'git switch -C main origin/main',
      'git fetch . HEAD:main',
      'git fetch origin feat:main',
      'git push . HEAD:main',
    ]) {
      expect(leavesWorktree(command), command).toBe(true)
    }
  })

  it('leaves commands that stay in the worktree alone', () => {
    for (const command of [
      'git status',
      'git commit -m "push the button"',
      'grep -r "git push" docs',
      'gh pr view 3',
      'gh pr list',
      'pnpm test',
      'git log --oneline',
      'echo push',
      'git branch',
      'git branch -a',
      'git branch --list',
      'git branch new-topic',
      'git tag',
      'git tag -l "v*"',
      'git fetch origin',
      'git fetch --prune',
      'git checkout src/a.ts',
      'git switch -c topic',
      'git reset --hard HEAD~1',
    ]) {
      expect(leavesWorktree(command), command).toBe(false)
    }
  })
})
