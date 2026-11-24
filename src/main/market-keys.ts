// `market-keys.json`: what the user filled in for the inputs of the servers the Marketplace
// installed, API tokens among them, and each OAuth server's sign-in, by server id. Kept apart from
// the settings, encrypted by the system in the desktop app, and in a file only the user can read
// either way; the daemon, which has no such encryption, keeps them in that file alone. Both go to
// the agent host only: a client learns which inputs are set, never what they hold, and nothing of
// a sign-in.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_ID } from '@shared/plugins'
import {
  specInputs,
  type MarketKeyState,
  type MarketServer,
  type McpSpec,
} from '@shared/marketplace'
import { t, tEnglish } from './i18n'
import { quarantineFile, readJsonFile, writeFileAtomic } from './json-file'
import type { Logger } from './log'
import type { IdentityCipher } from './remote-identity'
import { MAX_MARKET_SERVERS } from './settings-schema'

/** The values of each server's inputs, by server id and input name, for the agent host alone. */
export type MarketKeyValues = Record<string, Record<string, string>>

/** The whole store as `host:market-keys` carries it: input values, and OAuth sign-ins by server id. */
export interface MarketKeysPush {
  values: MarketKeyValues
  oauth: Record<string, string>
  agentEnv: Record<string, Record<string, string>>
  /** The secrets the plugins declare, by plugin id then key; only that plugin's script reads one. */
  pluginSecrets: Record<string, Record<string, string>>
}

// Version 1 held only the input values.
const VERSION = 3
const FILE_MODE = 0o600
/** The most a value may hold, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 8192
const MAX_SERVER_ID = 200
const MAX_INPUT_NAME = 128
const MAX_INPUTS = 64
/** The most plugins that may keep secrets. */
const MAX_SECRET_PLUGINS = 1000
const MAX_SEALED_CHARS = 64 * 1024 * 1024
/** The most a server's OAuth sign-in may hold, in UTF-8 bytes. */
export const MAX_OAUTH_BYTES = 64 * 1024

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

