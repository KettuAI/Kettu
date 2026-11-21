// The models DeepSeek Harness offers, as it lists them itself. Its SDK wire lists none, but its ACP
// mode gives a new session every route's models, and the chosen model's reasoning levels, from the
// service its own pickers read. Kettu asks it in a process of its own that is never prompted, and
// whose session is kept out of the user's dsh home, so its menu shows what dsh's would.

import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { messageStream, RpcPeer } from '../codex/rpc'

/**
 * The model the listing process starts on: dsh adds a session's own model to the list when the
 * list lacks it, and a name no route has is taken out again by that name.
 */
export const LISTING_PROVIDER = 'deepseek-official'
export const LISTING_MODEL = 'kettu-model-list'

const MODEL_OPTION = 'model'
const EFFORT_OPTION = 'reasoning_effort'
const TIMEOUT_MS = 60_000
/** Longer than an agent process's stop takes, its tree included, before it is killed outright. */
const EXIT_WAIT_MS = 10_000
/**
 * dsh answers a new session before every route has registered, often with no model at all, and
 * says nothing when the rest come. The list is asked for again until two answers agree; an empty
 * one counts only once a home with routes would have listed them.
 */
const SETTLE_STEP_MS = 300
const SETTLE_EMPTY_MS = 3_000
const SETTLE_LIMIT_MS = 6_000

export interface ListedEffort {
  /** dsh's id of the level; empty for the one that leaves it to the provider. */
  id: string
  name: string
}

