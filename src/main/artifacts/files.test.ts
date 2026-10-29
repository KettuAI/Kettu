import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactContentResult } from '@shared/host-control'

const electron = vi.hoisted(() => ({
  downloads: '/downloads',
  save: vi.fn(),
  open: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => electron.downloads },
  dialog: { showSaveDialog: electron.save, showOpenDialog: electron.open },
  shell: { openExternal: electron.openExternal },
  protocol: {},
}))

const { ArtifactFiles, parseVersion, safeName } = await import('./files')

const ID = 'art_01JB2QZ8X4K7M9N3P5R6S8T0VW'
const WINDOW = {} as Electron.BrowserWindow

describe('parseVersion', () => {
  it('takes an artifact id and a whole version from 1', () => {
    expect(parseVersion(ID, 3)).toEqual({ id: ID, version: 3 })
  })

  it.each([
    ['an id of the wrong form', 'art_x', 1, 'Not an artifact id'],
    ['an id that is no string', 5, 1, 'Not an artifact id'],
    ['version 0', ID, 0, 'Not a version'],
    ['a fraction', ID, 1.5, 'Not a version'],
    ['a string', ID, '1', 'Not a version'],
    ['too large a number', ID, 2 ** 53, 'Not a version'],
  ])('refuses %s', (_, id, version, message) => {
    expect(() => parseVersion(id, version)).toThrow(message)
  })
})

describe('safeName', () => {
  it('replaces what a file name cannot hold on any platform', () => {
    expect(safeName('Q3: plan/draft <v2>? "final" | a*b\\c', ID)).toBe(
      'Q3- plan-draft -v2-- -final- - a-b-c',
    )
    expect(safeName('tab\there\u0000\u007f', ID)).toBe('tab-here--')
  })

  it('trims dots and spaces at the ends, which Windows drops', () => {
    expect(safeName('  ..Report.. . ', ID)).toBe('Report')
    expect(safeName('a.b', ID)).toBe('a.b')
  })

  it('caps the name at 100 characters, without splitting one', () => {
    expect(safeName('a'.repeat(300), ID)).toBe('a'.repeat(100))
    expect(Array.from(safeName('😀'.repeat(300), ID))).toHaveLength(100)
    expect(safeName(`${'a'.repeat(99)}. b`, ID)).toBe('a'.repeat(99))
  })

  it('falls back to the id when nothing is left', () => {
    expect(safeName('', ID)).toBe(ID)
    expect(safeName(' . . ', ID)).toBe(ID)
  })
})

