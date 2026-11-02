import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import {
  canDeleteAtOnce,
  matchesShortcut,
  multiSessionMenuGroups,
  resumeCommand,
  sessionMenuGroups,
  settle,
  type SessionMenuContext,
} from './session-menu-model'

const summary = (extra: Partial<SessionSummary> = {}) =>
  ({
    status: 'ready',
    parentId: null,
    origin: 'user',
    pr: null,
    attention: 'none',
    pinnedAt: null,
    ...extra,
  }) as SessionSummary
const pr = { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' } as const
// A session on this computer whose agent can fork it and whose harness resumes it.
const here = (extra: Partial<SessionMenuContext> = {}): SessionMenuContext => ({
  canFork: true,
  local: true,
  terminal: true,
  resume: true,
  ...extra,
})

describe('sessionMenuGroups', () => {
  it('gives an idle top-level session every group but the state one, in the drawn order', () => {
    expect(sessionMenuGroups(summary(), here())).toEqual([
      ['pin', 'unread', 'rename'],
      ['fork', 'newSubSession'],
      ['openInSplit', 'copyResume', 'showInFolder'],
      ['archive', 'delete'],
    ])
  })

  it('leads with Stop while it runs or waits, and Retry while it failed or needs sign-in', () => {
    expect(sessionMenuGroups(summary({ status: 'running' }), here())[0]).toEqual(['stop'])
    expect(sessionMenuGroups(summary({ status: 'awaiting_permission' }), here())[0]).toEqual([
      'stop',
    ])
    expect(sessionMenuGroups(summary({ status: 'failed' }), here())[0]).toEqual(['retry'])
    expect(sessionMenuGroups(summary({ status: 'auth_required' }), here())[0]).toEqual(['retry'])
  })

  it('offers the pull request when the branch has one, and Fork only when the agent can', () => {
    const groups = sessionMenuGroups(summary({ pr }), here({ canFork: false }))
    expect(groups).toContainEqual(['openInSplit', 'pullRequest', 'copyResume', 'showInFolder'])
    expect(groups).toContainEqual(['newSubSession'])
  })

  it('leaves Pin, Fork and Archive out for a sub-session', () => {
    expect(sessionMenuGroups(summary({ parentId: 'p' }), here())).toEqual([
      ['unread', 'rename'],
      ['newSubSession'],
      ['openInSplit', 'copyResume', 'showInFolder'],
      ['delete'],
    ])
  })

  it('gives a subagent only opening, stopping and finding it in its parent', () => {
    const subagent = summary({ parentId: 'p', origin: 'subagent' })
    expect(sessionMenuGroups(subagent, here())).toEqual([['open'], ['showInParent']])
    expect(sessionMenuGroups({ ...subagent, status: 'running' }, here())).toEqual([
      ['open', 'stop'],
      ['showInParent'],
    ])
  })

  it('leaves Open in split view out for a session a pane shows already', () => {
    for (const state of [summary(), summary({ parentId: 'p' })]) {
      expect(sessionMenuGroups(state, here({ shown: true })).flat()).not.toContain('openInSplit')
    }
  })

  it('gives the More menu its own groups', () => {
    expect(sessionMenuGroups(summary(), here({ shown: true, place: 'more' }))).toEqual([
      ['rename', 'pin', 'fork'],
      ['openInEditor', 'showInFolder', 'openTerminal'],
      ['copyResume', 'copySessionId'],
      ['archive', 'delete'],
    ])
    expect(
      sessionMenuGroups(
        summary({ status: 'running', parentId: 'p' }),
        here({ shown: true, place: 'more' }),
      ),
    ).toEqual([
      ['stop'],
      ['rename'],
      ['openInEditor', 'showInFolder', 'openTerminal'],
      ['copyResume', 'copySessionId'],
      ['delete'],
    ])
  })

  it('leaves out what the session cannot do where the menu opens, and the groups that empties', () => {
    // Another host's opencode session: no folder here, no terminal, no resume command.
    const away = here({ shown: true, local: false, terminal: false, resume: false })
    expect(sessionMenuGroups(summary(), { ...away, place: 'more' })).toEqual([
      ['rename', 'pin', 'fork'],
      ['copySessionId'],
      ['archive', 'delete'],
    ])
    expect(sessionMenuGroups(summary(), away)).toEqual([
      ['pin', 'unread', 'rename'],
      ['fork', 'newSubSession'],
      ['archive', 'delete'],
    ])
    expect(sessionMenuGroups(summary(), here({ terminal: false, place: 'more' }))).toContainEqual([
      'openInEditor',
      'showInFolder',
    ])
  })
})

describe('multiSessionMenuGroups', () => {
  it('offers only what applies to every session', () => {
    const unread = summary({ attention: 'unread' })
    expect(multiSessionMenuGroups([unread, unread, unread])).toEqual([
      ['read', 'pin'],
      ['archive', 'delete'],
    ])
    // One read, one unread: neither applies to both.
    expect(multiSessionMenuGroups([unread, summary()])).toEqual([['pin'], ['archive', 'delete']])
    expect(multiSessionMenuGroups([summary({ pinnedAt: 1 }), summary({ pinnedAt: 2 })])).toEqual([
      ['unread', 'unpin'],
      ['archive', 'delete'],
    ])
  })

  it('stops them all only when all run, and deletes none while one runs', () => {
    const running = summary({ status: 'running' })
    expect(multiSessionMenuGroups([running, running])).toEqual([
      ['stop'],
      ['unread', 'pin'],
      ['archive'],
    ])
    expect(multiSessionMenuGroups([running, summary()]).flat()).not.toContain('delete')
  })

  it('leaves Pin and Archive out when a sub-session is among them', () => {
    expect(multiSessionMenuGroups([summary(), summary({ parentId: 'p' })])).toEqual([
      ['unread'],
      ['delete'],
    ])
  })

  it('does not mark unread a session a pane shows', () => {
    expect(multiSessionMenuGroups([summary(), summary()], (index) => index === 1)).toEqual([
      ['pin'],
      ['archive', 'delete'],
    ])
  })
})

describe('settle', () => {
  it('keeps the ids that went through and the errors of the rest', async () => {
    const failure = new Error('no')
    const run = (id: string) => (id === 'b' ? Promise.reject(failure) : Promise.resolve())
    await expect(settle(['a', 'b', 'c'], run)).resolves.toEqual({
      done: ['a', 'c'],
      errors: [failure],
    })
  })
})

describe('canDeleteAtOnce', () => {
  it('deletes at once only with no sub-session and no uncommitted file', () => {
    expect(canDeleteAtOnce([0, 0], false)).toBe(true)
    expect(canDeleteAtOnce([0, 2], false)).toBe(false)
    expect(canDeleteAtOnce([0], true)).toBe(false)
  })

  it('asks first when a folder could not be read', () => {
    expect(canDeleteAtOnce([0, null], false)).toBe(false)
  })
})

describe('resumeCommand', () => {
  const session = (agentId: string, acpSessionId: string | null = 'abc-123') =>
    ({ agentId, acpSessionId }) as SessionSummary

  it("resumes in the harness's CLI from the session's folder", () => {
    expect(resumeCommand(session('claude-code'), '/Users/me/my repo')).toBe(
      "cd '/Users/me/my repo' && claude --resume abc-123",
    )
    expect(resumeCommand(session('codex'), '/srv/app')).toBe('cd /srv/app && codex resume abc-123')
  })

  it('quotes for cmd when the folder is a Windows one', () => {
    expect(resumeCommand(session('codex', 'abc'), 'C:\\Users\\me\\my repo')).toBe(
      'pushd "C:\\Users\\me\\my repo" && codex resume abc',
    )
  })

  // cmd's cd stays on the shell's drive and takes no network path; pushd does both.
  it('changes drive, and reaches a network folder, on Windows', () => {
    expect(resumeCommand(session('codex', 'abc'), 'D:\\work')).toBe(
      'pushd D:\\work && codex resume abc',
    )
    expect(resumeCommand(session('codex', 'abc'), '\\\\server\\share\\app')).toBe(
      'pushd \\\\server\\share\\app && codex resume abc',
    )
  })

  it('has none without an id, for an added agent or another harness', () => {
    expect(resumeCommand(session('claude-code', null), '/a')).toBeNull()
    expect(resumeCommand(session('claude-code~work'), '/a')).toBeNull()
    expect(resumeCommand(session('opencode'), '/a')).toBeNull()
  })
})

describe('matchesShortcut', () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({
      key: '',
      code: '',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    }) as KeyboardEvent

  it('matches a lone letter only without modifiers', () => {
    expect(matchesShortcut(key({ key: 'p', code: 'KeyP' }), 'P', true)).toBe(true)
    expect(matchesShortcut(key({ key: 'p', code: 'KeyP', metaKey: true }), 'P', true)).toBe(false)
  })

  it('reads Mod as Cmd on macOS and Ctrl elsewhere', () => {
    expect(matchesShortcut(key({ key: '.', code: 'Period', metaKey: true }), 'Mod+.', true)).toBe(
      true,
    )
    expect(matchesShortcut(key({ key: '.', code: 'Period', ctrlKey: true }), 'Mod+.', false)).toBe(
      true,
    )
    expect(matchesShortcut(key({ key: '.', code: 'Period', ctrlKey: true }), 'Mod+.', true)).toBe(
      false,
    )
  })

  it("reads a letter as the layout types it, not by the key's place", () => {
    // AZERTY's A sits where QWERTY's Q does, and Dvorak's L where QWERTY's P does.
    expect(matchesShortcut(key({ key: 'q', code: 'KeyA' }), 'A', true)).toBe(false)
    expect(matchesShortcut(key({ key: 'a', code: 'KeyQ' }), 'A', true)).toBe(true)
    expect(matchesShortcut(key({ key: 'l', code: 'KeyP' }), 'P', true)).toBe(false)
  })

  it('takes the physical key where the layout types no Latin letter', () => {
    expect(matchesShortcut(key({ key: 'з', code: 'KeyP' }), 'P', true)).toBe(true)
  })

  it('reads the layout letter with Alt held where Alt leaves it, as on Windows', () => {
    // Dvorak's R sits where QWERTY's O does.
    const event = key({ key: 'r', code: 'KeyO', altKey: true, ctrlKey: true })
    expect(matchesShortcut(event, 'Alt+Mod+R', false)).toBe(true)
  })

  it('takes the physical key when Alt changes the character', () => {
    const event = key({ key: '®', code: 'KeyR', altKey: true, metaKey: true })
    expect(matchesShortcut(event, 'Alt+Mod+R', true)).toBe(true)
  })

  it('tells Backspace from Mod+Backspace', () => {
    expect(matchesShortcut(key({ key: 'Backspace' }), 'Backspace', true)).toBe(true)
    expect(matchesShortcut(key({ key: 'Backspace', metaKey: true }), 'Backspace', true)).toBe(false)
    expect(matchesShortcut(key({ key: 'Backspace', metaKey: true }), 'Mod+Backspace', true)).toBe(
      true,
    )
  })

  it('reads Ctrl+` on macOS as the Control key', () => {
    const event = key({ key: '`', code: 'Backquote', ctrlKey: true })
    expect(matchesShortcut(event, 'Ctrl+`', true)).toBe(true)
  })
})
