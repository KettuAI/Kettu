import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MarketServer } from '@shared/marketplace'
import type { Logger } from './log'
import { MarketKeys, MarketKeysError, marketKeysFile, type MarketKeyValues } from './market-keys'
import type { IdentityCipher } from './remote-identity'

const TOKEN = 'ghp_0123456789abcdefSECRET'

const github: MarketServer = {
  id: 'io.github.github/github-mcp-server',
  name: 'github',
  title: 'GitHub',
  source: 'registry',
  version: '1.2.0',
  spec: {
    type: 'http',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: [
      { name: 'X-Client', value: 'kettu' },
      { name: 'Authorization', input: true, secret: true, required: true },
    ],
  },
  agents: 'all',
  on: true,
}

const notes: MarketServer = {
  id: 'manual:0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'notes',
  title: 'Notes',
  source: 'manual',
  version: null,
  spec: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@example/notes-mcp'],
    env: [
      { name: 'NOTES_TOKEN', input: true, secret: true, required: true },
      { name: 'NOTES_DIR', input: true, secret: false, required: false },
    ],
  },
  agents: ['codex'],
  on: true,
}

// Flips every byte, so the file never shows a value as it was given.
const flip = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a))

function cipher(available = true): IdentityCipher {
  return {
    available: async () => available,
    encrypt: async (text) => flip(Buffer.from(text, 'utf8')),
    decrypt: async (encrypted) => ({
      result: flip(encrypted).toString('utf8'),
      shouldReEncrypt: false,
    }),
    plainText: () => false,
  }
}

