import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readImport } from './import'

let dir: string
let site: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-import-'))
  site = path.join(dir, 'My site')
  mkdirSync(path.join(site, 'css'), { recursive: true })
  mkdirSync(path.join(site, '.git'))
  writeFileSync(path.join(site, 'index.html'), '<title>Launch plan</title><p data-page="A">')
  writeFileSync(path.join(site, 'css', 'app.css'), 'p{}')
  writeFileSync(path.join(site, '.git', 'HEAD'), 'ref')
  writeFileSync(path.join(site, '.env'), 'KEY=1')
  writeFileSync(path.join(dir, 'secret.txt'), 'secret')
  symlinkSync(path.join(dir, 'secret.txt'), path.join(site, 'secret.txt'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('importing a folder', () => {
  it('takes its files, but not hidden ones or links, with the title of its page', async () => {
    const read = await readImport(site)
    if ('failed' in read) throw new Error(read.failed)
    expect(read.files.map((f) => f.path)).toEqual(['css/app.css', 'index.html'])
    expect(read.title).toBe('Launch plan')
    expect(read.pages).toBe(1)
  })

  it('refuses a folder without index.html, or with a name no artifact file may have', async () => {
    rmSync(path.join(site, 'index.html'))
    expect(await readImport(site)).toEqual({ failed: 'no_index' })
    writeFileSync(path.join(site, 'index.html'), '<p>')
    writeFileSync(path.join(site, '_kettu.js'), '1')
    expect(await readImport(site)).toEqual({ failed: 'bad_name' })
  })

  it('refuses more files than a version holds', async () => {
    for (let i = 0; i < 256; i++) writeFileSync(path.join(site, `f${i}.txt`), '')
    expect(await readImport(site)).toEqual({ failed: 'too_many' })
  })

  it('takes one HTML file as the entry page', async () => {
    const read = await readImport(path.join(site, 'index.html'))
    if ('failed' in read) throw new Error(read.failed)
    expect(read.files.map((f) => f.path)).toEqual(['index.html'])
  })
})
