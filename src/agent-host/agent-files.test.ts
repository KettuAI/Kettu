// The files an agent keeps for a session outside the project: a client reads them only from that
// session's own folder, by real path, and never writes them.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import { agentFolder, AgentFiles } from './agent-files'
import { FilesService } from './files'

const platform: Platform = process.platform === 'win32' ? 'win32' : 'darwin'

describe('agentFolder', () => {
  it("is agy's brain folder of the session for Antigravity", () => {
    expect(agentFolder('antigravity', 'ee66-77d8', '/Users/me', 'darwin')).toBe(
      '/Users/me/.gemini/antigravity-cli/brain/ee66-77d8',
    )
    expect(agentFolder('antigravity~work', 'ee66', '/Users/me', 'darwin')).toBe(
      '/Users/me/.gemini/antigravity-cli/brain/ee66',
    )
    expect(agentFolder('antigravity', 'ee66', 'C:\\Users\\me', 'win32')).toBe(
      'C:\\Users\\me\\.gemini\\antigravity-cli\\brain\\ee66',
    )
  })

  it('is none for an agent that keeps no folder of its own', () => {
    expect(agentFolder('claude-code', 'ee66', '/Users/me', 'darwin')).toBeNull()
    expect(agentFolder('opencode', 'ee66', '/Users/me', 'darwin')).toBeNull()
  })

  it("is none for a session id that is not one folder's name", () => {
    for (const id of ['', '.', '..', '../ee66', 'a/b', 'a\\b', '/abs', 'a\0b']) {
      expect(agentFolder('antigravity', id, '/Users/me', 'darwin')).toBeNull()
    }
  })
})

describe('AgentFiles', () => {
  let home: string
  let brain: string
  let mine: string
  let theirs: string
  let project: string
  let sessions: Record<string, { agentId: AgentId; agentSessionId: string }>

  const files = () =>
    new FilesService({
      exec: async () => ({ code: 0, stdout: '', stderr: '', failure: null, message: '' }),
      platform,
      media: async () => null,
      describeMedia: async () => null,
    })
  const service = () =>
    new AgentFiles({
      platform,
      homeDir: home,
      session: (id) => sessions[id] ?? null,
      read: (real, shown) => files().readAllowed(real, shown),
    })
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'read',
      (error: { code?: string }) => error.code ?? 'thrown',
    )

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-agent-files-')))
    brain = path.join(home, '.gemini', 'antigravity-cli', 'brain')
    mine = path.join(brain, 'agy-1')
    theirs = path.join(brain, 'agy-2')
    project = path.join(home, 'project')
    await mkdir(path.join(mine, 'notes'), { recursive: true })
    await mkdir(theirs, { recursive: true })
    await mkdir(project)
    await writeFile(path.join(mine, 'plan.md'), '# Plan\n')
    await writeFile(path.join(mine, 'notes', 'walkthrough.md'), '# Walkthrough\n')
    await writeFile(path.join(theirs, 'plan.md'), '# Their plan\n')
    await writeFile(path.join(project, 'README.md'), '# Project\n')
    await writeFile(path.join(home, 'secret.txt'), 'secret\n')
    sessions = {
      s1: { agentId: 'antigravity', agentSessionId: 'agy-1' },
      s2: { agentId: 'antigravity', agentSessionId: 'agy-2' },
      cc: { agentId: 'claude-code', agentSessionId: 'agy-1' },
    }
  })

  afterEach(() => rm(home, { recursive: true, force: true }))

  it("names the session's own folder, and none for an agent without one", () => {
    expect(service().folder('s1')).toBe(mine)
    expect(service().folder('cc')).toBeNull()
    expect(service().folder('gone')).toBeNull()
  })

  it("reads a file in the session's own folder, as the path it was asked for", async () => {
    const file = path.join(mine, 'plan.md')
    expect(await service().read('s1', file)).toMatchObject({
      kind: 'text',
      path: file,
      text: '# Plan\n',
      // A client may not edit it, whatever its bytes.
      editable: false,
    })
    const nested = path.join(mine, 'notes', 'walkthrough.md')
    expect(await service().read('s1', nested)).toMatchObject({ kind: 'text', path: nested })
  })

  it("refuses another session's folder", async () => {
    expect(await code(service().read('s1', path.join(theirs, 'plan.md')))).toBe('forbidden')
  })

  it('refuses a path outside the folder and the project alike', async () => {
    const svc = service()
    expect(await code(svc.read('s1', path.join(home, 'secret.txt')))).toBe('forbidden')
    expect(await code(svc.read('s1', path.join(project, 'README.md')))).toBe('forbidden')
    expect(await code(svc.read('s1', brain))).toBe('forbidden')
    expect(await code(svc.read('s1', mine))).toBe('forbidden')
    // `..` that climbs out is read as where it leads.
    expect(
      await code(svc.read('s1', `${mine}${path.sep}..${path.sep}agy-2${path.sep}plan.md`)),
    ).toBe('forbidden')
    expect(await code(svc.read('s1', `${mine}${path.sep}..${path.sep}..${path.sep}x`))).toBe(
      'forbidden',
    )
  })

  it('refuses a link in the folder that leads out of it', async () => {
    await symlink(path.join(home, 'secret.txt'), path.join(mine, 'leak.md'))
    await symlink(theirs, path.join(mine, 'other'))
    expect(await code(service().read('s1', path.join(mine, 'leak.md')))).toBe('forbidden')
    expect(await code(service().read('s1', path.join(mine, 'other', 'plan.md')))).toBe('forbidden')
  })

  it('refuses a session whose agent keeps no folder, and one Kettu does not hold', async () => {
    const file = path.join(mine, 'plan.md')
    expect(await code(service().read('cc', file))).toBe('forbidden')
    expect(await code(service().read('gone', file))).toBe('not_found')
  })

  it('says a file of the folder that is not there is not found', async () => {
    expect(await code(service().read('s1', path.join(mine, 'missing.md')))).toBe('not_found')
    expect(await code(service().read('s1', path.join(mine, 'notes')))).toBe('invalid_params')
  })

  it('refuses a path that is not absolute', async () => {
    expect(await code(service().read('s1', 'plan.md'))).toBe('invalid_params')
    expect(await code(service().read('s1', `${mine}${path.sep}plan\0.md`))).toBe('invalid_params')
  })

  it('leaves no way to write one: the project write cannot reach it', async () => {
    expect('write' in service()).toBe(false)
    const relative = path.relative(project, path.join(mine, 'plan.md'))
    const written = files().write(project, relative, 'changed', null)
    expect(await code(written)).toBe('invalid_params')
    expect(await code(files().write(project, path.join(mine, 'plan.md'), 'x', null))).toBe(
      'invalid_params',
    )
  })
})
