// The routine scope's decision per permission request, on each platform's paths.

import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { PermissionScope } from '@shared/routines'
import type { PermissionKind, ToolKind } from '@shared/thread'
import { scopeAnswer, withinScope } from './scope'

const PROJECT = '/home/ana/project'
const WINDOWS_PROJECT = 'C:\\dev\\project'
const allowOnce = { id: 'allow-once', kind: 'allow_once' as PermissionKind }
const allowAlways = { id: 'allow-always', kind: 'allow_always' as PermissionKind }

function scope(level: PermissionScope['level'], web = false): PermissionScope {
  return { level, web }
}

function inside(
  toolKind: ToolKind,
  locations: string[],
  {
    level = 'read' as PermissionScope['level'],
    web = false,
    platform = 'darwin' as Platform,
    project = PROJECT,
  } = {},
): boolean {
  return withinScope(scope(level, web), project, { toolKind, locations }, platform)
}

describe('routine permission scope', () => {
  it('allows read, search and think at every level, inside the project', () => {
    for (const level of ['read', 'edit', 'commands'] as const) {
      for (const kind of ['read', 'search', 'think'] as const) {
        expect(inside(kind, [`${PROJECT}/src/a.ts`], { level })).toBe(true)
      }
    }
  })

  it('allows edits from Edit the project but not at Read only', () => {
    for (const kind of ['edit', 'delete', 'move'] as const) {
      for (const location of [`${PROJECT}/src/a.ts`, `${PROJECT}/a/b/c.ts`]) {
        expect(inside(kind, [location], { level: 'read' })).toBe(false)
        expect(inside(kind, [location], { level: 'edit' })).toBe(true)
        expect(inside(kind, [location], { level: 'commands' })).toBe(true)
      }
    }
  })

  it('allows commands only at Edit and run commands', () => {
    expect(inside('execute', [`${PROJECT}/src`], { level: 'read' })).toBe(false)
    expect(inside('execute', [`${PROJECT}/src`], { level: 'edit' })).toBe(false)
    expect(inside('execute', [`${PROJECT}/src`], { level: 'commands' })).toBe(true)
  })

  it('allows fetching only with the web switch, at every level', () => {
    for (const level of ['read', 'edit', 'commands'] as const) {
      expect(inside('fetch', [], { level })).toBe(false)
      expect(inside('fetch', [], { level, web: true })).toBe(true)
    }
  })

  it('never allows switch_mode or other', () => {
    for (const level of ['read', 'edit', 'commands'] as const) {
      for (const web of [false, true]) {
        expect(inside('switch_mode', [`${PROJECT}/a`], { level, web })).toBe(false)
        expect(inside('other', [`${PROJECT}/a`], { level, web })).toBe(false)
      }
    }
  })

  it('allows a location only inside the project folder', () => {
    expect(inside('read', [`${PROJECT}`])).toBe(true)
    expect(inside('read', [`${PROJECT}/src/a.ts`])).toBe(true)
    expect(inside('read', [`${PROJECT}/../other/a.ts`])).toBe(false)
    expect(inside('read', ['/home/ana/other/a.ts'])).toBe(false)
    expect(inside('read', [`${PROJECT}2/a.ts`])).toBe(false)
    expect(inside('read', ['relative/a.ts'])).toBe(true)
    expect(inside('read', ['../outside.ts'])).toBe(false)
  })

  it('keeps edits out of .git', () => {
    expect(inside('edit', [`${PROJECT}/.git/config`], { level: 'edit' })).toBe(false)
    expect(inside('edit', [`${PROJECT}/.git`], { level: 'edit' })).toBe(false)
    expect(inside('delete', [`${PROJECT}/.git/objects/a`], { level: 'commands' })).toBe(false)
    expect(inside('edit', [`${PROJECT}/.gitignore`], { level: 'edit' })).toBe(true)
    // Reading is held to the project folder, and `.git` is inside it.
    expect(inside('read', [`${PROJECT}/.git/config`])).toBe(true)
  })

  it('allows no location only for think, fetch and execute', () => {
    expect(inside('think', [])).toBe(true)
    expect(inside('fetch', [], { web: true })).toBe(true)
    expect(inside('execute', [], { level: 'commands' })).toBe(true)
    expect(inside('read', [])).toBe(false)
    expect(inside('search', [])).toBe(false)
    expect(inside('edit', [], { level: 'commands' })).toBe(false)
    expect(inside('fetch', [])).toBe(false)
    expect(inside('execute', [], { level: 'edit' })).toBe(false)
  })

  it('answers with allow_once, and never with allow_always', () => {
    const options = [allowAlways, allowOnce]
    expect(
      scopeAnswer(
        scope('read'),
        PROJECT,
        { toolKind: 'read', locations: [`${PROJECT}/a`], options },
        'darwin',
      ),
    ).toBe('allow-once')
    expect(
      scopeAnswer(
        scope('read'),
        PROJECT,
        { toolKind: 'edit', locations: [`${PROJECT}/a`], options },
        'darwin',
      ),
    ).toBeNull()
  })

  it('waits when the request offers no allow_once option', () => {
    expect(
      scopeAnswer(
        scope('commands'),
        PROJECT,
        { toolKind: 'execute', locations: [], options: [allowAlways] },
        'darwin',
      ),
    ).toBeNull()
    expect(
      scopeAnswer(
        scope('commands'),
        PROJECT,
        { toolKind: 'execute', locations: [], options: [] },
        'darwin',
      ),
    ).toBeNull()
  })

  it('applies Windows paths case-insensitively', () => {
    const options = { platform: 'win32' as Platform, project: WINDOWS_PROJECT }
    expect(inside('read', ['C:\\dev\\project\\src\\a.ts'], options)).toBe(true)
    expect(inside('read', ['c:\\DEV\\PROJECT\\SRC\\A.TS'], options)).toBe(true)
    expect(inside('read', ['C:/dev/project/src/a.ts'], options)).toBe(true)
    expect(inside('read', ['src\\a.ts'], options)).toBe(true)
    expect(inside('read', ['C:\\dev\\project2\\a.ts'], options)).toBe(false)
    expect(inside('read', ['D:\\dev\\project\\a.ts'], options)).toBe(false)
    expect(inside('read', ['..\\outside\\a.ts'], options)).toBe(false)
    expect(inside('edit', ['C:\\dev\\project\\.git\\config'], { ...options, level: 'edit' })).toBe(
      false,
    )
    expect(
      inside('read', ['\\\\server\\share\\project\\a.ts'], {
        platform: 'win32',
        project: '\\\\server\\share\\project',
      }),
    ).toBe(true)
  })

  it('compares POSIX paths case-sensitively', () => {
    expect(inside('read', [`${PROJECT}/src/a.ts`])).toBe(true)
    expect(inside('read', ['/home/ana/PROJECT/a.ts'])).toBe(false)
    expect(inside('read', [`${PROJECT}/a.ts`], { platform: 'linux' })).toBe(true)
  })
})
