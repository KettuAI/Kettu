import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contentHash, contentPath, putContent, removeContent, sweepContent } from './content'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-content-'))
  dirs.push(dir)
  return path.join(dir, 'content')
}

describe('artifact content files', () => {
  it('names a file by the SHA-256 of the HTML, in a folder of its first two hex characters', () => {
    const hash = contentHash('<p>hi</p>')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(contentHash('<p>hï</p>')).not.toBe(hash)
    expect(contentPath('/data', hash)).toBe(path.join('/data', hash.slice(0, 2), `${hash}.html`))
    expect(() => contentPath('/data', '../../etc/passwd')).toThrow('Not a content hash')
  })

  it('writes a file once, whole, and leaves no temporary file', () => {
    const dir = folder()
    const hash = contentHash('<p>café</p>')
    putContent(dir, hash, '<p>café</p>')
    putContent(dir, hash, '<p>café</p>')
    expect(readFileSync(contentPath(dir, hash), 'utf8')).toBe('<p>café</p>')
    expect(readdirSync(path.dirname(contentPath(dir, hash)))).toEqual([`${hash}.html`])
  })

  it('removes files and the folders they leave empty', () => {
    const dir = folder()
    const hashes = ['<p>a</p>', '<p>b</p>'].map((html) => {
      const hash = contentHash(html)
      putContent(dir, hash, html)
      return hash
    })
    removeContent(dir, [hashes[0]!])
    expect(existsSync(contentPath(dir, hashes[0]!))).toBe(false)
    expect(existsSync(contentPath(dir, hashes[1]!))).toBe(true)
    removeContent(dir, hashes)
    expect(readdirSync(dir)).toEqual([])
  })

  it('sweeps the files no version names and the temporary ones, and nothing else', () => {
    const dir = folder()
    expect(sweepContent(dir, new Set())).toBe(0)
    const kept = contentHash('<p>kept</p>')
    const orphan = contentHash('<p>orphan</p>')
    putContent(dir, kept, '<p>kept</p>')
    putContent(dir, orphan, '<p>orphan</p>')
    const temp = `${contentPath(dir, kept)}.ffee.tmp`
    writeFileSync(temp, '<p>ke')
    const other = path.join(path.dirname(temp), 'readme.txt')
    writeFileSync(other, 'not a version')

    expect(sweepContent(dir, new Set([kept]))).toBe(2)
    expect(existsSync(contentPath(dir, orphan))).toBe(false)
    expect(existsSync(path.dirname(contentPath(dir, orphan)))).toBe(
      orphan.slice(0, 2) === kept.slice(0, 2),
    )
    expect(existsSync(temp)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(readFileSync(contentPath(dir, kept), 'utf8')).toBe('<p>kept</p>')
  })
})
