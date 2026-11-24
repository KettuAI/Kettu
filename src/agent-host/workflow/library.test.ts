import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { usableWorkflow } from '@shared/workflow'
import { HostError } from '../errors'
import {
  emptyWorkflowsFile,
  githubRawUrl,
  parseWorkflowsFile,
  WorkflowLibrary,
  type WorkflowsFile,
} from './library'

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

describe("a plugin's workflows", () => {
  const origin = {
    kind: 'plugin',
    pluginId: 'p0123456789ab',
    name: 'quick',
    plugin: 'Kit',
  } as const

  it('stay approved over an update only while the text is the same, and leave with the plugin', async () => {
    const { lib, saved } = library()
    await lib.load()
    const id = await lib.installPlugin(TEXT, origin)
    const added = (await lib.read(id)).entry
    expect(added).toMatchObject({ source: 'plugin', approval: 'pending', origin })
    await lib.approve(id, added.hash)
    expect(await lib.installPlugin(TEXT, origin)).toBe(id)
    expect((await lib.read(id)).entry.approval).toBe('approved')
    await lib.installPlugin(TEXT.replace('Fix it.', 'Fix it now.'), origin)
    expect((await lib.read(id)).entry.approval).toBe('changed')
    await expect(lib.remove(id)).rejects.toMatchObject({ code: 'restricted' })
    const other = await lib.installPlugin(TEXT, { ...origin, name: 'other' })
    await lib.removePlugin(origin.pluginId, ['other'])
    expect((await lib.list()).map((entry) => entry.id)).toEqual([other])
    await lib.removePlugin(origin.pluginId)
    expect(await lib.list()).toEqual([])
    expect(saved().entries).toEqual({})
  })

  it('are read from the file only with a plugin they name', () => {
    const record = { source: 'plugin', origin, addedAt: 1, approved: null }
    const parsed = parseWorkflowsFile({
      entries: {
        good: record,
        'no-plugin': { ...record, origin: { ...origin, pluginId: '../x' } },
        'other-source': { ...record, source: 'file' },
        'other-origin': { ...record, origin: { kind: 'file', name: 'a.yaml' } },
      },
    })
    expect(Object.keys((parsed as WorkflowsFile).entries)).toEqual(['good'])
  })
})

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

  it('ships no workflows, and takes the names of those Kettu once shipped like any other', async () => {
    const { lib } = library()
    await lib.load()
    expect(await lib.list()).toEqual([])
    const created = await lib.create(TEXT.replace('Quick fix', 'Feature development'), {
      sessionId: 's1',
      agentId: 'claude-code',
    })
    expect(created).toMatchObject({ id: 'feature-development', source: 'agent', problems: [] })
    const origin = {
      kind: 'community',
      listingId: 'abcdefgh23',
      version: '1.0.0',
      handle: 'kettu-labs',
      slug: 'fix-a-bug',
      official: true,
    } as const
    const { entry } = await lib.installListing(TEXT.replace('Quick fix', 'Fix a bug'), origin)
    expect(entry).toMatchObject({ id: 'fix-a-bug', source: 'community', problems: [], origin })
    await lib.remove('feature-development')
    expect((await lib.list()).map((e) => e.id)).toEqual(['fix-a-bug'])
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

  it('keeps a listing’s record only with its listing and version, and only as the Marketplace’s', () => {
    const origin = {
      kind: 'community',
      listingId: 'abcdefgh23',
      version: '1.0.1',
      handle: 'amigoer',
      slug: 'release-notes',
    }
    const record = { source: 'community', origin, addedAt: 1, approved: null }
    const file = parseWorkflowsFile({
      entries: {
        'release-notes': record,
        'kettu-own': { ...record, origin: { ...origin, official: true } },
        'no-version': { ...record, origin: { ...origin, version: 'latest' } },
        'bad-listing': { ...record, origin: { ...origin, listingId: '../x' } },
        'as-github': { ...record, source: 'github' },
        'no-listing': { ...record, origin: null },
      },
    })
    // A record kept before listings said whether Kettu published them reads as not Kettu's.
    expect(file).toMatchObject({
      entries: {
        'release-notes': { ...record, origin: { ...origin, official: false } },
        'kettu-own': { origin: { official: true } },
      },
    })
    expect(Object.keys((file as WorkflowsFile).entries)).toEqual(['release-notes', 'kettu-own'])
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
