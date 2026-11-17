// The files Kettu reads for a session's agent, such as the file an edit request would change: only
// inside the folder the session works in, as the Files pane reads one, and never through a link
// out of it.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import { FilesService } from './files'
import { SessionFiles } from './session-files'

const platform: Platform = process.platform === 'win32' ? 'win32' : 'darwin'

describe('SessionFiles', () => {
  let base: string
  let project: string
  let outside: string
  let folders: Record<string, string>

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'kettu-session-files-')))
    project = path.join(base, 'project')
    outside = path.join(base, 'outside')
    await mkdir(path.join(project, 'src'), { recursive: true })
    await mkdir(outside)
    await writeFile(path.join(project, 'src', 'a.txt'), 'one\ntwo\n')
    await writeFile(path.join(outside, 'secret.txt'), 'secret\n')
    folders = { s1: project }
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const service = () => {
    const files = new FilesService({
      exec: async () => ({ code: 0, stdout: '', stderr: '', failure: null, message: '' }),
      platform,
      media: async () => null,
      describeMedia: async () => null,
      trash: async () => {},
    })
    return new SessionFiles({
      platform,
      folder: (id) => folders[id] ?? null,
      read: (folder, relative) => files.read(folder, relative, true),
    })
  }

  it("reads a text file in the session's folder by its absolute path", async () => {
    expect(await service().text('s1', path.join(project, 'src', 'a.txt'))).toBe('one\ntwo\n')
  })

  it('reads nothing outside the folder, however the path leads there', async () => {
    const reads = service()
    const secret = path.join(outside, 'secret.txt')
    expect(await reads.text('s1', secret)).toBeNull()
    expect(await reads.text('s1', path.join(project, '..', 'outside', 'secret.txt'))).toBeNull()
    expect(
      await reads.text('s1', path.join(project, 'src', '..', '..', 'outside', 'secret.txt')),
    ).toBeNull()
    // A sibling folder that only starts with the folder's name.
    await mkdir(`${project}-other`)
    await writeFile(path.join(`${project}-other`, 'a.txt'), 'other\n')
    expect(await reads.text('s1', path.join(`${project}-other`, 'a.txt'))).toBeNull()
    expect(await reads.text('s1', 'src/a.txt')).toBeNull()
    expect(await reads.text('s1', `${path.join(project, 'src', 'a.txt')}\0`)).toBeNull()
  })

  it('reads nothing through a link out of the folder', async () => {
    if (process.platform === 'win32') return
    await symlink(outside, path.join(project, 'link'))
    await symlink(path.join(outside, 'secret.txt'), path.join(project, 'secret-link.txt'))
    const reads = service()
    expect(await reads.text('s1', path.join(project, 'link', 'secret.txt'))).toBeNull()
    expect(await reads.text('s1', path.join(project, 'secret-link.txt'))).toBeNull()
  })

  it('reads nothing for a session that is not held, or of a file that is not text', async () => {
    const reads = service()
    expect(await reads.text('other', path.join(project, 'src', 'a.txt'))).toBeNull()
    expect(await reads.text('s1', path.join(project, 'src', 'missing.txt'))).toBeNull()
    expect(await reads.text('s1', path.join(project, 'src'))).toBeNull()
    await writeFile(path.join(project, 'bin.dat'), Buffer.from([0x61, 0, 0x62]))
    expect(await reads.text('s1', path.join(project, 'bin.dat'))).toBeNull()
    await writeFile(path.join(project, 'latin.txt'), Buffer.from([0x63, 0xe9]))
    expect(await reads.text('s1', path.join(project, 'latin.txt'))).toBeNull()
  })
})
