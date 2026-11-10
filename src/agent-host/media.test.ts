import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaService } from './media'

const PNG = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')

describe('MediaService.open', () => {
  let base: string
  let root: string
  let outside: string
  let thread: string

  const service = () =>
    new MediaService({
      platform: process.platform === 'win32' ? 'win32' : 'darwin',
      homeDir: base,
      names: async (_sessionId, text) => thread.includes(text),
      grant: () => {},
    })

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-media-')))
    root = path.join(base, 'project')
    outside = path.join(base, 'shots')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(path.join(root, 'inside.png'), PNG)
    await writeFile(path.join(outside, 'before.png'), PNG)
    thread = ''
  })

  afterEach(() => rm(base, { recursive: true, force: true }))

  it('grants a file in the session folder', async () => {
    expect((await service().open(root, 'inside.png', 's')).kind).toBe('granted')
  })

  it('refuses a file outside the folder that the thread does not name', async () => {
    const result = await service().open(root, path.join(outside, 'before.png'), 's')
    expect(result.kind).toBe('forbidden')
  })

  it('grants a file outside the folder that the thread names in full', async () => {
    const file = path.join(outside, 'before.png')
    thread = `Saved to \`${file}\`.`
    expect((await service().open(root, file, 's')).kind).toBe('granted')
  })

  it('grants a file outside the folder whose folder and name the thread names', async () => {
    const folder = outside + path.sep
    thread = `Saved in \`${folder}\`: \`before.png\`.`
    expect((await service().open(root, folder + 'before.png', 's')).kind).toBe('granted')
  })

  it('refuses a file whose folder the thread names without its name', async () => {
    const folder = outside + path.sep
    thread = `Saved in \`${folder}\`.`
    expect((await service().open(root, folder + 'before.png', 's')).kind).toBe('forbidden')
  })

  it('refuses a file whose name the thread names without its folder', async () => {
    thread = 'Saved `before.png`.'
    const result = await service().open(root, path.join(outside, 'before.png'), 's')
    expect(result.kind).toBe('forbidden')
  })

  it('refuses a folder the thread names only as a shorter path', async () => {
    thread = `Saved in \`${base + path.sep}\`: \`before.png\`.`
    const result = await service().open(root, path.join(outside, 'before.png'), 's')
    expect(result.kind).toBe('forbidden')
  })
})
