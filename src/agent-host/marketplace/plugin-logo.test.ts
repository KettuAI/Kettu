import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOGO_MAX_BYTES, readLogo } from './plugin-logo'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe('readLogo', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kettu-logo-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const file = async (name: string, data: Buffer | string) => {
    const at = path.join(dir, name)
    await writeFile(at, data)
    return at
  }

  it('reads a png and an svg as data URLs', async () => {
    expect(await readLogo(await file('logo.png', PNG))).toBe(
      `data:image/png;base64,${PNG.toString('base64')}`,
    )
    const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'
    expect(await readLogo(await file('logo.svg', svg))).toBe(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    )
  })

  it('reads no file that is not an image of its type', async () => {
    expect(await readLogo(await file('key.png', '-----BEGIN OPENSSH PRIVATE KEY-----'))).toBeNull()
    expect(await readLogo(await file('notes.svg', 'token=abc'))).toBeNull()
    expect(await readLogo(await file('id_rsa', PNG))).toBeNull()
    expect(await readLogo(await file('logo.jpg', PNG))).toBeNull()
  })

  it('reads no relative, missing, folder or oversized path', async () => {
    expect(await readLogo('assets/logo.png')).toBeNull()
    expect(await readLogo(path.join(dir, 'missing.png'))).toBeNull()
    await mkdir(path.join(dir, 'folder.png'))
    expect(await readLogo(path.join(dir, 'folder.png'))).toBeNull()
    const big = Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)])
    expect(await readLogo(await file('big.png', big))).toBeNull()
  })
})
