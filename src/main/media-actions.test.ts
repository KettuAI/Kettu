import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaGrantRecord, MediaType } from '@shared/media'

const electron = vi.hoisted(() => ({
  downloads: '/downloads',
  save: vi.fn(),
  write: vi.fn(),
  decode: vi.fn(),
  showItem: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => electron.downloads },
  dialog: { showSaveDialog: electron.save },
  clipboard: { write: electron.write },
  ClipboardItem: class {
    constructor(readonly items: Record<string, Blob>) {}
  },
  nativeImage: { createFromBuffer: electron.decode },
  shell: { showItemInFolder: electron.showItem },
}))

const { carriedMedia, copyImage, revealMedia, saveMediaAs, savedName } =
  await import('./media-actions')
const { MediaGrants } = await import('./media')

const WINDOW = {} as Electron.BrowserWindow
const PNG = Buffer.from('\x89PNG\r\n\x1a\nrest', 'latin1')
const token = (n: number) => String.fromCharCode(97 + n).repeat(26)
const url = (n: number, name = 'shot.png') => `kettu-media://${token(n)}/${name}?v=1`

let dir: string
let shot: string
let clip: string

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(os.tmpdir(), 'kettu-media-actions-')))
  shot = join(dir, 'shot.png')
  clip = join(dir, 'clip.mp4')
  await writeFile(shot, PNG)
  await writeFile(clip, 'not a picture')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  electron.decode.mockImplementation((buffer: Buffer) => ({
    isEmpty: () => buffer.length === 0 || buffer[0] !== 0x89,
    toPNG: () => Buffer.concat([Buffer.from('drawn:'), buffer]),
  }))
})

/** The one picture written to the clipboard, as the PNG bytes it holds. */
async function copied(): Promise<string> {
  expect(electron.write).toHaveBeenCalledTimes(1)
  const [items] = electron.write.mock.calls[0] as [{ items: Record<string, Blob> }[]]
  expect(items).toHaveLength(1)
  expect(Object.keys(items[0]!.items)).toEqual(['image/png'])
  const png = items[0]!.items['image/png']!
  expect(png.type).toBe('image/png')
  return Buffer.from(await png.arrayBuffer()).toString('latin1')
}

function grants(): InstanceType<typeof MediaGrants> {
  const kept = new MediaGrants(0)
  const record = (n: number, path: string, mimeType: MediaType): MediaGrantRecord => ({
    token: token(n),
    path,
    mimeType,
    sessionId: 's1',
  })
  kept.add(record(0, shot, 'image/png'))
  kept.add(record(1, clip, 'video/mp4'))
  return kept
}

const carried = (mimeType = 'image/png', bytes: Uint8Array = PNG, name = 'Image 1') => ({
  bytes,
  mimeType,
  name,
})

describe('each action', () => {
  it('refuses a media URL main does not grant, and a path', async () => {
    for (const source of [url(5), shot, `file://${shot}`, 42, null]) {
      await expect(copyImage(source, grants())).rejects.toThrow()
      await expect(saveMediaAs(WINDOW, source, grants())).rejects.toThrow()
      await expect(revealMedia(source, grants())).rejects.toThrow()
    }
    expect(electron.write).not.toHaveBeenCalled()
    expect(electron.save).not.toHaveBeenCalled()
    expect(electron.showItem).not.toHaveBeenCalled()
  })
})

describe('copyImage', () => {
  it('puts a granted picture on the clipboard as PNG', async () => {
    await copyImage(url(0), grants())
    expect(electron.decode).toHaveBeenCalledWith(PNG)
    expect(await copied()).toBe(`drawn:${PNG.toString('latin1')}`)
  })

  it('takes the bytes the thread carries', async () => {
    const bytes = Buffer.from('\x89PNG carried', 'latin1')
    await copyImage(carried('image/png', new Uint8Array(bytes)), grants())
    expect(await copied()).toBe(`drawn:${bytes.toString('latin1')}`)
  })

  it('copies pictures only', async () => {
    await expect(copyImage(url(1, 'clip.mp4'), grants())).rejects.toThrow('Only a picture')
    await expect(copyImage(carried('video/mp4'), grants())).rejects.toThrow('Only a picture')
    expect(electron.write).not.toHaveBeenCalled()
  })

  it('says so when Electron cannot decode the format', async () => {
    const webp = Buffer.from('RIFF....WEBP', 'latin1')
    await expect(copyImage(carried('image/webp', webp), grants())).rejects.toThrow(
      "can't be copied",
    )
    expect(electron.write).not.toHaveBeenCalled()
  })
})

describe('saveMediaAs', () => {
  it('copies a granted file where the dialog says, offering its own name in Downloads', async () => {
    const to = join(dir, 'saved.png')
    electron.save.mockResolvedValue({ canceled: false, filePath: to })
    expect(await saveMediaAs(WINDOW, url(0), grants())).toBe(true)
    expect(electron.save).toHaveBeenCalledWith(WINDOW, {
      defaultPath: join('/downloads', 'shot.png'),
    })
    expect(await readFile(to)).toEqual(PNG)
  })

  it('writes the bytes the thread carries, named with their type', async () => {
    const to = join(dir, 'carried.png')
    electron.save.mockResolvedValue({ canceled: false, filePath: to })
    expect(await saveMediaAs(null, carried(), grants())).toBe(true)
    expect(electron.save).toHaveBeenCalledWith({ defaultPath: join('/downloads', 'Image 1.png') })
    expect(await readFile(to)).toEqual(PNG)
  })

  it('writes nothing when the dialog is cancelled', async () => {
    electron.save.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await saveMediaAs(WINDOW, carried(), grants())).toBe(false)
  })
})

describe('revealMedia', () => {
  it('shows the granted file in the file manager', async () => {
    await revealMedia(url(1, 'clip.mp4'), grants())
    expect(electron.showItem).toHaveBeenCalledWith(clip)
  })
})

describe('carriedMedia', () => {
  it('takes bytes, a media type and a name', () => {
    expect(carriedMedia(carried())).toEqual(carried())
  })

  it.each([
    ['nothing', null],
    ['no bytes', { ...carried(), bytes: 'abc' }],
    ['empty bytes', carried('image/png', new Uint8Array())],
    ['more than 20 MB', carried('image/png', new Uint8Array(20 * 1024 * 1024 + 1))],
    ['a type that is no media', carried('text/html')],
    ['a name with a NUL', carried('image/png', PNG, 'a\0b')],
    ['too long a name', carried('image/png', PNG, 'a'.repeat(256))],
  ])('refuses %s', (_, value) => {
    expect(() => carriedMedia(value)).toThrow()
  })
})

describe('savedName', () => {
  it('adds the extension the type takes, unless the name has it', () => {
    expect(savedName({ name: 'Image 1', mimeType: 'image/png' })).toBe('Image 1.png')
    expect(savedName({ name: 'chart.PNG', mimeType: 'image/png' })).toBe('chart.PNG')
    expect(savedName({ name: 'photo', mimeType: 'image/jpeg' })).toBe('photo.jpg')
    expect(savedName({ name: 'take', mimeType: 'video/quicktime' })).toBe('take.mov')
  })

  it('makes a name any file system takes, never empty', () => {
    expect(savedName({ name: 'a/b:c', mimeType: 'image/gif' })).toBe('a-b-c.gif')
    expect(savedName({ name: '', mimeType: 'image/webp' })).toBe('image.webp')
    expect(savedName({ name: '', mimeType: 'image/x-unknown' })).toBe('image')
  })
})
