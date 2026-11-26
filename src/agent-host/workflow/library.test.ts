import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { usableWorkflow } from '@shared/workflow'
import { HostError } from '../errors'
import { workflowHash } from './format'
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

function library(
  data: WorkflowsFile = emptyWorkflowsFile(),
  options: {
    now?: () => number
    fetch?: typeof fetch
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kettu-workflows-'))
  const dir = path.join(root, 'workflows')
  const approvedDir = path.join(root, 'workflow-approved')
  mkdirSync(dir, { recursive: true })
  dirs.push(root)
  let saved = structuredClone(data)
  let saves = 0
  const lib = new WorkflowLibrary({
    dir,
    approvedDir,
    file: {
      load: async () => structuredClone(saved),
      save: (value) => {
        saves++
        saved = structuredClone(value)
      },
      flush: async () => {},
    },
    knownTools: () => ({ mcp: new Set(), skills: new Set() }),
    log: () => {},
    fetch: options.fetch ?? (async () => new Response('', { status: 404 })),
    ...(options.now ? { now: options.now } : {}),
  })
  return { lib, dir, approvedDir, saved: () => saved, saves: () => saves }
}

describe("a plugin's workflows", () => {
  const origin = {
    kind: 'plugin',
    pluginId: 'p0123456789ab',
    name: 'quick',
    plugin: 'Kit',
  } as const

  it('stay approved over an update only while the text is the same, and leave with the plugin', async () => {
    const { lib, approvedDir, saved } = library()
    await lib.load()
    const id = await lib.installPlugin(TEXT, origin)
    const added = (await lib.read(id)).entry
    expect(added).toMatchObject({ source: 'plugin', approval: 'pending', origin })
    await lib.approve(id, added.hash)
    expect(existsSync(path.join(approvedDir, `${id}.yaml`))).toBe(true)
    expect(await lib.installPlugin(TEXT, origin)).toBe(id)
    expect((await lib.read(id)).entry.approval).toBe('approved')
    await lib.installPlugin(TEXT.replace('Fix it.', 'Fix it now.'), origin)
    const changed = await lib.read(id)
    expect(changed.entry.approval).toBe('changed')
    expect(changed.approved?.text).toBe(TEXT)
    expect(changed.approved?.approvedAt).toBeTypeOf('number')
    expect(changed.approved?.changedAt).toBeTypeOf('number')
    await expect(lib.remove(id)).rejects.toMatchObject({ code: 'restricted' })
    const other = await lib.installPlugin(TEXT, { ...origin, name: 'other' })
    await lib.removePlugin(origin.pluginId, ['other'])
    expect(existsSync(path.join(approvedDir, `${id}.yaml`))).toBe(false)
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
    let clock = 1_700_000_000_000
    const { lib, dir, approvedDir, saved, saves } = library(emptyWorkflowsFile(), {
      now: () => clock,
    })
    await lib.load()
    const added = await lib.add({ kind: 'file', name: 'quick.yaml', text: TEXT })
    expect(added.approvedAt).toBeNull()
    expect(added.changedAt).toBeNull()

    clock = 1_700_000_010_000
    const approvedEntry = await lib.approve(added.id, added.hash)
    expect(approvedEntry.approvedAt).toBe(1_700_000_010_000)
    expect(approvedEntry.changedAt).toBeNull()
    expect(existsSync(path.join(approvedDir, `${added.id}.yaml`))).toBe(true)

    // Re-approving the already-approved hash keeps the original approval timestamp.
    clock = 1_700_000_015_000
    const rechecked = await lib.approve(added.id, added.hash)
    expect(rechecked.approvedAt).toBe(1_700_000_010_000)
    expect((await lib.read(added.id)).approved).toBeNull()

    // Modify the file on disk with an mtime between approvedAt and now.
    const edited = TEXT.replace('Fix it.', 'Fix it well.')
    const file = path.join(dir, `${added.id}.yaml`)
    writeFileSync(file, edited)
    const editTime = 1_700_000_020_000
    utimesSync(file, editTime / 1000, editTime / 1000)

    clock = 1_700_000_060_000
    const firstRead = await lib.read(added.id)
    expect(firstRead.entry.approval).toBe('changed')
    expect(firstRead.entry.approvedAt).toBe(1_700_000_010_000)
    expect(firstRead.entry.changedAt).toBe(editTime)
    expect(firstRead.text).toBe(edited)
    expect(firstRead.approved).toEqual({
      hash: added.hash,
      text: TEXT,
      workflow: added.workflow,
      approvedAt: 1_700_000_010_000,
      changedAt: editTime,
    })
    await expect(lib.resolve(added.id)).rejects.toMatchObject({ code: 'restricted' })

    // Reading the same modified file again does not bump changedAt or rewrite workflows.json.
    const savesAfterFirst = saves()
    clock = 1_700_000_120_000
    utimesSync(file, 1_700_000_090, 1_700_000_090)
    const secondRead = await lib.read(added.id)
    expect(secondRead.entry.changedAt).toBe(editTime)
    expect(secondRead.approved?.changedAt).toBe(editTime)
    expect(saves()).toBe(savesAfterFirst)

    // A further edit updates changedAt while preserving the originally approved version and time.
    const editedAgain = TEXT.replace('Fix it.', 'Fix it twice.')
    writeFileSync(file, editedAgain)
    const secondEditTime = 1_700_000_130_000
    utimesSync(file, secondEditTime / 1000, secondEditTime / 1000)
    clock = 1_700_000_150_000
    const thirdRead = await lib.read(added.id)
    expect(thirdRead.entry.changedAt).toBe(secondEditTime)
    expect(thirdRead.approved).toEqual({
      hash: added.hash,
      text: TEXT,
      workflow: added.workflow,
      approvedAt: 1_700_000_010_000,
      changedAt: secondEditTime,
    })

    // Re-approving updates the snapshot and approvedAt and clears the changed state.
    clock = 1_700_000_200_000
    const reapproved = await lib.approve(added.id, thirdRead.entry.hash)
    expect(reapproved.approval).toBe('approved')
    expect(reapproved.approvedAt).toBe(1_700_000_200_000)
    expect(reapproved.changedAt).toBeNull()
    expect(saved().entries[added.id]?.changedHash).toBeUndefined()
    expect(saved().entries[added.id]?.changedAt).toBeUndefined()

    // Subsequent changes now compare against the newly approved version.
    const editedThird = TEXT.replace('Fix it.', 'Fix it thrice.')
    writeFileSync(file, editedThird)
    clock = 1_700_000_250_000
    // Real OS mtime is ahead of our fake clock, so changedAt falls back to now.
    const fourthRead = await lib.read(added.id)
    expect(fourthRead.entry.changedAt).toBe(1_700_000_250_000)
    expect(fourthRead.approved).toEqual({
      hash: reapproved.hash,
      text: editedAgain,
      workflow: reapproved.workflow,
      approvedAt: 1_700_000_200_000,
      changedAt: 1_700_000_250_000,
    })

    // Removing the workflow also removes its approved snapshot.
    await lib.remove(added.id)
    expect(existsSync(path.join(approvedDir, `${added.id}.yaml`))).toBe(false)
  })

  it('clears changed state when a file is reverted to its approved text', async () => {
    let clock = 1_000
    const { lib, dir, saved } = library(emptyWorkflowsFile(), { now: () => clock })
    await lib.load()
    const added = await lib.add({ kind: 'file', name: 'quick.yaml', text: TEXT })
    clock = 2_000
    await lib.approve(added.id, added.hash)
    const file = path.join(dir, `${added.id}.yaml`)
    writeFileSync(file, TEXT.replace('Fix it.', 'Changed.'))
    clock = 3_000
    expect((await lib.read(added.id)).entry.changedAt).toBe(3_000)

    writeFileSync(file, TEXT)
    clock = 4_000
    const reverted = await lib.read(added.id)
    expect(reverted.entry.approval).toBe('approved')
    expect(reverted.entry.approvedAt).toBe(2_000)
    expect(reverted.entry.changedAt).toBeNull()
    expect(reverted.approved).toBeNull()
    expect(saved().entries[added.id]?.changedHash).toBeUndefined()
    expect(saved().entries[added.id]?.changedAt).toBeUndefined()
  })

  it('records changedAt when Kettu replaces an approved workflow via update or install', async () => {
    let clock = 5_000
    let remoteText = TEXT
    const { lib } = library(emptyWorkflowsFile(), {
      now: () => clock,
      fetch: async () => new Response(remoteText, { status: 200 }),
    })
    await lib.load()
    const added = await lib.add({
      kind: 'url',
      url: 'https://github.com/o/r/blob/main/quick.yaml',
    })
    clock = 6_000
    await lib.approve(added.id, added.hash)

    remoteText = TEXT.replace('Fix it.', 'Fix it remotely.')
    clock = 7_500
    const updated = await lib.update(added.id)
    expect(updated.changed).toBe(true)
    expect(updated.entry.approval).toBe('changed')
    expect(updated.entry.approvedAt).toBe(6_000)
    expect(updated.entry.changedAt).toBe(7_500)

    clock = 9_000
    const read = await lib.read(added.id)
    expect(read.approved).toEqual({
      hash: added.hash,
      text: TEXT,
      workflow: added.workflow,
      approvedAt: 6_000,
      changedAt: 7_500,
    })
  })

  it('handles legacy approval records that only stored a hash', async () => {
    const oldHash = workflowHash(TEXT)
    const legacy: WorkflowsFile = {
      version: 1,
      entries: {
        'quick-fix': {
          source: 'file',
          origin: { kind: 'file', name: 'quick.yaml' },
          addedAt: 1_000,
          approved: oldHash,
        },
      },
      pins: {},
      suggest: true,
      autoPick: {},
    }
    let clock = 5_000
    const { lib, dir } = library(legacy, { now: () => clock })
    await lib.load()
    // File was already modified before any snapshot existed.
    writeFileSync(path.join(dir, 'quick-fix.yaml'), TEXT.replace('Fix it.', 'Already modified.'))
    const read = await lib.read('quick-fix')
    expect(read.entry.approval).toBe('changed')
    expect(read.entry.approvedAt).toBeNull()
    expect(read.entry.changedAt).toBe(5_000)
    expect(read.approved).toEqual({
      hash: oldHash,
      text: null,
      workflow: null,
      approvedAt: null,
      changedAt: 5_000,
    })

    // Reading again keeps the recorded changedAt.
    clock = 8_000
    expect((await lib.read('quick-fix')).entry.changedAt).toBe(5_000)
  })

  it('backfills an approved snapshot for an unchanged legacy record without inventing approvedAt', async () => {
    const oldHash = workflowHash(TEXT)
    const legacy: WorkflowsFile = {
      version: 1,
      entries: {
        'quick-fix': {
          source: 'file',
          origin: { kind: 'file', name: 'quick.yaml' },
          addedAt: 1_000,
          approved: oldHash,
        },
      },
      pins: {},
      suggest: true,
      autoPick: {},
    }
    let clock = 4_000
    const { lib, dir } = library(legacy, { now: () => clock })
    await lib.load()
    const file = path.join(dir, 'quick-fix.yaml')
    writeFileSync(file, TEXT)
    const [listed] = await lib.list()
    expect(listed?.approval).toBe('approved')
    expect(listed?.approvedAt).toBeNull()

    writeFileSync(file, TEXT.replace('Fix it.', 'Edited after upgrade.'))
    clock = 6_000
    const read = await lib.read('quick-fix')
    expect(read.entry.approval).toBe('changed')
    expect(read.entry.approvedAt).toBeNull()
    expect(read.entry.changedAt).toBe(6_000)
    expect(read.approved).toMatchObject({
      hash: oldHash,
      text: TEXT,
      approvedAt: null,
      changedAt: 6_000,
    })
    expect(read.approved?.workflow?.name).toBe('Quick fix')
  })

  it('ignores a corrupted approved snapshot whose hash does not match the approved hash', async () => {
    let clock = 1_000
    const { lib, dir, approvedDir } = library(emptyWorkflowsFile(), { now: () => clock })
    await lib.load()
    const added = await lib.add({ kind: 'file', name: 'quick.yaml', text: TEXT })
    clock = 2_000
    await lib.approve(added.id, added.hash)
    writeFileSync(path.join(approvedDir, `${added.id}.yaml`), 'corrupted')
    writeFileSync(path.join(dir, `${added.id}.yaml`), TEXT.replace('Fix it.', 'Changed.'))
    clock = 3_000
    const read = await lib.read(added.id)
    expect(read.approved).toEqual({
      hash: added.hash,
      text: null,
      workflow: null,
      approvedAt: 2_000,
      changedAt: 3_000,
    })
  })

  it('parses approvedAt and changedAt fields safely while staying backward compatible', () => {
    const hashA = 'a'.repeat(64)
    const hashB = 'b'.repeat(64)
    const parsed = parseWorkflowsFile({
      entries: {
        legacy: { source: 'user', origin: null, addedAt: 1, approved: hashA },
        changed: {
          source: 'user',
          origin: null,
          addedAt: 1,
          approved: hashA,
          approvedAt: 10,
          changedHash: hashB,
          changedAt: 20,
        },
        'file-gone': {
          source: 'user',
          origin: null,
          addedAt: 1,
          approved: hashA,
          approvedAt: 10,
          changedHash: '',
          changedAt: 25,
        },
        'bad-meta': {
          source: 'user',
          origin: null,
          addedAt: 1,
          approved: hashA,
          approvedAt: -1,
          changedHash: hashA,
          changedAt: 30,
        },
        unapproved: {
          source: 'user',
          origin: null,
          addedAt: 1,
          approved: null,
          approvedAt: 10,
          changedHash: hashB,
          changedAt: 20,
        },
      },
    }) as WorkflowsFile
    expect(parsed.entries.legacy).toEqual({
      source: 'user',
      origin: null,
      addedAt: 1,
      approved: hashA,
    })
    expect(parsed.entries.changed).toEqual({
      source: 'user',
      origin: null,
      addedAt: 1,
      approved: hashA,
      approvedAt: 10,
      changedHash: hashB,
      changedAt: 20,
    })
    expect(parsed.entries['file-gone']).toEqual({
      source: 'user',
      origin: null,
      addedAt: 1,
      approved: hashA,
      approvedAt: 10,
      changedHash: '',
      changedAt: 25,
    })
    expect(parsed.entries['bad-meta']).toEqual({
      source: 'user',
      origin: null,
      addedAt: 1,
      approved: hashA,
    })
    expect(parsed.entries.unapproved).toEqual({
      source: 'user',
      origin: null,
      addedAt: 1,
      approved: null,
    })
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
