import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectMcpAnswers } from './project-mcp'
import { parseProjectMcpFile, projectMcpFile } from './storage'

let dir: string
const stores: ProjectMcpAnswers[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-project-mcp-'))
})

afterEach(async () => {
  // An answer's write may still be on its way to the folder.
  await Promise.all(stores.splice(0).map((store) => store.flush()))
  await rm(dir, { recursive: true, force: true })
})

async function answers(): Promise<ProjectMcpAnswers> {
  const store = new ProjectMcpAnswers(projectMcpFile(dir, () => {}))
  stores.push(store)
  await store.load()
  return store
}

describe("a folder's own MCP servers", () => {
  it('hold every server nobody answered for', async () => {
    const store = await answers()
    expect(store.allowed('/repo', 'db')).toBeNull()
    expect(store.held('/repo', ['db', 'web'])).toEqual(['db', 'web'])
  })

  it('let the servers the user allowed start, in that folder only', async () => {
    const store = await answers()
    store.answer('/repo', ['db'], 'use')
    expect(store.held('/repo', ['db', 'web'])).toEqual(['web'])
    expect(store.allowed('/repo', 'web')).toBeNull()
    expect(store.held('/other', ['db'])).toEqual(['db'])
  })

  it('let every server of the folder start after all, later ones too, but not a refused one', async () => {
    const store = await answers()
    store.answer('/repo', ['old'], 'skip')
    store.answer('/repo', ['db'], 'all')
    expect(store.held('/repo', ['db', 'added-later', 'old'])).toEqual(['old'])
  })

  it('keep a refused server off, and an answer replaces the one before it', async () => {
    const store = await answers()
    store.answer('/repo', ['db'], 'skip')
    expect(store.allowed('/repo', 'db')).toBe(false)
    store.answer('/repo', ['db'], 'use')
    expect(store.allowed('/repo', 'db')).toBe(true)
    store.answer('/repo', ['db'], 'skip')
    expect(store.allowed('/repo', 'db')).toBe(false)
  })

  it('keep the answers on disk', async () => {
    const store = await answers()
    store.answer('/repo', ['db'], 'use')
    store.answer('/repo', ['shell'], 'skip')
    await store.flush()
    const again = await answers()
    expect(again.allowed('/repo', 'db')).toBe(true)
    expect(again.allowed('/repo', 'shell')).toBe(false)
    const saved = JSON.parse(await readFile(path.join(dir, 'state', 'project-mcp.json'), 'utf8'))
    expect(saved).toEqual({ version: 1, folders: { '/repo': { use: ['db'], skip: ['shell'] } } })
  })

  it('read a file another version wrote without trusting what it cannot read', async () => {
    expect(
      parseProjectMcpFile({
        folders: {
          '/repo': { all: true, use: ['db', 3], skip: 'x' },
          '/bad': 'yes',
          '/other': { all: 'yes', use: [], skip: ['web'] },
        },
      }),
    ).toEqual({
      version: 1,
      folders: {
        '/repo': { all: true, use: ['db'], skip: [] },
        '/other': { use: [], skip: ['web'] },
      },
    })
    expect(typeof parseProjectMcpFile({ folders: [] })).toBe('string')
  })

  it('never let a folder named like an object property through', async () => {
    const store = await answers()
    expect(store.allowed('constructor', 'toString')).toBeNull()
    expect(store.held('__proto__', ['db'])).toEqual(['db'])
  })
})