describe('ArtifactFiles', () => {
  let dir: string
  let contentDir: string
  let stored: string
  let found: ArtifactContentResult
  const importFile = vi.fn()
  const content = vi.fn((): Promise<ArtifactContentResult> => Promise.resolve(found))

  const files = () =>
    new ArtifactFiles({ content, contentDir, importFile, tempDir: path.join(dir, 'tmp') })

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-artifact-files-'))
    contentDir = path.join(dir, 'content')
    await mkdir(path.join(contentDir, 'ab'), { recursive: true })
    stored = path.join(contentDir, 'ab', 'ab01.html')
    await writeFile(stored, '<p>stored</p>')
    found = { kind: 'found', path: stored, version: 2, title: 'Q3: plan' }
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('openExternal', () => {
    it('opens a copy in the temporary folder, named by the artifact and version', async () => {
      await files().openExternal(ID, 2)
      const copy = path.join(dir, 'tmp', `${ID}-v2.html`)
      expect(content).toHaveBeenCalledWith(ID, 2)
      expect(await readFile(copy, 'utf8')).toBe('<p>stored</p>')
      expect(electron.openExternal).toHaveBeenCalledWith(pathToFileURL(copy).href)
      expect(await readdir(path.join(dir, 'tmp'))).toEqual([`${ID}-v2.html`])
    })

    it('refuses what is not an artifact version before it asks the host', async () => {
      await expect(files().openExternal('../x', 1)).rejects.toThrow('Not an artifact id')
      await expect(files().openExternal(ID, 0)).rejects.toThrow('Not a version')
      expect(content).not.toHaveBeenCalled()
      expect(electron.openExternal).not.toHaveBeenCalled()
    })

    it('refuses a version the host does not know, cannot name, or names outside its folder', async () => {
      found = { kind: 'not_found' }
      await expect(files().openExternal(ID, 1)).rejects.toThrow('Not found')
      found = { kind: 'failed' }
      await expect(files().openExternal(ID, 1)).rejects.toThrow('did not answer')
      found = { kind: 'found', path: path.join(dir, 'secret.txt'), version: 1, title: 'x' }
      await expect(files().openExternal(ID, 1)).rejects.toThrow('Not found')
      expect(electron.openExternal).not.toHaveBeenCalled()
    })
  })

  describe('export', () => {
    it('saves the stored HTML where the dialog says, named after the title', async () => {
      const target = path.join(dir, 'out.html')
      electron.save.mockResolvedValue({ canceled: false, filePath: target })
      expect(await files().export(WINDOW, ID, 2)).toBe(true)
      expect(await readFile(target, 'utf8')).toBe('<p>stored</p>')
      expect(electron.save).toHaveBeenCalledWith(WINDOW, {
        defaultPath: path.join('/downloads', 'Q3- plan.html'),
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      })
    })

    it('writes nothing when the user cancels, and shows the dialog without a window', async () => {
      electron.save.mockResolvedValue({ canceled: true, filePath: '' })
      expect(await files().export(null, ID, 2)).toBe(false)
      expect(electron.save).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: expect.any(String) }),
      )
      expect(electron.save).toHaveBeenCalledTimes(1)
    })

    it('refuses what is not an artifact version before it shows a dialog', async () => {
      await expect(files().export(WINDOW, ID, -1)).rejects.toThrow('Not a version')
      found = { kind: 'not_found' }
      await expect(files().export(WINDOW, ID, 1)).rejects.toThrow('Not found')
      expect(electron.save).not.toHaveBeenCalled()
    })
  })

  describe('import', () => {
    it('hands the chosen path to the host with the project, and returns its answer', async () => {
      electron.open.mockResolvedValue({ canceled: false, filePaths: ['/files/plan.html'] })
      importFile.mockResolvedValue({ id: ID })
      expect(await files().import(WINDOW, '/projects/a')).toEqual({ id: ID })
      expect(importFile).toHaveBeenCalledWith('/files/plan.html', '/projects/a')
      expect(electron.open).toHaveBeenCalledWith(WINDOW, {
        properties: ['openFile', 'dontAddToRecent'],
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      })
    })

    it('imports into No project for a null project', async () => {
      electron.open.mockResolvedValue({ canceled: false, filePaths: ['/files/plan.htm'] })
      importFile.mockResolvedValue({ failed: 'too_large' })
      expect(await files().import(null, null)).toEqual({ failed: 'too_large' })
      expect(importFile).toHaveBeenCalledWith('/files/plan.htm', null)
    })

    it('returns null and imports nothing when the user cancels', async () => {
      electron.open.mockResolvedValue({ canceled: true, filePaths: [] })
      expect(await files().import(WINDOW, null)).toBeNull()
      expect(importFile).not.toHaveBeenCalled()
    })

    it.each([
      ['a number', 5],
      ['undefined', undefined],
      ['an empty string', ''],
      ['a string over 4,096 characters', 'x'.repeat(4_097)],
      ['an object', {}],
    ])('refuses %s as the project, before it shows a dialog', async (_, project) => {
      await expect(files().import(WINDOW, project)).rejects.toThrow('Not a project')
      expect(electron.open).not.toHaveBeenCalled()
      expect(importFile).not.toHaveBeenCalled()
    })

    it('takes a project of 4,096 characters', async () => {
      electron.open.mockResolvedValue({ canceled: true, filePaths: [] })
      expect(await files().import(WINDOW, 'x'.repeat(4_096))).toBeNull()
    })
  })
})
