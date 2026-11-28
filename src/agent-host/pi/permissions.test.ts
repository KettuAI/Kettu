// Pi permission gate unit tests: Pi-compatible path resolution, symlink canonicalization,
// and end-to-end scopeAnswer enforcement across read, edit, commands, and workflow step scopes.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { PermissionScope } from '@shared/routines'
import { scopeAnswer } from '../routines/scope'
import {
  buildPiPermission,
  parsePermissionGatePayload,
  PI_PERMISSION_ALLOW,
  resolveCanonicalPiPath,
  resolvePiPath,
} from './permissions'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kettu-pi-perm-'))
  dirs.push(root)
  const project = path.join(root, 'project')
  const outside = path.join(root, 'outside')
  const home = path.join(root, 'home')
  await Promise.all([
    mkdir(path.join(project, 'src'), { recursive: true }),
    mkdir(path.join(project, '.git'), { recursive: true }),
    mkdir(outside, { recursive: true }),
    mkdir(path.join(home, '.ssh'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(project, 'src', 'app.ts'), 'export const ok = true\n'),
    writeFile(path.join(project, '.git', 'config'), '[core]\n'),
    writeFile(path.join(outside, 'secret.txt'), 'top-secret\n'),
    writeFile(path.join(home, '.ssh', 'id_rsa'), 'private-key\n'),
  ])
  return { root, project, outside, home }
}

const READ_SCOPE: PermissionScope = { level: 'read', web: false }
const EDIT_SCOPE: PermissionScope = { level: 'edit', web: false }
const COMMANDS_SCOPE: PermissionScope = { level: 'commands', web: false }

async function evaluate(
  scope: PermissionScope,
  project: string,
  toolName: string,
  input: Record<string, unknown>,
  homeDir: string,
) {
  const built = await buildPiPermission({ toolName, input }, project, { homeDir })
  const answer = scopeAnswer(
    scope,
    project,
    {
      toolKind: built.toolKind,
      locations: built.locations.map((loc) => loc.path),
      options: built.options,
    },
    process.platform as 'darwin' | 'linux' | 'win32',
  )
  return { built, answer }
}

describe('resolvePiPath', () => {
  it('matches Pi path normalization for @ prefix, ~, file:// URLs, Unicode spaces, and Windows shell paths', () => {
    expect(
      resolvePiPath('src/index.ts', '/work/app', { homeDir: '/Users/dev', platform: 'darwin' }),
    ).toBe('/work/app/src/index.ts')
    expect(
      resolvePiPath('@/etc/passwd', '/work/app', { homeDir: '/Users/dev', platform: 'darwin' }),
    ).toBe('/etc/passwd')
    expect(
      resolvePiPath('@~/secret', '/work/app', { homeDir: '/Users/dev', platform: 'darwin' }),
    ).toBe('/Users/dev/secret')
    expect(resolvePiPath('~', '/work/app', { homeDir: '/Users/dev', platform: 'darwin' })).toBe(
      '/Users/dev',
    )
    expect(
      resolvePiPath('docs/my\u00A0file.md', '/work/app', {
        homeDir: '/Users/dev',
        platform: 'darwin',
      }),
    ).toBe('/work/app/docs/my file.md')
    expect(
      resolvePiPath(pathToFileURL('/etc/hosts').href, '/work/app', {
        homeDir: '/Users/dev',
        platform: 'darwin',
      }),
    ).toBe('/etc/hosts')
    expect(resolvePiPath('file://not a valid host', '/work/app', { platform: 'darwin' })).toBeNull()
    expect(resolvePiPath('', '/work/app', { platform: 'darwin' })).toBeNull()
    expect(resolvePiPath('@', '/work/app', { platform: 'darwin' })).toBeNull()
    expect(
      resolvePiPath('/c/Users/dev/secret.txt', 'C:\\work\\app', {
        homeDir: 'C:\\Users\\dev',
        platform: 'win32',
      }),
    ).toBe('C:\\Users\\dev\\secret.txt')
    expect(
      resolvePiPath('/mnt/d/outside.txt', 'C:\\work\\app', {
        homeDir: 'C:\\Users\\dev',
        platform: 'win32',
      }),
    ).toBe('D:\\outside.txt')
  })
})

