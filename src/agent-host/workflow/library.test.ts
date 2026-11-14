import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { usableWorkflow } from '@shared/workflow'
import { HostError } from '../errors'
import { emptyWorkflowsFile, githubRawUrl, WorkflowLibrary, type WorkflowsFile } from './library'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const TEXT = `format: 1
name: Quick fix
steps:
  - id: fix
    name: Fix
    prompt: Fix it.
    outcomes:
      - name: Done
        end: done
`

function library(data: WorkflowsFile = emptyWorkflowsFile()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-workflows-'))
  dirs.push(dir)
  let saved = structuredClone(data)
  const lib = new WorkflowLibrary({
    dir,
    file: {
      load: async () => structuredClone(saved),
      save: (value) => {
        saved = structuredClone(value)
      },
      flush: async () => {},
    },
    knownTools: () => ({ mcp: new Set(), skills: new Set() }),
    log: () => {},
    fetch: async () => new Response('', { status: 404 }),
  })
  return { lib, dir, saved: () => saved }
}

describe('the workflow library', () => {
  it('keeps an added workflow unusable until the user approves the hash they were shown', async () => {
    const { lib } = library()
    await lib.load()
    const added = await lib.add({ kind: 'file', name: 'quick.yaml', text: TEXT })
    expect(added).toMatchObject({ id: 'quick-fix', approval: 'pending', source: 'file' })
    expect(usableWorkflow(added)).toBe(false)
    await expect(lib.resolve(added.id)).rejects.toThrow(HostError)
    await expect(lib.approve(added.id, '0'.repeat(64))).rejects.toMatchObject({ code: 'conflict' })
    const approved = await lib.approve(added.id, added.hash)
    expect(approved.approval).toBe('approved')
    expect((await lib.resolve(added.id)).hash).toBe(added.hash)
  })

  it('asks again once the file changes after its approval', async () => {
    const { lib, dir } = library()
    await lib.load()
    const added = await lib.add({ kind: 'file', name: 'quick.yaml', text: TEXT })
    await lib.approve(added.id, added.hash)
    writeFileSync(path.join(dir, `${added.id}.yaml`), TEXT.replace('Fix it.', 'Fix it well.'))
    const { entry } = await lib.read(added.id)
    expect(entry.approval).toBe('changed')
    await expect(lib.resolve(added.id)).rejects.toMatchObject({ code: 'restricted' })
  })

  it('refuses a workflow named like an official one, and never removes an official one', async () => {
    const { lib } = library()
    await lib.load()
    const clash = await lib.create(TEXT.replace('Quick fix', 'Feature development'), {
      sessionId: 's1',
      agentId: 'claude-code',
    })
    expect(clash).toEqual({
      problems: [{ at: 'name', message: 'an official workflow is named "Feature development"' }],
    })
    await expect(lib.remove('feature-development')).rejects.toMatchObject({ code: 'restricted' })
    expect((await lib.resolve('feature-development')).source).toBe('official')
  })

  it('lets Auto pick subscriptions and not API keys unless the user says so', async () => {
    const { lib, saved } = library()
    await lib.load()
    expect(lib.autoPick('claude-code', false)).toEqual({ allowed: true, byDefault: true })
    expect(lib.autoPick('codex', true)).toEqual({ allowed: false, byDefault: false })
    lib.setSettings({ autoPick: { codex: true } })
    expect(lib.autoPick('codex', true).allowed).toBe(true)
    expect(saved().autoPick).toEqual({ codex: true })
    lib.setSettings({ autoPick: { codex: null } })
    expect(lib.autoPick('codex', true).allowed).toBe(false)
  })

  it('takes only GitHub file addresses', () => {
    expect(githubRawUrl('https://github.com/o/r/blob/main/workflows/dev.yaml')).toBe(
      'https://raw.githubusercontent.com/o/r/main/workflows/dev.yaml',
    )
    expect(githubRawUrl('https://raw.githubusercontent.com/o/r/main/dev.yaml')).toBe(
      'https://raw.githubusercontent.com/o/r/main/dev.yaml',
    )
    expect(githubRawUrl('http://github.com/o/r/blob/main/dev.yaml')).toBeNull()
    expect(githubRawUrl('https://example.com/o/r/blob/main/dev.yaml')).toBeNull()
    expect(githubRawUrl('https://user:pw@github.com/o/r/blob/main/dev.yaml')).toBeNull()
  })
})
