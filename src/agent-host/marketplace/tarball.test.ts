import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { COMMIT, tarball } from '../testing/tarball'
import {
  checkedEntries,
  entryPath,
  folderFiles,
  githubSource,
  readTarball,
  tarballUrl,
  tarCommit,
} from './tarball'

describe('githubSource', () => {
  it('reads a repository, a folder at a ref, and a link to a SKILL.md', () => {
    expect(githubSource('https://github.com/anthropics/skills')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: null,
      path: '',
    })
    expect(githubSource('https://github.com/anthropics/skills.git/')).toMatchObject({
      repo: 'skills',
    })
    expect(githubSource('https://github.com/anthropics/skills/tree/main/skills/pdf')).toEqual({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
      path: 'skills/pdf',
    })
    expect(
      githubSource('https://github.com/anthropics/skills/blob/v1/skills/pdf/SKILL.md'),
    ).toMatchObject({ ref: 'v1', path: 'skills/pdf' })
  })

  it('refuses anything else', () => {
    for (const url of [
      'http://github.com/a/b',
      'https://gitlab.com/a/b',
      'https://github.com/a',
      'https://user:pw@github.com/a/b',
      'https://github.com/a/b/issues/1',
      'https://github.com/a/b/tree/main/x%5C..%5Csecrets',
      'https://github.com/a/../b',
      'not a url',
    ]) {
      expect(githubSource(url), url).toBeNull()
    }
  })

  it('downloads the ref, or the default branch', () => {
    expect(tarballUrl({ owner: 'a', repo: 'b', ref: null, path: '' })).toBe(
      'https://codeload.github.com/a/b/tar.gz/HEAD',
    )
    expect(tarballUrl({ owner: 'a', repo: 'b', ref: 'v1.0', path: 'x' })).toBe(
      'https://codeload.github.com/a/b/tar.gz/v1.0',
    )
  })
})

describe('entryPath', () => {
  it('takes the path inside the top folder and refuses one that climbs out', () => {
    expect(entryPath('skills-main/skills/pdf/SKILL.md')).toBe('skills/pdf/SKILL.md')
    expect(entryPath('skills-main/skills/')).toBe('skills')
    expect(entryPath('skills-main/../etc/passwd')).toBeNull()
    expect(entryPath('/etc/passwd')).toBeNull()
    expect(entryPath('top/a\\b')).toBeNull()
    expect(entryPath('top/con:out')).toBeNull()
    expect(entryPath('top/trailing.')).toBeNull()
    expect(entryPath('SKILL.md')).toBeNull()
  })
})

describe('readTarball', () => {
  it('reads the commit from the pax header and every file under its repository path', async () => {
    const tar = tarball([
      { name: 'skills-main/', type: '5' },
      { name: 'skills-main/skills/pdf/SKILL.md', data: '---\nname: pdf\n---' },
      { name: 'skills-main/skills/pdf/scripts/run.py', data: 'print(1)' },
      { name: 'skills-main/skills/pdf/link', type: '2', link: '/etc/passwd' },
    ])
    expect(tarCommit(tar)).toBe(COMMIT)
    const read = await readTarball(gzipSync(tar), { unpackedBytes: 1024 * 1024 })
    expect(read.commit).toBe(COMMIT)
    expect(read.files.map((file) => file.path).sort()).toEqual([
      'skills/pdf/SKILL.md',
      'skills/pdf/scripts/run.py',
    ])
    expect(read.links).toEqual(['skills/pdf/link'])
  })

  it('refuses an archive with a path that leaves its folder, or larger than the limit', async () => {
    const climbing = tarball([{ name: 'skills-main/../../evil.sh', data: 'rm -rf ~' }])
    await expect(readTarball(gzipSync(climbing), { unpackedBytes: 1024 * 1024 })).rejects.toThrow(
      /unsafe path/,
    )
    const big = tarball([{ name: 'r/big.bin', data: 'x'.repeat(64 * 1024) }])
    await expect(readTarball(gzipSync(big), { unpackedBytes: 16 * 1024 })).rejects.toThrow(
      /larger than/,
    )
    await expect(readTarball(Buffer.from('not gzip'), { unpackedBytes: 1024 })).rejects.toThrow(
      /not a tarball/,
    )
  })
})

describe('folderFiles', () => {
  const read = checkedEntries(
    [
      { path: 'r/skills/a/SKILL.md', type: 'file', data: Buffer.from('a') },
      { path: 'r/skills/a/big.bin', type: 'file', data: Buffer.alloc(2048) },
      { path: 'r/skills/b/SKILL.md', type: 'file', data: Buffer.from('b') },
      { path: 'r/skills/b/out', type: 'symlink' },
    ],
    null,
  )

  it("takes one folder's files by their paths inside it", () => {
    expect(
      folderFiles(read, 'skills/a', { files: 10, bytes: 4096 }).map((file) => file.path),
    ).toEqual(['SKILL.md', 'big.bin'])
  })

  it('refuses a folder holding a link, or past the file and byte caps', () => {
    expect(() => folderFiles(read, 'skills/b', { files: 10, bytes: 4096 })).toThrow(/link/)
    expect(() => folderFiles(read, 'skills/a', { files: 1, bytes: 4096 })).toThrow(/files/)
    expect(() => folderFiles(read, 'skills/a', { files: 10, bytes: 1024 })).toThrow(/larger/)
  })
})
