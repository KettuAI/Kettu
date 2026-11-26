// What each command server last answered to `initialize` (or `server/discover`) and to its lists,
// kept in the host's state so a session's agent can open the server and list its tools before
// Kettu starts its process, which then waits for the first real call. An answer is kept against a
// digest of what the server runs, so a changed command starts afresh; it never holds a key.

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { McpSpec } from '@shared/marketplace'
import { JsonFile, type LogFn } from '../storage'
import { isListMethod, isRecord, type Era, type ListMethod } from './jsonrpc'

export interface ServerAnswers {
  /** The digest of what it runs, from `specDigest`. */
  spec: string
  era: Era
  /** `initialize`'s result for the old protocol, `server/discover`'s for the new. */
  init: Record<string, unknown>
  /** The first page of each list, as the server last answered it. */
  lists: Partial<Record<ListMethod, Record<string, unknown>>>
  at: number
}

export interface AnswersFile {
  version: 1
  servers: Record<string, ServerAnswers>
}

/** The most kept of one server, as JSON; a larger answer is not kept and the process starts. */
export const MAX_ANSWER_BYTES = 1024 * 1024
export const MAX_ANSWER_SERVERS = 200

/**
 * What a command server runs, without any value: the command, its arguments and the names of its
 * environment. A key's new value starts the same program, so it keeps the answers.
 */
export function specDigest(spec: McpSpec): string {
  const runs =
    spec.type === 'stdio'
      ? [spec.command, spec.args, spec.env.map((value) => value.name), spec.runtime ?? null]
      : [spec.url, spec.transport]
  return createHash('sha256').update(JSON.stringify(runs)).digest('hex').slice(0, 32)
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function readAnswers(raw: unknown): ServerAnswers | null {
  if (!isRecord(raw)) return null
  const { spec, era, init, lists, at } = raw
  if (typeof spec !== 'string' || !/^[0-9a-f]{32}$/.test(spec)) return null
  if (era !== 'legacy' && era !== 'modern') return null
  if (!isRecord(init) || !isRecord(lists)) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  const kept: ServerAnswers['lists'] = {}
  for (const [method, result] of Object.entries(lists)) {
    if (isListMethod(method) && isRecord(result)) kept[method] = result
  }
  const answers: ServerAnswers = { spec, era: era as Era, init, lists: kept, at }
  return bytes(answers) <= MAX_ANSWER_BYTES ? answers : null
}

/** The file's servers, each dropped on its own when it is not what Kettu wrote. */
export function parseAnswersFile(data: Record<string, unknown>): AnswersFile | string {
  if (!isRecord(data.servers)) return 'servers is not an object'
  const servers: AnswersFile['servers'] = {}
  for (const [id, raw] of Object.entries(data.servers).slice(0, MAX_ANSWER_SERVERS)) {
    const answers = readAnswers(raw)
    if (answers) servers[id] = answers
  }
  return { version: 1, servers }
}

export function answersFile(userDataPath: string, log: LogFn): JsonFile<AnswersFile> {
  return new JsonFile<AnswersFile>({
    file: path.join(userDataPath, 'state', 'mcp-answers.json'),
    version: 1,
    migrations: {},
    parse: parseAnswersFile,
    empty: () => ({ version: 1, servers: {} }),
    log,
    compact: true,
  })
}

/** The answers in memory, written behind as they change. */
export class Answers {
  private data: AnswersFile = { version: 1, servers: {} }

  constructor(
    private readonly file: JsonFile<AnswersFile> | null,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    if (this.file) this.data = await this.file.load()
  }

  /** The answers for a server while they are for what it runs now. */
  get(serverId: string, spec: string): ServerAnswers | null {
    const answers = this.data.servers[serverId]
    return answers?.spec === spec ? answers : null
  }

  /** A server answered its opening request: what was kept for another command goes. */
  opened(serverId: string, spec: string, era: Era, init: Record<string, unknown>): void {
    const held = this.get(serverId, spec)
    const answers: ServerAnswers = { spec, era, init, lists: held?.lists ?? {}, at: this.now() }
    if (bytes(answers) > MAX_ANSWER_BYTES) return
    this.put(serverId, answers)
  }

  listed(
    serverId: string,
    spec: string,
    method: ListMethod,
    result: Record<string, unknown>,
  ): void {
    const held = this.get(serverId, spec)
    if (!held) return
    const answers = { ...held, lists: { ...held.lists, [method]: result }, at: this.now() }
    if (bytes(answers) > MAX_ANSWER_BYTES) return
    this.put(serverId, answers)
  }

  /** The server said a list changed: it is asked again the next time. */
  stale(serverId: string, methods: readonly ListMethod[]): void {
    const held = this.data.servers[serverId]
    if (!held || !methods.some((method) => held.lists[method])) return
    const lists = { ...held.lists }
    for (const method of methods) delete lists[method]
    this.put(serverId, { ...held, lists })
  }

  /** Only the servers the library still keeps stay. */
  keep(serverIds: ReadonlySet<string>): void {
    const gone = Object.keys(this.data.servers).filter((id) => !serverIds.has(id))
    if (gone.length === 0) return
    const servers = { ...this.data.servers }
    for (const id of gone) delete servers[id]
    this.data = { version: 1, servers }
    this.file?.save(this.data)
  }

  async flush(): Promise<void> {
    await this.file?.flush()
  }

  private put(serverId: string, answers: ServerAnswers): void {
    const servers = { ...this.data.servers, [serverId]: answers }
    const ids = Object.keys(servers)
    if (ids.length > MAX_ANSWER_SERVERS) {
      const oldest = ids.sort((a, b) => servers[a]!.at - servers[b]!.at)[0]!
      delete servers[oldest]
    }
    this.data = { version: 1, servers }
    this.file?.save(this.data)
  }
}