describe('resolveCanonicalPiPath', () => {
  it('detects symlinks escaping the workspace and symlinks targeting .git, and fails closed on loops', async () => {
    const { project, outside } = await makeWorkspace()
    await symlink(path.join(outside, 'secret.txt'), path.join(project, 'escape-file'))
    await symlink(outside, path.join(project, 'escape-dir'))
    await symlink(path.join(project, '.git', 'config'), path.join(project, 'git-link'))
    await symlink(path.join(project, 'loop-b'), path.join(project, 'loop-a'))
    await symlink(path.join(project, 'loop-a'), path.join(project, 'loop-b'))

    // Regular in-project file and new file in existing subdir stay under `project`.
    expect(await resolveCanonicalPiPath(path.join(project, 'src', 'app.ts'), project)).toBe(
      path.join(project, 'src', 'app.ts'),
    )
    expect(await resolveCanonicalPiPath(path.join(project, 'src', 'new-file.ts'), project)).toBe(
      path.join(project, 'src', 'new-file.ts'),
    )

    // Symlink pointing outside resolves outside `project`.
    const escaped = await resolveCanonicalPiPath(path.join(project, 'escape-file'), project)
    expect(escaped).not.toBeNull()
    expect(escaped!.startsWith(project + path.sep)).toBe(false)

    // New file under an escaping symlink directory resolves outside `project`.
    const escapedNew = await resolveCanonicalPiPath(
      path.join(project, 'escape-dir', 'pwned.txt'),
      project,
    )
    expect(escapedNew).not.toBeNull()
    expect(escapedNew!.startsWith(project + path.sep)).toBe(false)

    // Symlink pointing into `.git` resolves to `<project>/.git/config`.
    expect(await resolveCanonicalPiPath(path.join(project, 'git-link'), project)).toBe(
      path.join(project, '.git', 'config'),
    )

    // Symlink loop fails closed to `null`.
    expect(await resolveCanonicalPiPath(path.join(project, 'loop-a'), project)).toBeNull()
  })
})

describe('parsePermissionGatePayload', () => {
  it('validates nonce, toolName, toolCallId, input, and parentToolCallId strictly', () => {
    expect(parsePermissionGatePayload(undefined)).toBeNull()
    expect(parsePermissionGatePayload('not json')).toBeNull()
    expect(parsePermissionGatePayload(JSON.stringify({ toolName: 'read' }))).toBeNull()
    expect(parsePermissionGatePayload(JSON.stringify({ nonce: 'abc' }))).toBeNull()
    expect(
      parsePermissionGatePayload(
        JSON.stringify({ nonce: 'abc', toolName: 'read', toolCallId: 42 }),
      ),
    ).toBeNull()
    expect(
      parsePermissionGatePayload(
        JSON.stringify({
          nonce: 'abc',
          toolCallId: 'c1',
          toolName: 'write',
          input: { path: 'a.txt', content: 'hi' },
          parentToolCallId: null,
        }),
      ),
    ).toEqual({
      nonce: 'abc',
      toolCallId: 'c1',
      toolName: 'write',
      input: { path: 'a.txt', content: 'hi' },
      parentToolCallId: null,
    })
  })
})

