import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_SOURCES,
  GITHUB_SOURCE,
  parseSourceList,
  RELEASE_KEYS,
  SOURCES_KEYS,
  verifySourceList,
  verifyUpdateFile,
  withGitHubLast,
} from './update-sources'

function keyPair(): { privateKey: KeyObject; raw: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { x } = publicKey.export({ format: 'jwk' })
  return { privateKey, raw: Buffer.from(x!, 'base64url').toString('base64') }
}

const release = keyPair()
const nextRelease = keyPair()
const sources = keyPair()
const stranger = keyPair()

const YML = Buffer.from(
  'version: 0.0.45\nfiles:\n  - url: Kettu-0.0.45-arm64.dmg\n    sha512: c2hhNTEy\n',
)

function signatureFile(file: Buffer, key: KeyObject): Buffer {
  return Buffer.from(`${sign(null, file, key).toString('base64')}\n`)
}

const LIST = {
  serial: 3,
  sources: [
    { id: 'kettu', url: 'https://download.kettu.sh' },
    { id: 'github', url: 'https://github.com/KettuAI/Kettu/releases' },
  ],
  connectTimeoutSeconds: 10,
  stallSeconds: 15,
}

function signedList(document: unknown, key: KeyObject = sources.privateKey): string {
  const bytes = Buffer.from(JSON.stringify(document))
  return JSON.stringify({
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, key).toString('base64url'),
  })
}

const read = (document: unknown, minSerial = 0) =>
  parseSourceList(signedList(document), minSerial, [sources.raw])

describe('update file signatures', () => {
  const keys = [release.raw, nextRelease.raw]

  it('accepts a file signed with the current or the next release key', () => {
    expect(verifyUpdateFile(YML, signatureFile(YML, release.privateKey), keys)).toBe(true)
    expect(verifyUpdateFile(YML, signatureFile(YML, nextRelease.privateKey), keys)).toBe(true)
  })

  it('accepts the signature without its closing newline', () => {
    const file = signatureFile(YML, release.privateKey)
    expect(verifyUpdateFile(YML, file.subarray(0, file.length - 1), keys)).toBe(true)
  })

  it('refuses a file changed after it was signed', () => {
    const signature = signatureFile(YML, release.privateKey)
    const tampered = Buffer.from(YML.toString().replace('0.0.45', '0.0.46'))
    expect(verifyUpdateFile(tampered, signature, keys)).toBe(false)
    const extra = Buffer.concat([YML, Buffer.from('\n')])
    expect(verifyUpdateFile(extra, signature, keys)).toBe(false)
  })

  it('refuses a signature under any other key', () => {
    expect(verifyUpdateFile(YML, signatureFile(YML, stranger.privateKey), keys)).toBe(false)
    expect(verifyUpdateFile(YML, signatureFile(YML, sources.privateKey), keys)).toBe(false)
  })

  it('refuses a signature file in any other form', () => {
    const base64 = sign(null, YML, release.privateKey).toString('base64')
    for (const text of [
      '',
      base64.replace(/=+$/, ''),
      `${base64}\r\n`,
      `${base64}\n\n`,
      ` ${base64}`,
      sign(null, YML, release.privateKey).toString('base64url'),
      Buffer.alloc(64).toString('base64'),
      `${base64.slice(0, -4)}AAAA`,
    ]) {
      expect(verifyUpdateFile(YML, Buffer.from(text), keys)).toBe(false)
    }
  })

  it('builds in a current and a next key for releases and for the list, all different', () => {
    expect(RELEASE_KEYS).toHaveLength(2)
    expect(SOURCES_KEYS).toHaveLength(2)
    expect(new Set([...RELEASE_KEYS, ...SOURCES_KEYS]).size).toBe(4)
    for (const key of [...RELEASE_KEYS, ...SOURCES_KEYS]) {
      expect(Buffer.from(key, 'base64')).toHaveLength(32)
    }
  })
})

