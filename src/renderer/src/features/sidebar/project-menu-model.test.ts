import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
})

import {
  hostSupportsWorktreeSettings,
  isNoProjectMenuItemDisabled,
  isProjectMenuItemDisabled,
  noProjectMenuGroups,
  projectMenuGroups,
  WORKTREE_SETTINGS_SINCE,
  type ProjectMenuContext,
  type ProjectMenuItem,
} from './project-menu-model'

const BASE_CONTEXT: ProjectMenuContext = {
  revealable: true,
  terminal: true,
  git: true,
  worktreeSettings: true,
  canPin: true,
  canArchive: true,
  gone: false,
  away: false,
}

describe('hostSupportsWorktreeSettings', () => {
  it('treats local desktop, unknown, dev, and non-semver host versions as supported', () => {
    expect(hostSupportsWorktreeSettings(null)).toBe(true)
    expect(hostSupportsWorktreeSettings(undefined)).toBe(true)
    expect(hostSupportsWorktreeSettings('0.0.0')).toBe(true)
    expect(hostSupportsWorktreeSettings('0.0.0-test')).toBe(true)
    expect(hostSupportsWorktreeSettings('dev')).toBe(true)
  })

  it('rejects hosts older than WORKTREE_SETTINGS_SINCE and allows versions from it onward', () => {
    expect(hostSupportsWorktreeSettings('0.0.10')).toBe(false)
    expect(hostSupportsWorktreeSettings('0.0.37')).toBe(false)
    expect(hostSupportsWorktreeSettings(`${WORKTREE_SETTINGS_SINCE}-rc.1`)).toBe(false)
    expect(hostSupportsWorktreeSettings(WORKTREE_SETTINGS_SINCE)).toBe(true)
    expect(hostSupportsWorktreeSettings('0.0.39')).toBe(true)
    expect(hostSupportsWorktreeSettings('0.1.25')).toBe(true)
    expect(hostSupportsWorktreeSettings('1.0.0')).toBe(true)
  })
})

describe('projectMenuGroups', () => {
  it('returns the full local project menu in five groups', () => {
    expect(projectMenuGroups(BASE_CONTEXT)).toEqual([
      ['newSession', 'edit', 'pin'],
      ['importSessions', 'openInTerminal', 'showInFileManager'],
      ['worktreeSettings'],
      ['showArchived'],
      ['archive', 'remove'],
    ])
  })

  it('includes remote-capable actions while keeping showInFileManager local-only', () => {
    expect(projectMenuGroups({ ...BASE_CONTEXT, revealable: false })).toEqual([
      ['newSession', 'edit', 'pin'],
      ['importSessions', 'openInTerminal'],
      ['worktreeSettings'],
      ['showArchived'],
      ['archive', 'remove'],
    ])
  })

  it('omits openInTerminal when terminal access is disallowed on a remote host', () => {
    expect(projectMenuGroups({ ...BASE_CONTEXT, revealable: false, terminal: false })).toEqual([
      ['newSession', 'edit', 'pin'],
      ['importSessions'],
      ['worktreeSettings'],
      ['showArchived'],
      ['archive', 'remove'],
    ])
  })

  it('omits worktreeSettings cleanly when the project is not a Git repository', () => {
    expect(projectMenuGroups({ ...BASE_CONTEXT, revealable: false, git: false })).toEqual([
      ['newSession', 'edit', 'pin'],
      ['importSessions', 'openInTerminal'],
      ['showArchived'],
      ['archive', 'remove'],
    ])
  })

  it('degrades gracefully for older remote hosts lacking worktree settings, pin, and archive', () => {
    expect(
      projectMenuGroups({
        ...BASE_CONTEXT,
        revealable: false,
        worktreeSettings: false,
        canPin: false,
        canArchive: false,
      }),
    ).toEqual([
      ['newSession', 'edit'],
      ['importSessions', 'openInTerminal'],
      ['showArchived'],
      ['remove'],
    ])
  })
})

describe('isProjectMenuItemDisabled', () => {
  const allItems: ProjectMenuItem[] = [
    'newSession',
    'edit',
    'pin',
    'importSessions',
    'openInTerminal',
    'showInFileManager',
    'worktreeSettings',
    'showArchived',
    'archive',
    'remove',
  ]

  it('enables every item when the folder exists and the host is online', () => {
    for (const item of allItems) {
      expect(isProjectMenuItemDisabled(item, { gone: false, away: false })).toBe(false)
    }
  })

  it('disables only folder-dependent items when a project folder is missing on an online host', () => {
    const disabled = allItems.filter((item) =>
      isProjectMenuItemDisabled(item, { gone: true, away: false }),
    )
    expect(disabled).toEqual([
      'newSession',
      'importSessions',
      'openInTerminal',
      'showInFileManager',
      'worktreeSettings',
    ])
  })

  it('disables every item when a remote host is away', () => {
    for (const item of allItems) {
      expect(isProjectMenuItemDisabled(item, { gone: false, away: true })).toBe(true)
    }
  })
})

describe('noProjectMenuGroups and disabled states', () => {
  it('shows newSession, pin, and showArchived for local No project', () => {
    expect(noProjectMenuGroups({ local: true, canPin: true, away: false })).toEqual([
      ['newSession', 'pin'],
      ['showArchived'],
    ])
  })

  it('shows pin and showArchived for remote No project when pinning is supported', () => {
    expect(noProjectMenuGroups({ local: false, canPin: true, away: false })).toEqual([
      ['pin'],
      ['showArchived'],
    ])
  })

  it('shows only showArchived with no empty groups for older remote hosts without No project pin', () => {
    expect(noProjectMenuGroups({ local: false, canPin: false, away: false })).toEqual([
      ['showArchived'],
    ])
  })

  it('disables pin and showArchived while the remote host is away', () => {
    expect(isNoProjectMenuItemDisabled('newSession', { away: true })).toBe(false)
    expect(isNoProjectMenuItemDisabled('pin', { away: true })).toBe(true)
    expect(isNoProjectMenuItemDisabled('showArchived', { away: true })).toBe(true)
    expect(isNoProjectMenuItemDisabled('pin', { away: false })).toBe(false)
    expect(isNoProjectMenuItemDisabled('showArchived', { away: false })).toBe(false)
  })
})