/** What the store holds: input values, and the agent host's opaque OAuth sign-in per server. */
interface Contents {
  keys: Keys
  oauth: Map<string, string>
  agentEnv: Map<string, Map<string, string>>
  pluginSecrets: Keys
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ValueProblem = 'empty' | 'tooLarge' | 'nul' | 'lineBreak'

/** A value an input may hold; a header's must stay on one line, which would else start another. */
function valueProblem(value: string, header: boolean): ValueProblem | null {
  if (value.length === 0) return 'empty'
  if (Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) return 'tooLarge'
  if (value.includes('\0')) return 'nul'
  if (header && /[\r\n]/.test(value)) return 'lineBreak'
  return null
}

/** A value's problem as the error says it, for the input it was meant for. */
function valueProblemText(problem: ValueProblem, name: string): string {
  switch (problem) {
    case 'empty':
      return t('marketKeys.valueEmpty', { name })
    case 'tooLarge':
      return t('marketKeys.valueTooLarge', { name, bytes: MAX_KEY_BYTES })
    case 'nul':
      return t('marketKeys.valueNul', { name })
    case 'lineBreak':
      return t('marketKeys.valueLineBreak', { name })
  }
}

/** Why a keys file is read but never written this run. */
type ReadOnly = 'unreadable' | 'newer' | 'undecryptable'

function readOnlyText(reason: ReadOnly, say: typeof t = t): string {
  switch (reason) {
    case 'unreadable':
      return say('marketKeys.unreadable')
    case 'newer':
      return say('marketKeys.newer')
    case 'undecryptable':
      return say('marketKeys.undecryptable')
  }
}

/** The inputs of a spec by name, with whether each is a header. */
function inputsOf(spec: McpSpec): Map<string, boolean> {
  return new Map(specInputs(spec).map((input) => [input.name, spec.type === 'http']))
}

function parseValues(raw: unknown, limit = MAX_MARKET_SERVERS): Keys | null {
  if (!isRecord(raw)) return null
  const entries = Object.entries(raw)
  if (entries.length > limit) return null
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

/** An OAuth sign-in as the agent host gives it: JSON text, and not too large. */
function isOAuthState(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (Buffer.byteLength(value, 'utf8') > MAX_OAUTH_BYTES) return false
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function parseOAuth(raw: unknown): Map<string, string> | null {
  if (!isRecord(raw)) return null
  const entries = Object.entries(raw)
  if (entries.length > MAX_MARKET_SERVERS) return null
  const oauth = new Map<string, string>()
  for (const [id, state] of entries) {
    if (id.length === 0 || id.length > MAX_SERVER_ID || !isOAuthState(state)) return null
    oauth.set(id, state)
  }
  return oauth
}

/** What a file of `version` holds: version 1 kept the input values alone. */
function parseContents(raw: unknown, version: 1 | 2 | 3): Contents | null {
  if (version === 1) {
    const keys = parseValues(raw)
    return keys && { keys, oauth: new Map(), agentEnv: new Map(), pluginSecrets: new Map() }
  }
  if (!isRecord(raw)) return null
  const keys = parseValues(raw.values)
  const oauth = parseOAuth(raw.oauth)
  const agentEnv = version === 3 ? parseValues(raw.agentEnv) : new Map()
  // Added within version 3: a file without it holds none.
  const pluginSecrets =
    raw.pluginSecrets === undefined ? new Map() : parseValues(raw.pluginSecrets, MAX_SECRET_PLUGINS)
  return keys && oauth && agentEnv && pluginSecrets && { keys, oauth, agentEnv, pluginSecrets }
}

function contentsObject({ keys, oauth, agentEnv, pluginSecrets }: Contents): MarketKeysPush {
  return {
    values: toObject(keys),
    oauth: Object.fromEntries(oauth),
    agentEnv: toObject(agentEnv),
    pluginSecrets: toObject(pluginSecrets),
  }
}

/** Whether a server signs in with OAuth, so the store may keep a sign-in for it. */
function signsIn(server: MarketServer): boolean {
  return server.spec.type === 'http' && server.spec.oauth !== undefined
}

function toObject(keys: Keys): MarketKeyValues {
  return Object.fromEntries(
    [...keys].map(([id, inputs]) => [id, Object.fromEntries(inputs)] as const),
  )
}

/**
 * The contents without the keys of servers and inputs the settings no longer have, nor the sign-in
 * of a server that is gone or no longer signs in with OAuth.
 */
function pruned(
  { keys, oauth, agentEnv, pluginSecrets }: Contents,
  servers: readonly MarketServer[],
): Contents {
  const next: Contents = { keys: new Map(), oauth: new Map(), agentEnv, pluginSecrets }
  for (const server of servers) {
    const inputs = keys.get(server.id)
    if (inputs) {
      const declared = inputsOf(server.spec)
      const kept = new Map([...inputs].filter(([name]) => declared.has(name)))
      if (kept.size > 0) next.keys.set(server.id, kept)
    }
    const state = oauth.get(server.id)
    if (state !== undefined && signsIn(server)) next.oauth.set(server.id, state)
  }
  return next
}

function sameContents(a: Contents, b: Contents): boolean {
  return JSON.stringify(contentsObject(a)) === JSON.stringify(contentsObject(b))
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
  /** The system's encryption of the contents' JSON in base64, or the contents themselves. */
  contents: string | MarketKeysPush
}

export interface MarketKeysOptions {
  file: string
  cipher: IdentityCipher
  /** Keeps keys in the file alone where the system cannot encrypt them: the daemon's way. */
  plainTextAllowed: boolean
  /** The servers the settings keep now. */
  servers(): readonly MarketServer[]
  /** The contents changed, for the agent host, which is sent them whole. */
  changed(contents: MarketKeysPush): void
  log: Logger
}

/** Owns `market-keys.json`. Every change runs in turn, so none is lost to another. */
export class MarketKeys {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly options: MarketKeysOptions,
    private contents: Contents,
    /** Why the file is not written this run, as when this system cannot decrypt it now. */
    private readonly readOnly: ReadOnly | null,
  ) {}

  static async load(options: MarketKeysOptions): Promise<MarketKeys> {
    const { file, cipher, log } = options
    const read = await readJsonFile(file)
    let contents: Contents = {
      keys: new Map(),
      oauth: new Map(),
      agentEnv: new Map(),
      pluginSecrets: new Map(),
    }
    let readOnly: ReadOnly | null = null
    let resave = false
    const quarantine = async (reason: string): Promise<void> => {
      log.warn(`${file} is invalid: ${reason}`)
      try {
        log.warn(`Moved the invalid file to ${await quarantineFile(file)}`)
      } catch (error) {
        log.error(`Could not move the invalid ${file} aside`, error)
        readOnly = 'unreadable'
      }
    }
    // The parser's message quotes the text, which holds keys.
    if (read.kind === 'unreadable') {
      await quarantine(read.reason.startsWith('Invalid JSON') ? 'not JSON' : read.reason)
    } else if (read.kind === 'ok') {
      const raw = read.value
      const version = isRecord(raw) ? raw.version : undefined
      // Version 1 kept its contents under `values`.
      const stored = isRecord(raw) ? (version === 1 ? raw.values : raw.contents) : undefined
      if (typeof version === 'number' && version > VERSION) {
        log.warn(`${file} comes from a newer version of Kettu; its keys are not used`)
        readOnly = 'newer'
      } else if (
        !isRecord(raw) ||
        (version !== 1 && version !== 2 && version !== VERSION) ||
        typeof raw.encrypted !== 'boolean'
      ) {
        await quarantine('not a keys file')
      } else if (!raw.encrypted) {
        const parsed = parseContents(stored, version)
        if (parsed) contents = parsed
        else await quarantine('the values are not valid')
        // Encrypted from now on where the system can.
        resave = parsed !== null && (version !== VERSION || !options.plainTextAllowed)
      } else if (!(await cipher.available())) {
        log.warn(`${file} is encrypted, which this system cannot undo now; its keys are not used`)
        readOnly = 'undecryptable'
      } else {
        try {
          if (typeof stored !== 'string' || stored.length > MAX_SEALED_CHARS) {
            throw new Error('the values are not sealed')
          }
          const { result, shouldReEncrypt } = await cipher.decrypt(Buffer.from(stored, 'base64'))
          let decrypted: unknown
          try {
            decrypted = JSON.parse(result)
          } catch {
            throw new Error('the values do not decrypt to JSON')
          }
          const parsed = parseContents(decrypted, version)
          if (!parsed) throw new Error('the values are not valid')
          contents = parsed
          resave = shouldReEncrypt || version !== VERSION
        } catch (error) {
          await quarantine((error as Error)?.message ?? String(error))
        }
      }
    }
    const store = new MarketKeys(options, contents, readOnly)
    if (resave && !readOnly) {
      void store
        .run(() => store.save(store.contents))
        .catch((error: unknown) => {
          log.error(`Could not write ${file}`, error)
        })
    }
    store.prune()
    return store
  }

  /** Which inputs of each server have a value; never the values. */
  state(): MarketKeyState {
    return Object.fromEntries(
      [...this.contents.keys].map(([id, inputs]) => [id, [...inputs.keys()]]),
    )
  }

  /** The values themselves, for the agent host alone. */
  values(): MarketKeyValues {
    return toObject(this.contents.keys)
  }

  agentEnvState(): Record<string, string[]> {
    return Object.fromEntries(
      [...this.contents.agentEnv].map(([id, vars]) => [id, [...vars.keys()]]),
    )
  }

  async setAgentEnv(agentId: string, variable: string, value: string | null): Promise<void> {
    if (
      !agentId ||
      agentId.length > MAX_SERVER_ID ||
      !variable ||
      variable.length > MAX_INPUT_NAME
    ) {
      throw invalid('The agent and environment variable must be named')
    }
    await this.run(async () => {
      if (this.readOnly) throw new MarketKeysError('unavailable', readOnlyText(this.readOnly))
      const vars = new Map(this.contents.agentEnv.get(agentId))
      if (value === null) vars.delete(variable)
      else {
        const problem = valueProblem(value, false)
        if (problem) throw invalid(valueProblemText(problem, variable))
        vars.set(variable, value)
      }
      const agentEnv = new Map(this.contents.agentEnv)
      if (vars.size) agentEnv.set(agentId, vars)
      else agentEnv.delete(agentId)
      await this.commit({ ...this.contents, agentEnv }, true)
    })
  }

  /**
   * Keeps or, with a null value, clears a secret a plugin declares; with a null key, clears every
   * secret of the plugin, as when it is removed. Settles once the file holds the change. Which keys
   * a plugin declares is the agent host's to check, since the store knows no plugins.
   */
  async setPluginSecret(pluginId: unknown, key: unknown, value: unknown): Promise<void> {
    if (typeof pluginId !== 'string' || !PLUGIN_ID.test(pluginId)) throw invalid('Not a plugin')
    if (
      key !== null &&
      (typeof key !== 'string' || key.length === 0 || key.length > MAX_INPUT_NAME)
    ) {
      throw invalid('Not a secret of a plugin')
    }
    if (value !== null && typeof value !== 'string') throw invalid('A secret is a text')
    await this.run(async () => {
      if (this.readOnly) throw new MarketKeysError('unavailable', readOnlyText(this.readOnly))
      const secrets = new Map(this.contents.pluginSecrets.get(pluginId))
      if (key === null) secrets.clear()
      else if (value === null) secrets.delete(key)
      else {
        const problem = valueProblem(value, false)
        if (problem) throw invalid(valueProblemText(problem, key))
        if (!secrets.has(key) && secrets.size >= MAX_INPUTS) {
          throw invalid(`A plugin may keep at most ${MAX_INPUTS} secrets`)
        }
        secrets.set(key, value)
      }
      const pluginSecrets = new Map(this.contents.pluginSecrets)
      if (secrets.size > 0) {
        if (!pluginSecrets.has(pluginId) && pluginSecrets.size >= MAX_SECRET_PLUGINS) {
          throw invalid('Too many plugins keep secrets')
        }
        pluginSecrets.set(pluginId, secrets)
      } else pluginSecrets.delete(pluginId)
      // A clearing is used at once, as a removal is; a secret only once it is written.
      await this.commit({ ...this.contents, pluginSecrets }, value !== null && key !== null)
    })
  }

  /** Everything the agent host is sent: the values, and every OAuth sign-in. */
  contentsForHost(): MarketKeysPush {
    return contentsObject(this.contents)
  }

  /**
   * Fills or clears inputs of a server the settings keep, from an untrusted patch; each name must
   * be one the server's spec declares. Settles once the file holds the change.
   */
  async set(raw: unknown): Promise<MarketKeyState> {
    const patch = parsePatch(raw)
    return this.run(async () => {
      if (this.readOnly) throw new MarketKeysError('unavailable', readOnlyText(this.readOnly))
      const server = this.options.servers().find((each) => each.id === patch.serverId)
      if (!server) throw invalid(t('marketKeys.noServer'))
      const declared = inputsOf(server.spec)
      const inputs = new Map(this.contents.keys.get(server.id))
      for (const [name, value] of patch.values) {
        const header = declared.get(name)
        if (header === undefined) throw invalid(`"${server.name}" has no input "${name}"`)
        if (value === null) {
          inputs.delete(name)
          continue
        }
        const problem = valueProblem(value, header)
        if (problem) throw invalid(valueProblemText(problem, name))
        inputs.set(name, value)
      }
      const keys: Keys = new Map(this.contents.keys)
      if (inputs.size > 0) keys.set(server.id, inputs)
      else keys.delete(server.id)
      const next = { ...this.contents, keys }
      await this.commit(pruned(next, this.options.servers()), true)
      return this.state()
    })
  }

  /**
   * Keeps or, with null, clears a server's OAuth sign-in, as the agent host asks after connecting,
   * renewing or disconnecting it: only for a server the settings keep that signs in with OAuth. A
   * sign-in is used once written, a clearing at once. Either way the agent host is sent what the
   * store then holds, so it learns when a sign-in was refused; false then.
   */
  async setOAuth(serverId: unknown, state: unknown): Promise<boolean> {
    const { log } = this.options
    return this.run(async () => {
      const refused = (reason: string): boolean => {
        log.warn(`Did not keep an OAuth sign-in: ${reason}`)
        this.options.changed(this.contentsForHost())
        return false
      }
      if (typeof serverId !== 'string' || (state !== null && !isOAuthState(state))) {
        return refused('the message is not one')
      }
      const server = this.options.servers().find((each) => each.id === serverId)
      if (!server || !signsIn(server)) {
        return refused(`"${serverId}" is no server that signs in with OAuth`)
      }
      if (state !== null && this.readOnly) return refused(readOnlyText(this.readOnly, tEnglish))
      const oauth = new Map(this.contents.oauth)
      if (state === null) oauth.delete(serverId)
      else oauth.set(serverId, state)
      const next = { ...this.contents, oauth }
      if (sameContents(next, this.contents)) {
        this.options.changed(this.contentsForHost())
        return true
      }
      try {
        await this.commit(next, state !== null)
      } catch (error) {
        log.error(`Could not write ${this.options.file}`, error)
        // A clearing is in use already; a sign-in that could not be written is not.
        return state === null || refused('it could not be written')
      }
      return true
    })
  }

  /** Drops the keys of servers and inputs the settings no longer have, as after an uninstall. */
  prune(): void {
    void this.run(async () => {
      const next = pruned(this.contents, this.options.servers())
      if (!sameContents(next, this.contents)) await this.commit(next, false)
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
  private async commit(next: Contents, writeFirst: boolean): Promise<void> {
    if (writeFirst) await this.save(next)
    this.contents = next
    this.options.changed(this.contentsForHost())
    if (!writeFirst && !this.readOnly) await this.save(next)
  }

  private async save(contents: Contents): Promise<void> {
    const { file, cipher, plainTextAllowed } = this.options
    if (
      contents.keys.size === 0 &&
      contents.oauth.size === 0 &&
      contents.agentEnv.size === 0 &&
      contents.pluginSecrets.size === 0
    ) {
      await rm(file, { force: true })
      return
    }
    const encrypted = await cipher.available()
    if (!encrypted && !plainTextAllowed) {
      throw new MarketKeysError('unavailable', t('marketKeys.cannotEncrypt'))
    }
    const plain = contentsObject(contents)
    const stored: KeysFile = {
      version: VERSION,
      encrypted,
      contents: encrypted
        ? (await cipher.encrypt(JSON.stringify(plain))).toString('base64')
        : plain,
    }
    await writeFileAtomic(file, `${JSON.stringify(stored, null, 2)}\n`, FILE_MODE)
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => {})
    return next
  }
}
