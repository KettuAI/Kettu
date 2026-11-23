import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from './log'
import {
  diskImageFor,
  downloadDiskImage,
  type DiskImage,
  type DiskImageJob,
  type DownloadFile,
} from './update-dmg'
import { GITHUB_SOURCE, SourceRun, type UpdateSource } from './update-sources'

const KETTU: UpdateSource = { id: 'kettu', url: 'https://download.kettu.sh' }
const MIRROR: UpdateSource = { id: 'mirror', url: 'https://mirror.example' }

const NAME = 'Kettu-0.2.0-arm64.dmg'
const GOOD = Buffer.from('the verified disk image')
const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64')
const IMAGE: DiskImage = { name: NAME, sha512: sha512(GOOD) }

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} }

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'kettu-dmg-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

function job(download: DownloadFile, over: Partial<DiskImageJob> = {}): DiskImageJob {
  return {
    run: new SourceRun([KETTU, MIRROR, GITHUB_SOURCE], 0, 5_000),
    version: '0.2.0',
    image: IMAGE,
    folder,
    download,
    signal: new AbortController().signal,
    githubOnly: () => false,
    setLeave: () => {},
    progress: () => {},
    log: quiet,
    ...over,
  }
}

/** Where `source` is asked for the image. */
const at = (source: UpdateSource): string => `${source.url}/download/v0.2.0/${NAME}`

/** Sources that each write their bytes as the file, or fail with their error. */
function serving(sources: Record<string, Buffer | Error>, asked: string[] = []): DownloadFile {
  return async (url, destination) => {
    asked.push(url)
    const served = Object.entries(sources).find(([base]) => url.startsWith(`${base}/`))?.[1]
    if (served instanceof Error) throw served
    if (!served) throw new Error('not found')
    await writeFile(destination, served)
  }
}