describe('buildPiPermission + scopeAnswer enforcement matrix', () => {
  it('enforces read-only scope: allows in-project reads/searches and blocks writes, commands, escapes, and unknown tools', async () => {
    const { project, outside, home } = await makeWorkspace()
    await symlink(path.join(outside, 'secret.txt'), path.join(project, 'escape-file'))
    await symlink(outside, path.join(project, 'escape-dir'))

    // Allowed within read-only scope.
    for (const [tool, input] of [
      ['read', { path: 'src/app.ts' }],
      ['grep', { pattern: 'ok' }],
      ['grep', { pattern: 'ok', path: 'src' }],
      ['find', { pattern: '*.ts' }],
      ['ls', {}],
      ['ls', { path: 'src' }],
    ] as const) {
      const { built, answer } = await evaluate(READ_SCOPE, project, tool, input, home)
      expect(answer, `${tool} ${JSON.stringify(input)}`).toBe(PI_PERMISSION_ALLOW)
      // Never offers allow_always.
      expect(built.options.map((opt) => opt.kind)).toEqual(['allow_once', 'reject_once'])
    }

    // Blocked / held for approval in read-only scope.
    for (const [tool, input] of [
      ['write', { path: 'src/new.ts', content: 'x' }],
      ['edit', { path: 'src/app.ts', oldText: 'true', newText: 'false' }],
      ['bash', { command: 'rm -rf .' }],
      ['powershell', { command: 'Get-ChildItem' }],
      ['read', { path: '../outside/secret.txt' }],
      ['read', { path: `@${path.join(outside, 'secret.txt')}` }],
      ['read', { path: '~/.ssh/id_rsa' }],
      ['read', { path: pathToFileURL(path.join(outside, 'secret.txt')).href }],
      ['read', { path: 'escape-file' }],
      ['read', {}],
      ['grep', { pattern: 'secret', path: '../outside' }],
      ['grep', { pattern: 'secret', path: 'escape-dir' }],
      ['find', { pattern: '*', path: '../outside' }],
      ['ls', { path: '../outside' }],
      ['codemode', { code: 'return 1' }],
      ['mcp__github__list_issues', {}],
      ['read_mcp_resource', { server: 'docs', uri: 'file:///a' }],
      ['custom_unknown_tool', {}],
    ] as const) {
      const { answer } = await evaluate(READ_SCOPE, project, tool, input, home)
      expect(answer, `${tool} ${JSON.stringify(input)} should require approval`).toBeNull()
    }
  })

  it('enforces edit scope: allows in-project edits, blocks commands, outside-workspace writes, and .git writes (including via symlinks)', async () => {
    const { project, outside, home } = await makeWorkspace()
    await symlink(outside, path.join(project, 'escape-dir'))
    await symlink(path.join(project, '.git', 'config'), path.join(project, 'git-link'))

    expect(
      (await evaluate(EDIT_SCOPE, project, 'write', { path: 'src/new.ts', content: 'hi' }, home))
        .answer,
    ).toBe(PI_PERMISSION_ALLOW)
    expect(
      (
        await evaluate(
          EDIT_SCOPE,
          project,
          'edit',
          { path: 'src/app.ts', oldText: 'true', newText: 'false' },
          home,
        )
      ).answer,
    ).toBe(PI_PERMISSION_ALLOW)

    for (const [tool, input] of [
      ['bash', { command: 'echo hi' }],
      ['powershell', { command: 'Write-Output hi' }],
      ['write', { path: '../outside/pwn.txt', content: 'bad' }],
      ['write', { path: `@${path.join(outside, 'pwn.txt')}`, content: 'bad' }],
      ['write', { path: '~/pwn.txt', content: 'bad' }],
      ['write', { path: pathToFileURL(path.join(outside, 'pwn.txt')).href, content: 'bad' }],
      ['write', { path: 'escape-dir/pwn.txt', content: 'bad' }],
      ['write', { path: '.git/config', content: 'bad' }],
      ['edit', { path: 'git-link', oldText: '[core]', newText: '[evil]' }],
    ] as const) {
      const { answer } = await evaluate(EDIT_SCOPE, project, tool, input, home)
      expect(answer, `${tool} ${JSON.stringify(input)} should require approval`).toBeNull()
    }
  })

  it('enforces commands / workflow STEP_SCOPE: allows in-project edits and shells, still blocks escapes, .git edits, codemode, and third-party MCP tools', async () => {
    const { project, outside, home } = await makeWorkspace()
    await symlink(outside, path.join(project, 'escape-dir'))

    const bash = await evaluate(COMMANDS_SCOPE, project, 'bash', { command: 'pnpm test' }, home)
    expect(bash.answer).toBe(PI_PERMISSION_ALLOW)
    expect(bash.built.shell).toBeUndefined()

    const ps = await evaluate(COMMANDS_SCOPE, project, 'powershell', { command: 'pnpm test' }, home)
    expect(ps.answer).toBe(PI_PERMISSION_ALLOW)
    expect(ps.built.shell).toBe('powershell')

    for (const [tool, input] of [
      ['write', { path: '../outside/pwn.txt', content: 'bad' }],
      ['write', { path: 'escape-dir/pwn.txt', content: 'bad' }],
      ['write', { path: '.git/HEAD', content: 'bad' }],
      ['read', { path: '~/.ssh/id_rsa' }],
      ['codemode', { code: 'return 1' }],
      ['mcp__third_party__delete_all', {}],
    ] as const) {
      const { answer } = await evaluate(COMMANDS_SCOPE, project, tool, input, home)
      expect(answer, `${tool} ${JSON.stringify(input)} should require approval`).toBeNull()
    }
  })
})