const NO_ENCRYPTION: IdentityCipher = {
  available: async () => false,
  encrypt: () => Promise.reject(new Error('no encryption')),
  decrypt: () => Promise.reject(new Error('no encryption')),
  plainText: () => true,
}

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let dir: string
let servers: MarketServer[]
let pushed: MarketKeyValues[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-market-keys-'))
  servers = [github, notes]
  pushed = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function load(
  options: { cipher?: IdentityCipher; plainTextAllowed?: boolean } = {},
): Promise<MarketKeys> {
  return MarketKeys.load({
    file: marketKeysFile(dir),
    cipher: options.cipher ?? cipher(),
    plainTextAllowed: options.plainTextAllowed ?? false,
    servers: () => servers,
    changed: (values) => pushed.push(values),
    log: silent,
  })
}

const fileText = (): Promise<string> => readFile(marketKeysFile(dir), 'utf8')

describe('the Marketplace key store', () => {
  it('keeps values encrypted and reads them back', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: `Bearer ${TOKEN}` } })
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'n0tes', NOTES_DIR: '/tmp/n' } })
    expect(await fileText()).not.toContain(TOKEN)
    const again = await load()
    expect(again.values()).toEqual({
      [github.id]: { Authorization: `Bearer ${TOKEN}` },
      [notes.id]: { NOTES_TOKEN: 'n0tes', NOTES_DIR: '/tmp/n' },
    })
  })

  it('tells clients which inputs are set, never their values', async () => {
    const keys = await load()
    const state = await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    expect(state).toEqual({ [github.id]: ['Authorization'] })
    expect(JSON.stringify(keys.state())).not.toContain(TOKEN)
  })

  it('hands every change to the agent host', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    await keys.set({ serverId: github.id, values: { Authorization: null } })
    expect(pushed).toEqual([{ [github.id]: { Authorization: TOKEN } }, {}])
    expect(keys.state()).toEqual({})
  })

  it.each([
    ['a patch that is no object', 'github'],
    ['an unknown field', { serverId: github.id, values: {}, extra: 1 }],
    ['values that are no object', { serverId: github.id, values: [TOKEN] }],
    ['a value that is no string', { serverId: github.id, values: { Authorization: 1 } }],
    ['a server not installed', { serverId: 'io.github.other/server', values: { A: 'x' } }],
    ['an input the spec does not declare', { serverId: github.id, values: { Cookie: 'x' } }],
    ['a fixed header', { serverId: github.id, values: { 'X-Client': 'other' } }],
    ['an empty value', { serverId: github.id, values: { Authorization: '' } }],
    ['a value over 8 KB', { serverId: github.id, values: { Authorization: 'a'.repeat(8193) } }],
    [
      'a header value with a line break',
      { serverId: github.id, values: { Authorization: 'a\nb' } },
    ],
    ['a value with a NUL', { serverId: notes.id, values: { NOTES_TOKEN: 'a\0b' } }],
  ])('rejects %s and keeps nothing', async (_, patch) => {
    const keys = await load()
    await expect(keys.set(patch)).rejects.toBeInstanceOf(MarketKeysError)
    expect(keys.state()).toEqual({})
    expect(pushed).toEqual([])
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it('takes a value of 8 KB, counted in bytes', async () => {
    const keys = await load()
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'a'.repeat(8192) } })
    await expect(
      keys.set({
        serverId: notes.id,
        values: { NOTES_TOKEN: String.fromCharCode(0xe9).repeat(4097) },
      }),
    ).rejects.toBeInstanceOf(MarketKeysError)
  })

  it('drops the keys of a server that is uninstalled', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'n0tes' } })
    servers = [notes]
    keys.prune()
    await keys.flush()
    expect(keys.values()).toEqual({ [notes.id]: { NOTES_TOKEN: 'n0tes' } })
    expect(pushed.at(-1)).toEqual({ [notes.id]: { NOTES_TOKEN: 'n0tes' } })
    expect((await load()).values()).toEqual({ [notes.id]: { NOTES_TOKEN: 'n0tes' } })
  })

  it('drops the value of an input the spec no longer declares', async () => {
    const keys = await load()
    await keys.set({ serverId: notes.id, values: { NOTES_TOKEN: 'n0tes', NOTES_DIR: '/tmp/n' } })
    const spec = notes.spec as Extract<MarketServer['spec'], { type: 'stdio' }>
    servers = [github, { ...notes, spec: { ...spec, env: [spec.env[0]!] } }]
    keys.prune()
    await keys.flush()
    expect(keys.state()).toEqual({ [notes.id]: ['NOTES_TOKEN'] })
  })

  it('removes the file once no key is left, and prunes on load', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    servers = []
    const again = await load()
    await again.flush()
    expect(again.values()).toEqual({})
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('writes a file only the user can read', async () => {
    const keys = await load()
    await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
    expect((await stat(marketKeysFile(dir))).mode & 0o777).toBe(0o600)
  })

  it('refuses to keep keys where the system cannot encrypt them', async () => {
    const keys = await load({ cipher: cipher(false) })
    await expect(
      keys.set({ serverId: github.id, values: { Authorization: TOKEN } }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(keys.state()).toEqual({})
    await expect(stat(marketKeysFile(dir))).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')(
    "keeps them in the user's file alone where that is allowed, as under the daemon",
    async () => {
      const keys = await load({ cipher: NO_ENCRYPTION, plainTextAllowed: true })
      await keys.set({ serverId: github.id, values: { Authorization: TOKEN } })
      expect((await stat(marketKeysFile(dir))).mode & 0o777).toBe(0o600)
      const again = await load({ cipher: NO_ENCRYPTION, plainTextAllowed: true })
      expect(again.values()).toEqual({ [github.id]: { Authorization: TOKEN } })
    },
  )

  it('moves an invalid file aside and starts with no keys', async () => {
    await writeFile(marketKeysFile(dir), '{"version":1,"encrypted":false,"values":[1]}')
    const keys = await load()
    expect(keys.values()).toEqual({})
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith('market-keys.corrupt-'))).toBe(true)
  })

  it('leaves a file from a newer version as it is and refuses to change it', async () => {
    const text = '{"version":2,"encrypted":true,"values":"x"}'
    await writeFile(marketKeysFile(dir), text)
    const keys = await load()
    await expect(
      keys.set({ serverId: github.id, values: { Authorization: TOKEN } }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(await fileText()).toBe(text)
  })
})