/** A source that sends nothing until it is stopped. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    else signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
}

describe('diskImageFor', () => {
  const files = [
    { url: 'Kettu-0.2.0-arm64-mac.zip', sha512: 'zip-arm' },
    { url: 'Kettu-0.2.0-arm64.dmg', sha512: 'dmg-arm' },
    { url: 'Kettu-0.2.0-x64.dmg', sha512: 'dmg-x64' },
  ]

  it('takes the disk image of the architecture with its checksum', () => {
    expect(diskImageFor(files, 'arm64')).toEqual({
      name: 'Kettu-0.2.0-arm64.dmg',
      sha512: 'dmg-arm',
    })
    expect(diskImageFor(files, 'x64')).toEqual({ name: 'Kettu-0.2.0-x64.dmg', sha512: 'dmg-x64' })
  })

  it('finds none for another architecture or an update without one', () => {
    expect(diskImageFor(files, 'ia32')).toBeNull()
    expect(diskImageFor([files[0]!], 'arm64')).toBeNull()
  })

  it('skips an entry without a checksum or whose name is not a plain file name', () => {
    expect(diskImageFor([{ url: 'Kettu-0.2.0-arm64.dmg' }], 'arm64')).toBeNull()
    expect(diskImageFor([{ url: '../Kettu-0.2.0-arm64.dmg', sha512: 'x' }], 'arm64')).toBeNull()
    expect(diskImageFor([{ url: 'a/Kettu-0.2.0-arm64.dmg', sha512: 'x' }], 'arm64')).toBeNull()
  })
})

describe('downloadDiskImage', () => {
  it('accepts a file that matches the checksum and keeps it under its name', async () => {
    const asked: string[] = []
    const path = await downloadDiskImage(job(serving({ [KETTU.url]: GOOD }, asked)))
    expect(path).toBe(join(folder, NAME))
    expect(await readFile(path)).toEqual(GOOD)
    expect(asked).toEqual([at(KETTU)])
    expect(await readdir(folder)).toEqual([NAME])
  })

  it('deletes a file that does not match and moves on to the next source', async () => {
    const asked: string[] = []
    const download = serving({ [KETTU.url]: Buffer.from('tampered'), [MIRROR.url]: GOOD }, asked)
    const path = await downloadDiskImage(job(download))
    expect(asked).toEqual([at(KETTU), at(MIRROR)])
    expect(await readFile(path)).toEqual(GOOD)
    expect(await readdir(folder)).toEqual([NAME])
  })

  it('never opens a file when every source fails, and leaves nothing behind', async () => {
    const download = serving({
      [KETTU.url]: Buffer.from('tampered'),
      [MIRROR.url]: new Error('Cannot download, status 503'),
      [GITHUB_SOURCE.url]: Buffer.from('also tampered'),
    })
    await expect(downloadDiskImage(job(download))).rejects.toThrow(/checksum/)
    expect(await readdir(folder)).toEqual([])
  })

  it('fails with the last source error when no source can be reached', async () => {
    const download = serving({
      [KETTU.url]: new Error('first'),
      [MIRROR.url]: new Error('second'),
      [GITHUB_SOURCE.url]: new Error('last'),
    })
    await expect(downloadDiskImage(job(download))).rejects.toThrow('last')
  })

  it('moves on from a source that makes no progress', async () => {
    const asked: string[] = []
    const download: DownloadFile = async (url, destination, { signal }) => {
      asked.push(url)
      if (url === at(KETTU)) {
        await untilAborted(signal)
      }
      await writeFile(destination, GOOD)
    }
    const run = new SourceRun([KETTU, MIRROR], 0, 20)
    await downloadDiskImage(job(download, { run }))
    expect(asked).toEqual([at(KETTU), at(MIRROR)])
  })

  it('tries no further source once the user cancels', async () => {
    const user = new AbortController()
    const asked: string[] = []
    const download: DownloadFile = async (url, destination) => {
      asked.push(url)
      await writeFile(destination, 'half')
      user.abort()
      throw new Error('cancelled')
    }
    await expect(downloadDiskImage(job(download, { signal: user.signal }))).rejects.toThrow()
    expect(asked).toHaveLength(1)
    expect(await readdir(folder)).toEqual([])
  })

  it('continues on GitHub when GitHub only is chosen during the download', async () => {
    let githubOnly = false
    let leave: (() => void) | null = null
    const asked: string[] = []
    const download: DownloadFile = async (url, destination, { signal }) => {
      asked.push(url)
      if (url === at(KETTU)) {
        githubOnly = true
        leave?.()
        await untilAborted(signal)
      }
      await writeFile(destination, GOOD)
    }
    await downloadDiskImage(
      job(download, {
        githubOnly: () => githubOnly,
        setLeave: (next) => {
          leave = next
        },
      }),
    )
    expect(asked).toEqual([at(KETTU), at(GITHUB_SOURCE)])
  })

  it('opens a kept image again once it still matches, without downloading', async () => {
    await writeFile(join(folder, NAME), GOOD)
    const asked: string[] = []
    const path = await downloadDiskImage(job(serving({ [KETTU.url]: GOOD }, asked)))
    expect(path).toBe(join(folder, NAME))
    expect(asked).toEqual([])
  })

  it('replaces a kept image that no longer matches', async () => {
    await writeFile(join(folder, NAME), 'damaged')
    const path = await downloadDiskImage(job(serving({ [KETTU.url]: GOOD })))
    expect(await readFile(path)).toEqual(GOOD)
  })

  it('removes the older images and half-written files, and nothing else', async () => {
    await writeFile(join(folder, 'Kettu-0.1.0-arm64.dmg'), 'old')
    await writeFile(join(folder, 'Kettu-0.1.9-arm64.dmg.part'), 'half')
    await writeFile(join(folder, 'notes.txt'), 'mine')
    await downloadDiskImage(job(serving({ [KETTU.url]: GOOD })))
    expect((await readdir(folder)).sort()).toEqual([NAME, 'notes.txt'])
  })
})
