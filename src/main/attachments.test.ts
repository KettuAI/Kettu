import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentGrant } from '@shared/attachments'
import { grantClipboardFiles, grantPaths, uriListPaths } from './attachments'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'overbench-grants-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('grantPaths', () => {
  it('grants files and folders, and hands the host the paths the renderer never sees', async () => {
    const file = path.join(dir, 'notes.md')
    const folder = path.join(dir, 'src')
    await writeFile(file, '# Notes\n')
    await mkdir(folder)
    const handed: AttachmentGrant[][] = []
    const granted = await grantPaths([file, folder], async (grants) => {
      handed.push(grants)
    })
    expect(granted).toEqual([
      { grantId: expect.any(String), name: 'notes.md', kind: 'file', size: 8 },
      { grantId: expect.any(String), name: 'src', kind: 'folder', size: null },
    ])
    expect(handed).toEqual([
      [
        { grantId: granted[0]!.grantId, path: file, kind: 'file' },
        { grantId: granted[1]!.grantId, path: folder, kind: 'folder' },
      ],
    ])
    expect(JSON.stringify(granted)).not.toContain(dir)
  })

  it('keeps the order and leaves a gap for a path that is gone', async () => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'a')
    const handed: AttachmentGrant[] = []
    const granted = await grantPaths([path.join(dir, 'gone.txt'), file], async (grants) => {
      handed.push(...grants)
    })
    expect(granted[0]).toBeNull()
    expect(granted[1]).toMatchObject({ name: 'a.txt', kind: 'file' })
    expect(handed.map((grant) => grant.path)).toEqual([file])
  })

  it('grants nothing when the host does not take the grants', async () => {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'a')
    await expect(grantPaths([file], () => Promise.reject(new Error('host down')))).rejects.toThrow(
      'host down',
    )
  })
})

describe('uriListPaths', () => {
  const one = path.resolve('/a/one.txt')
  const two = path.resolve('/a/two.txt')
  const uri = (file: string) => pathToFileURL(file).href

  it('reads the file URIs of a list with CRLF or LF line breaks, skipping comments', () => {
    expect(uriListPaths(`${uri(one)}\r\n# a comment\r\n${uri(two)}\r\n`)).toEqual([one, two])
    expect(uriListPaths(`${uri(one)}\n\n${uri(two)}`)).toEqual([one, two])
  })

  it('skips URIs that name no local file', () => {
    expect(
      uriListPaths('https://example.com/a.txt\nfile://server.example/share/a.txt\nnot a uri'),
    ).toEqual(process.platform === 'win32' ? ['\\\\server.example\\share\\a.txt'] : [])
  })

  it('decodes spaces and non-ASCII names', () => {
    const file = path.resolve('/a/b c/日本 語.md')
    expect(uri(file)).toContain('%20')
    expect(uriListPaths(uri(file))).toEqual([file])
  })
})

describe('grantClipboardFiles', () => {
  const list = (...paths: string[]) => paths.map((p) => pathToFileURL(p).href).join('\r\n')

  it('grants every copied file and folder in the order copied when the list holds the pasted one', async () => {
    const first = path.join(dir, 'b 日本.md')
    const folder = path.join(dir, 'sub folder')
    const last = path.join(dir, 'a.txt')
    await writeFile(first, 'hello')
    await mkdir(folder)
    await writeFile(last, 'a')
    const handed: AttachmentGrant[] = []
    const granted = await grantClipboardFiles(first, list(first, folder, last), async (grants) => {
      handed.push(...grants)
    })
    expect(granted?.map((item) => [item.name, item.kind])).toEqual([
      ['b 日本.md', 'file'],
      ['sub folder', 'folder'],
      ['a.txt', 'file'],
    ])
    expect(handed.map((grant) => grant.path)).toEqual([first, folder, last])
  })

  it('grants nothing from a list that does not hold the pasted file', async () => {
    const pasted = path.join(dir, 'pasted.txt')
    const other = path.join(dir, 'other.txt')
    await writeFile(pasted, 'p')
    await writeFile(other, 'o')
    const grant = vi.fn(async () => {})
    await expect(grantClipboardFiles(pasted, list(other), grant)).resolves.toBeNull()
    expect(grant).not.toHaveBeenCalled()
  })

  it('grants nothing without a list on the clipboard', async () => {
    const grant = vi.fn(async () => {})
    await expect(grantClipboardFiles(path.join(dir, 'a.txt'), null, grant)).resolves.toBeNull()
    expect(grant).not.toHaveBeenCalled()
  })

  it('leaves out a copied file that is gone', async () => {
    const pasted = path.join(dir, 'a.txt')
    await writeFile(pasted, 'a')
    const granted = await grantClipboardFiles(
      pasted,
      list(pasted, path.join(dir, 'gone.txt')),
      async () => {},
    )
    expect(granted?.map((item) => item.name)).toEqual(['a.txt'])
  })
})