describe('the source list', () => {
  it('reads a list signed with the sources key', () => {
    const result = read(LIST)
    expect(result).toMatchObject({ ok: true, list: LIST })
  })

  it('accepts the next sources key as well', () => {
    const body = signedList(LIST, nextRelease.privateKey)
    expect(parseSourceList(body, 0, [sources.raw, nextRelease.raw]).ok).toBe(true)
  })

  it('refuses a list signed with another key, or changed after signing', () => {
    expect(parseSourceList(signedList(LIST, stranger.privateKey), 0, [sources.raw]).ok).toBe(false)
    expect(parseSourceList(signedList(LIST, release.privateKey), 0, [sources.raw]).ok).toBe(false)
    const envelope = JSON.parse(signedList(LIST)) as { payload: string; signature: string }
    const changed = Buffer.from(JSON.stringify({ ...LIST, serial: 4 })).toString('base64url')
    const result = verifySourceList({ ...envelope, payload: changed }, 0, [sources.raw])
    expect(result).toEqual({ ok: false, reason: 'its signature does not hold' })
  })

  it('refuses an envelope that is not the signed form', () => {
    const envelope = JSON.parse(signedList(LIST)) as { payload: string; signature: string }
    for (const body of [
      'not json',
      '[]',
      JSON.stringify({ payload: envelope.payload }),
      JSON.stringify({ ...envelope, payload: `${envelope.payload}==` }),
      JSON.stringify({ ...envelope, signature: Buffer.from('x').toString('base64url') }),
      JSON.stringify(LIST),
    ]) {
      expect(parseSourceList(body, 0, [sources.raw]).ok).toBe(false)
    }
  })

  it('never goes back to an older serial', () => {
    expect(read(LIST, 4)).toEqual({ ok: false, reason: 'its serial 3 is older than 4' })
    expect(read(LIST, 3).ok).toBe(true)
    expect(read(LIST, BUILT_IN_SOURCES.serial).ok).toBe(true)
  })

  it('refuses a serial that is not a positive integer', () => {
    for (const serial of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(read({ ...LIST, serial }).ok).toBe(false)
    }
  })

  it('moves GitHub to the end, or adds it there', () => {
    const first = read({
      ...LIST,
      sources: [
        { id: 'gh', url: 'https://github.com/KettuAI/Kettu/releases' },
        { id: 'kettu', url: 'https://download.kettu.sh' },
        { id: 'vps', url: 'https://mirror.example.com/kettu' },
      ],
    })
    expect(first.ok && first.list.sources).toEqual([
      { id: 'kettu', url: 'https://download.kettu.sh' },
      { id: 'vps', url: 'https://mirror.example.com/kettu' },
      GITHUB_SOURCE,
    ])
    const without = read({ ...LIST, sources: [{ id: 'kettu', url: 'https://download.kettu.sh' }] })
    expect(without.ok && without.list.sources).toEqual([
      { id: 'kettu', url: 'https://download.kettu.sh' },
      GITHUB_SOURCE,
    ])
    expect(withGitHubLast([])).toEqual([GITHUB_SOURCE])
    expect(BUILT_IN_SOURCES.sources.at(-1)).toBe(GITHUB_SOURCE)
  })

  it('takes only https sources without a query, fragment, credentials or trailing slash', () => {
    for (const url of [
      'http://download.kettu.sh',
      'https://download.kettu.sh/',
      'https://download.kettu.sh?from=app',
      'https://download.kettu.sh#latest',
      'https://user:secret@download.kettu.sh',
      'https://user@download.kettu.sh',
      'ftp://download.kettu.sh',
      'https://download.kettu.sh/a b',
      ' https://download.kettu.sh',
      'https:\\\\download.kettu.sh',
      'download.kettu.sh',
      '',
      42,
    ]) {
      const result = read({ ...LIST, sources: [{ id: 'kettu', url }] })
      expect(result.ok, String(url)).toBe(false)
    }
  })

  it('takes one to eight sources with ids of lowercase letters, digits and hyphens', () => {
    expect(read({ ...LIST, sources: [] }).ok).toBe(false)
    const nine = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      url: `https://s${i}.example`,
    }))
    expect(read({ ...LIST, sources: nine }).ok).toBe(false)
    expect(read({ ...LIST, sources: nine.slice(0, 8) }).ok).toBe(true)
    for (const id of ['Kettu', 'kettu_1', '', 'a'.repeat(33), 7, undefined]) {
      expect(read({ ...LIST, sources: [{ id, url: 'https://download.kettu.sh' }] }).ok).toBe(false)
    }
    expect(read({ ...LIST, sources: 'kettu' }).ok).toBe(false)
  })

  it('takes timeouts of whole seconds from 1 to 120', () => {
    for (const value of [0, 121, 1.5, '10', null]) {
      expect(read({ ...LIST, connectTimeoutSeconds: value }).ok).toBe(false)
      expect(read({ ...LIST, stallSeconds: value }).ok).toBe(false)
    }
    const edges = read({ ...LIST, connectTimeoutSeconds: 1, stallSeconds: 120 })
    expect(edges.ok && [edges.list.connectTimeoutSeconds, edges.list.stallSeconds]).toEqual([
      1, 120,
    ])
  })

  it('ignores fields it does not know', () => {
    const result = read({
      ...LIST,
      region: 'CN',
      sources: [{ id: 'kettu', url: 'https://download.kettu.sh', weight: 2 }],
    })
    expect(result.ok && result.list.sources[0]).toEqual({
      id: 'kettu',
      url: 'https://download.kettu.sh',
    })
  })

  it('checks a kept list again as it checks a fetched one', () => {
    const envelope = JSON.parse(signedList(LIST)) as { payload: string; signature: string }
    expect(verifySourceList(envelope, 0, [sources.raw]).ok).toBe(true)
    expect(verifySourceList(envelope, 0, [stranger.raw]).ok).toBe(false)
    expect(verifySourceList(null, 0, [sources.raw]).ok).toBe(false)
  })
})
