// `market-keys.json`: what the user filled in for the inputs of the servers the Marketplace
// installed, API tokens among them, by server id. Kept apart from the settings, encrypted by the
// system in the desktop app, and in a file only the user can read either way; the daemon, which has
// no such encryption, keeps them in that file alone. The values go to the agent host only: a client
// learns which inputs are set, never what they hold.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  specInputs,
  type MarketKeyState,
  type MarketServer,
  type McpSpec,
} from '@shared/marketplace'
import { quarantineFile, readJsonFile, writeFileAtomic } from './json-file'
import type { Logger } from './log'
import type { IdentityCipher } from './remote-identity'
import { MAX_MARKET_SERVERS } from './settings-schema'

/** The values of each server's inputs, by server id and input name, for the agent host alone. */
export type MarketKeyValues = Record<string, Record<string, string>>

const VERSION = 1
const FILE_MODE = 0o600
/** The most a value may hold, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 8192
const MAX_SERVER_ID = 200
const MAX_INPUT_NAME = 128
const MAX_INPUTS = 64
const MAX_SEALED_CHARS = 64 * 1024 * 1024

export function marketKeysFile(dataPath: string): string {
  return join(dataPath, 'market-keys.json')
}

/** A call refused, with the code a device is answered: bad input, or a store that cannot keep keys. */
export class MarketKeysError extends Error {
  constructor(
    readonly code: 'invalid_params' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'MarketKeysError'
  }
}

const invalid = (message: string): MarketKeysError => new MarketKeysError('invalid_params', message)

type Keys = Map<string, Map<string, string>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A value an input may hold; a header's must stay on one line, which would else start another. */
function valueProblem(value: string, header: boolean): string | null {
  if (value.length === 0) return 'is empty; null clears an input'
  if (Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) return `is over ${MAX_KEY_BYTES} bytes`
  if (value.includes('\0')) return 'holds a NUL character'
  if (header && /[\r\n]/.test(value)) return 'holds a line break, which a header cannot'
  return null
}

/** The inputs of a spec by name, with whether each is a header. */
function inputsOf(spec: McpSpec): Map<string, boolean> {
  return new Map(specInputs(spec).map((input) => [input.name, spec.type === 'http']))
}

function parseValues(raw: unknown): Keys | null {
  if (!isRecord(raw)) return null
  const entries = Object.entries(raw)
  if (entries.length > MAX_MARKET_SERVERS) return null
  const keys: Keys = new Map()
  for (const [id, inputs] of entries) {
    if (id.length === 0 || id.length > MAX_SERVER_ID || !isRecord(inputs)) return null
    const values = Object.entries(inputs)
    if (values.length > MAX_INPUTS) return null
    const kept = new Map<string, string>()
    for (const [name, value] of values) {
      if (name.length === 0 || name.length > MAX_INPUT_NAME || typeof value !== 'string') {
        return null
      }
      if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) return null
      kept.set(name, value)
    }
    if (kept.size > 0) keys.set(id, kept)
  }
  return keys
}

function toObject(keys: Keys): MarketKeyValues {
  return Object.fromEntries(
    [...keys].map(([id, inputs]) => [id, Object.fromEntries(inputs)] as const),
  )
}

/** The keys without those of servers and inputs the settings no longer have. */
function pruned(keys: Keys, servers: readonly MarketServer[]): Keys {
  const next: Keys = new Map()
  for (const server of servers) {
    const inputs = keys.get(server.id)
    if (!inputs) continue
    const declared = inputsOf(server.spec)
    const kept = new Map([...inputs].filter(([name]) => declared.has(name)))
    if (kept.size > 0) next.set(server.id, kept)
  }
  return next
}

function sameKeys(a: Keys, b: Keys): boolean {
  return JSON.stringify(toObject(a)) === JSON.stringify(toObject(b))
}

/** A patch's shape, before it is checked against the server it names. */
function parsePatch(raw: unknown): { serverId: string; values: [string, string | null][] } {
  if (!isRecord(raw)) throw invalid('The keys must be an object')
  const extra = Object.keys(raw).find((key) => key !== 'serverId' && key !== 'values')
  if (extra) throw invalid(`Unknown field "${extra}"`)
  const { serverId, values } = raw
  if (typeof serverId !== 'string' || serverId.length === 0 || serverId.length > MAX_SERVER_ID) {
    throw invalid('"serverId" must name a server')
  }
  if (!isRecord(values)) throw invalid('"values" must be an object')
  const entries = Object.entries(values)
  if (entries.length > MAX_INPUTS) throw invalid(`"values" may set at most ${MAX_INPUTS} inputs`)
  for (const [name, value] of entries) {
    if (value !== null && typeof value !== 'string') {
      throw invalid(`"values.${name}" must be a string, or null to clear it`)
    }
  }
  return { serverId, values: entries as [string, string | null][] }
}

interface KeysFile {
  version: typeof VERSION
  encrypted: boolean
  /** The system's encryption of the values' JSON in base64, or the values themselves. */
  values: string | MarketKeyValues
}

export interface MarketKeysOptions {
  file: string
  cipher: IdentityCipher
  /** Keeps keys in the file alone where the system cannot encrypt them: the daemon's way. */
  plainTextAllowed: boolean
  /** The servers the settings keep now. */
  servers(): readonly MarketServer[]
  /** The values changed, for the agent host. */
  changed(values: MarketKeyValues): void
  log: Logger
}

