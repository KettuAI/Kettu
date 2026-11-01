import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentFolders } from './agent-folders'
import { SettingsStore } from './settings'

const trashed: string[] = []

let dir: string
let root: string

beforeEach(async () => {
  dir = await mkdtemp(join(os.tmpdir(), 'kettu-agent-folders-'))
  root = join(dir, 'agent-config')
  trashed.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const settings = await SettingsStore.load(dir)
  const trash = async (folder: string) => void trashed.push(folder)
  return { settings, folders: new AgentFolders(settings, root, trash) }
}

describe('AgentFolders', () => {
  it('makes a folder of its own in the data folder for a new agent', async () => {
    const { settings, folders } = await setup()
    const id = await folders.add('claude-code', ' Work ', null)
    expect(id).toBe('claude-code~work')
    const configDir = join(root, 'claude-code~work')
    expect(settings.get().addedAgents).toEqual([{ id, name: 'Work', configDir, created: true }])
    const info = await stat(configDir)
    expect(info.isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o700)
    // A second agent of the same name gets an id of its own.
    expect(await folders.add('claude-code', 'Work', null)).toBe('claude-code~work-2')
  })

  it('takes an existing folder only as the dialog returned it', async () => {
    const { settings, folders } = await setup()
    const picked = join(dir, 'picked')
    await mkdir(picked)
    await expect(folders.add('codex', 'Client', picked)).rejects.toThrow('in the dialog')
    folders.remember(picked)
    const id = await folders.add('codex', 'Client', picked)
    expect(settings.get().addedAgents).toEqual([
      { id, name: 'Client', configDir: picked, created: false },
    ])
  })

  it('refuses a folder another agent has: an added one, a default one, or the data folder', async () => {
    const { folders } = await setup()
    const picked = join(dir, 'picked')
    await mkdir(picked)
    folders.remember(picked)
    await folders.add('codex', 'Client', picked)
    await expect(folders.add('claude-code', 'Again', picked)).rejects.toThrow('Client')
    const home = join(os.homedir(), '.codex')
    folders.remember(home)
    await expect(folders.add('codex', 'Home', home)).rejects.toThrow('Codex')
    folders.remember(root)
    await expect(folders.add('claude-code', 'Root', root)).rejects.toThrow('Kettu')
  })

  it('adds agents only to a harness that carries them, with a name it takes', async () => {
    const { folders } = await setup()
    await expect(folders.add('opencode', 'Work', null)).rejects.toThrow('cannot be added')
    await expect(folders.add('nope', 'Work', null)).rejects.toThrow('cannot be added')
    await expect(folders.add('codex', '', null)).rejects.toThrow('1 to 40')
  })

  it('renames an added agent', async () => {
    const { settings, folders } = await setup()
    const id = await folders.add('codex', 'Client', null)
    folders.rename(id, 'Client B')
    expect(settings.get().addedAgents[0]?.name).toBe('Client B')
    expect(() => folders.rename('codex~missing', 'X')).toThrow('No added agent')
    expect(() => folders.rename('../x', 'X')).toThrow('Unknown agent')
  })

  it('trashes only a folder Kettu made, and only when asked', async () => {
    const { settings, folders } = await setup()
    const made = await folders.add('codex', 'Made', null)
    const kept = await folders.add('codex', 'Kept', null)
    const picked = join(dir, 'picked')
    await mkdir(picked)
    folders.remember(picked)
    const theirs = await folders.add('claude-code', 'Theirs', picked)
    await folders.remove(made, true)
    await folders.remove(kept, false)
    await folders.remove(theirs, true)
    expect(trashed).toEqual([join(root, made)])
    expect(settings.get().addedAgents).toEqual([])
    await expect(folders.remove(made, true)).rejects.toThrow('No added agent')
    await expect(folders.remove('codex', 'yes')).rejects.toThrow('"trash" must be a boolean')
  })
})