export interface ListedModel {
  /** The route's id in dsh, and its name in dsh's pickers. */
  provider: string
  group: string
  model: string
  name: string
  /** The levels dsh offers for it, in its order; empty for a model without any. */
  efforts: ListedEffort[]
  /** The level dsh starts it on; null for a model without levels. */
  effort: string | null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function option(options: unknown, id: string): Record<string, unknown> | null {
  if (!Array.isArray(options)) return null
  return options.map(record).find((candidate) => candidate?.id === id) ?? null
}

/** The route and model a choice's value stands for: dsh writes both into it as a JSON pair. */
function routeOf(value: unknown): { provider: string; model: string } | null {
  if (typeof value !== 'string') return null
  try {
    const pair = JSON.parse(value) as unknown
    if (!Array.isArray(pair) || pair.length !== 2) return null
    const [provider, model] = pair as unknown[]
    return typeof provider === 'string' && typeof model === 'string' && provider && model
      ? { provider, model }
      : null
  } catch {
    return null
  }
}

/** A model of the list with the value that selects it; its levels are read once it is selected. */
export interface ListedChoice {
  value: string
  model: Omit<ListedModel, 'efforts' | 'effort'>
}

/** The models a session's options list, by route, without the one the listing process started on. */
export function listedChoices(options: unknown): ListedChoice[] {
  const groups = option(options, MODEL_OPTION)?.options
  if (!Array.isArray(groups)) return []
  const choices: ListedChoice[] = []
  for (const entry of groups) {
    const group = record(entry)
    if (!group || !Array.isArray(group.options)) continue
    for (const item of group.options) {
      const choice = record(item)
      const route = routeOf(choice?.value)
      if (!choice || !route || route.model === LISTING_MODEL) continue
      choices.push({
        value: choice.value as string,
        model: {
          provider: route.provider,
          group: typeof group.name === 'string' && group.name ? group.name : route.provider,
          model: route.model,
          name: typeof choice.name === 'string' && choice.name ? choice.name : route.model,
        },
      })
    }
  }
  return choices
}

/** The selected model's levels and the one it is on, from a session's options. */
export function listedEfforts(options: unknown): Pick<ListedModel, 'efforts' | 'effort'> {
  const effort = option(options, EFFORT_OPTION)
  if (!effort || !Array.isArray(effort.options)) return { efforts: [], effort: null }
  const efforts = effort.options.flatMap((entry): ListedEffort[] => {
    const level = record(entry)
    return level && typeof level.value === 'string'
      ? [{ id: level.value, name: typeof level.name === 'string' ? level.name : level.value }]
      : []
  })
  const current = typeof effort.currentValue === 'string' ? effort.currentValue : null
  return {
    efforts,
    effort: efforts.some((level) => level.id === current) ? current : (efforts[0]?.id ?? null),
  }
}

/**
 * The rows that make a listing process leave nothing in the user's dsh home: its session and what
 * dsh keeps about it go to `folder`, and it starts on a model no route has.
 */
export function listingRows(folder: string): string {
  const q = (value: string): string => JSON.stringify(value)
  return [
    '- id: acp',
    '  config:',
    `    provider: ${q(LISTING_PROVIDER)}`,
    `    model: ${q(LISTING_MODEL)}`,
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${q(path.join(folder, 'sessions'))}`,
    '- id: storage-json',
    '  config:',
    `    root: ${q(path.join(folder, 'storages'))}`,
    '',
  ].join('\n')
}

export interface ListingRun {
  /**
   * Starts `dsh --profile acp` with the patch file that holds the routes and `listingRows`, to be
   * stopped with its tree, as an agent's process is, once `stop` aborts.
   */
  spawn(stop: AbortSignal): ChildProcess
  /** The folder the session is opened in. */
  cwd: string
  /** Ends the process early, as when the agent stops. */
  signal?: AbortSignal
  timeoutMs?: number
}

/** Whether the process has exited, or never started, waiting `ms` at most. */
function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  const done = child.pid === undefined || child.exitCode !== null || child.signalCode !== null
  if (done) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** Ends a listing process that has not exited on its own, then waits for it to. */
async function ended(child: ChildProcess): Promise<void> {
  if (await exitedWithin(child, EXIT_WAIT_MS)) return
  child.kill('SIGKILL')
  await exitedWithin(child, EXIT_WAIT_MS)
}

export interface Listing {
  /** Null when dsh gave no answer. */
  models: ListedModel[] | null
  /** Resolves once the process has exited, after which nothing writes to its session's folder. */
  exited: Promise<void>
}

/**
 * Asks dsh for its models: opens one session, reads the list, and selects each model in turn to
 * read its levels. The process is ended either way, with its tree.
 */
export async function readListing(run: ListingRun): Promise<Listing> {
  const stop = new AbortController()
  const child = run.spawn(stop.signal)
  const { stream, close } = messageStream({
    kind: 'stdio',
    stdin: child.stdin!,
    stdout: child.stdout!,
  })
  const rpc = new RpcPeer(
    stream,
    {
      notification: () => {},
      request: () => Promise.reject(new Error('The listing answers no request')),
      traffic: () => {},
      log: () => {},
    },
    close,
  )
  child.once('exit', () => rpc.close())
  child.once('error', () => rpc.close())
  run.signal?.addEventListener('abort', () => rpc.close(), { once: true })
  let timer: ReturnType<typeof setTimeout> | null = null
  const read = async (): Promise<ListedModel[] | null> => {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const opened = record(await rpc.request('session/new', { cwd: run.cwd, mcpServers: [] }))
    const sessionId = opened?.sessionId
    if (typeof sessionId !== 'string') return null
    const select = async (value: string): Promise<unknown> =>
      record(
        await rpc.request('session/set_config_option', {
          sessionId,
          configId: MODEL_OPTION,
          value,
        }),
      )?.configOptions
    let choices = listedChoices(opened?.configOptions)
    // Selecting the model it is on changes nothing and answers with the list as it is now.
    const own = option(opened?.configOptions, MODEL_OPTION)?.currentValue
    const asked = Date.now()
    while (typeof own === 'string' && Date.now() - asked < SETTLE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_STEP_MS))
      const again = listedChoices(await select(own))
      const settled =
        again.length === choices.length &&
        again.every((choice, index) => choice.value === choices[index]!.value)
      choices = again
      if (settled && (choices.length > 0 || Date.now() - asked >= SETTLE_EMPTY_MS)) break
    }
    const models: ListedModel[] = []
    for (const choice of choices) {
      models.push({ ...choice.model, ...listedEfforts(await select(choice.value)) })
    }
    return models
  }
  let models: ListedModel[] | null
  try {
    models = await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), run.timeoutMs ?? TIMEOUT_MS)
      }),
    ])
  } catch {
    models = null
  } finally {
    if (timer) clearTimeout(timer)
    rpc.close()
    stop.abort()
  }
  return { models, exited: ended(child) }
}