/** Owns `market-keys.json`. Every change runs in turn, so none is lost to another. */
export class MarketKeys {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly options: MarketKeysOptions,
    private keys: Keys,
    /** Why the file is not written this run, as when this system cannot decrypt it now. */
    private readonly readOnly: string | null,
  ) {}

  static async load(options: MarketKeysOptions): Promise<MarketKeys> {
    const { file, cipher, log } = options
    const read = await readJsonFile(file)
    let keys: Keys = new Map()
    let readOnly: string | null = null
    let resave = false
    const quarantine = async (reason: string): Promise<void> => {
      log.warn(`${file} is invalid: ${reason}`)
      try {
        log.warn(`Moved the invalid file to ${await quarantineFile(file)}`)
      } catch (error) {
        log.error(`Could not move the invalid ${file} aside`, error)
        readOnly = 'Kettu could not read its keys file'
      }
    }
    // The parser's message quotes the text, which holds keys.
    if (read.kind === 'unreadable') {
      await quarantine(read.reason.startsWith('Invalid JSON') ? 'not JSON' : read.reason)
    } else if (read.kind === 'ok') {
      const raw = read.value
      const version = isRecord(raw) ? raw.version : undefined
      if (typeof version === 'number' && version > VERSION) {
        log.warn(`${file} comes from a newer version of Kettu; its keys are not used`)
        readOnly = 'The keys were saved by a newer version of Kettu'
      } else if (!isRecord(raw) || version !== VERSION || typeof raw.encrypted !== 'boolean') {
        await quarantine('not a keys file')
      } else if (!raw.encrypted) {
        const values = parseValues(raw.values)
        if (values) keys = values
        else await quarantine('the values are not valid')
        // Encrypted from now on where the system can.
        resave = values !== null && !options.plainTextAllowed
      } else if (!(await cipher.available())) {
        log.warn(`${file} is encrypted, which this system cannot undo now; its keys are not used`)
        readOnly = 'This system cannot decrypt the keys now'
      } else {
        try {
          const sealed = raw.values
          if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_CHARS) {
            throw new Error('the values are not sealed')
          }
          const { result, shouldReEncrypt } = await cipher.decrypt(Buffer.from(sealed, 'base64'))
          let decrypted: unknown
          try {
            decrypted = JSON.parse(result)
          } catch {
            throw new Error('the values do not decrypt to JSON')
          }
          const values = parseValues(decrypted)
          if (!values) throw new Error('the values are not valid')
          keys = values
          resave = shouldReEncrypt
        } catch (error) {
          await quarantine((error as Error)?.message ?? String(error))
        }
      }
    }
    const store = new MarketKeys(options, keys, readOnly)
    if (resave && !readOnly) {
      void store
        .run(() => store.save(store.keys))
        .catch((error: unknown) => {
          log.error(`Could not write ${file}`, error)
        })
    }
    store.prune()
    return store
  }

  /** Which inputs of each server have a value; never the values. */
  state(): MarketKeyState {
    return Object.fromEntries([...this.keys].map(([id, inputs]) => [id, [...inputs.keys()]]))
  }

  /** The values themselves, for the agent host alone. */
  values(): MarketKeyValues {
    return toObject(this.keys)
  }

  /**
   * Fills or clears inputs of a server the settings keep, from an untrusted patch; each name must
   * be one the server's spec declares. Settles once the file holds the change.
   */
  async set(raw: unknown): Promise<MarketKeyState> {
    const patch = parsePatch(raw)
    return this.run(async () => {
      if (this.readOnly) throw new MarketKeysError('unavailable', this.readOnly)
      const server = this.options.servers().find((each) => each.id === patch.serverId)
      if (!server) throw invalid(`No server "${patch.serverId}" is installed`)
      const declared = inputsOf(server.spec)
      const inputs = new Map(this.keys.get(server.id))
      for (const [name, value] of patch.values) {
        const header = declared.get(name)
        if (header === undefined) throw invalid(`"${server.name}" has no input "${name}"`)
        if (value === null) {
          inputs.delete(name)
          continue
        }
        const problem = valueProblem(value, header)
        if (problem) throw invalid(`The value of "${name}" ${problem}`)
        inputs.set(name, value)
      }
      const next: Keys = new Map(this.keys)
      if (inputs.size > 0) next.set(server.id, inputs)
      else next.delete(server.id)
      await this.commit(pruned(next, this.options.servers()), true)
      return this.state()
    })
  }

  /** Drops the keys of servers and inputs the settings no longer have, as after an uninstall. */
  prune(): void {
    void this.run(async () => {
      const next = pruned(this.keys, this.options.servers())
      if (!sameKeys(next, this.keys)) await this.commit(next, false)
    }).catch((error: unknown) => {
      this.options.log.error(`Could not write ${this.options.file}`, error)
    })
  }

  /** Resolves once every change asked for so far is written. */
  async flush(): Promise<void> {
    await this.queue
  }

  /**
   * Takes `next`. A change the user made is kept only once written; a removal is used at once, so
   * the agent host never keeps the keys of a server that is gone.
   */
  private async commit(next: Keys, writeFirst: boolean): Promise<void> {
    if (writeFirst) await this.save(next)
    this.keys = next
    this.options.changed(this.values())
    if (!writeFirst && !this.readOnly) await this.save(next)
  }

  private async save(keys: Keys): Promise<void> {
    const { file, cipher, plainTextAllowed } = this.options
    if (keys.size === 0) {
      await rm(file, { force: true })
      return
    }
    const encrypted = await cipher.available()
    if (!encrypted && !plainTextAllowed) {
      throw new MarketKeysError('unavailable', 'This system cannot encrypt keys, so none are kept')
    }
    const values = toObject(keys)
    const stored: KeysFile = {
      version: VERSION,
      encrypted,
      values: encrypted
        ? (await cipher.encrypt(JSON.stringify(values))).toString('base64')
        : values,
    }
    await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`, FILE_MODE)
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => {})
    return next
  }
}
