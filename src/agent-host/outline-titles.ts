// Titles the message outline shows for the user messages: a small model of the session's own
// agent summarizes them in a hidden session, removed afterwards as the reports' are. A session's
// own title is written the same way, from its first message.

import type { OutlineTitle } from '@shared/agent-host'
import type { ConfigOption } from '@shared/thread'
import { LocalizedError } from './localized-error'
import { REPORT_TIMEOUT_MS, type HiddenRuntime } from './reports'

/** At most this many messages go in one summary, the newest first... */
export const SUMMARY_MESSAGES = 100
/** ...each cut to this many characters. */
export const SUMMARY_CHARS = 500
export const TITLE_CHARS = 60
/** A session whose last summary failed waits this long before the next. */
export const SUMMARY_RETRY_MS = 5 * 60_000

// As words, so Gemini is not taken for a mini model.
const SMALL_MODEL = /\b(haiku|mini|flash|nano)\b/i

const INSTRUCTION =
  "Write a title of at most six words for each message below, in the message's own language. " +
  'Answer with only a JSON object that maps each id to its title.'

const modelOption = (config: readonly ConfigOption[]): ConfigOption | undefined =>
  config.find((option) => option.category === 'model' && option.type === 'select')

/**
 * Which model a hidden session asks: the first of the agent's small models when `small`, else
 * `model`, null keeping the agent's own. A `pinned` model is the user's pick, so an agent that no
 * longer offers it fails the request rather than asking another.
 */
export interface ModelPick {
  small: boolean
  model: string | null
  pinned?: boolean
}

/** The model the pick names among the agent's, null keeping the one the session opened with. */
export function pickModel(config: readonly ConfigOption[], pick: ModelPick): string | null {
  const choices = modelOption(config)?.choices ?? []
  if (pick.pinned) {
    if (!choices.some((choice) => choice.value === pick.model)) {
      throw new LocalizedError({ key: 'light.noModel', params: { model: pick.model ?? '' } })
    }
    return pick.model
  }
  if (!pick.small) return pick.model
  const small = choices.find(
    (choice) => SMALL_MODEL.test(choice.name) || SMALL_MODEL.test(choice.value),
  )
  return small?.value ?? pick.model
}

/** The prompt for the newest SUMMARY_MESSAGES messages, each named by its position and cut short. */
export function summaryPrompt(
  messages: readonly { pos: number; text: string }[],
  cut: number = SUMMARY_CHARS,
  instruction: string = INSTRUCTION,
): {
  positions: number[]
  prompt: string
} {
  const picked = [...messages].sort((a, b) => b.pos - a.pos).slice(0, SUMMARY_MESSAGES)
  const list = picked.map(({ pos, text }) => ({
    id: String(pos),
    text: Array.from(text).slice(0, cut).join(''),
  }))
  return {
    positions: picked.map(({ pos }) => pos),
    prompt: `${instruction}\n\n${JSON.stringify(list)}`,
  }
}

/**
 * The titles in the agent's reply, a JSON object fenced or not, for the positions asked; null
 * when the reply holds no such object.
 */
export function parseTitles(reply: string, asked: ReadonlySet<number>): OutlineTitle[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)?.[1]
  const text = fenced ?? reply
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const titles: OutlineTitle[] = []
  for (const [id, title] of Object.entries(value)) {
    const pos = Number(id)
    if (!/^\d+$/.test(id) || !asked.has(pos) || typeof title !== 'string') continue
    const line = title.replace(/\s+/g, ' ').trim()
    if (line) titles.push({ pos, title: Array.from(line).slice(0, TITLE_CHARS).join('') })
  }
  return titles
}

export interface SummaryRequest {
  /** The empty folder hidden sessions run in. */
  dir: string
  model: ModelPick
  messages: readonly { pos: number; text: string }[]
  /** Each message is cut to this many characters, 500 by default. */
  cut?: number
  /** What the titles are for, in its log lines: the outline's messages by default. */
  name?: string
  /**
   * What the model is asked to write for each message, ending by asking for the JSON object;
   * titles by default.
   */
  instruction?: string
  log(message: string): void
  timeoutMs?: number
}

export interface SmallModelRequest {
  /** The empty folder hidden sessions run in. */
  dir: string
  model: ModelPick
  prompt: string
  /** What the reply is for, in its log lines. */
  name: string
  log(message: string): void
  timeoutMs?: number
}

/**
 * Asks the model the pick names, by default the agent's small one, one prompt in a hidden session
 * of its own, then removes it, and gives the messages it answers with. Rejects when the agent
 * cannot open one that leaves no trace, no longer offers a pinned model, fails or takes longer
 * than the timeout.
 */
export async function askSmallModel(
  runtime: HiddenRuntime,
  request: SmallModelRequest,
): Promise<string[]> {
  const { connection } = runtime
  if (!connection.hiddenSessions) {
    throw new LocalizedError({ key: 'light.noRemoval' })
  }
  const timeoutMs = request.timeoutMs ?? REPORT_TIMEOUT_MS
  const remove = (sessionId: string): Promise<void> =>
    connection.removeHidden(sessionId, (message) =>
      request.log(`Could not remove the session of ${request.name}: ${message}`),
    )
  const opening = connection.newSession(request.dir, { hidden: 'titles' })
  let sessionId: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const work = async (): Promise<string[]> => {
    const setup = await opening
    sessionId = setup.sessionId
    const option = modelOption(setup.config)
    const model = pickModel(setup.config, request.model)
    if (option && model !== null && model !== option.value) {
      await connection.setConfigOption(setup.sessionId, option.id, model)
    }
    return connection.collect(setup.sessionId, request.prompt)
  }
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (sessionId) void connection.cancel(sessionId).catch(() => {})
          reject(
            new LocalizedError({ key: 'light.noAnswer', params: { seconds: timeoutMs / 1000 } }),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (sessionId) await remove(sessionId)
    // One that opens after the timeout goes the same way.
    else
      void opening.then(
        (setup) => remove(setup.sessionId),
        () => {},
      )
  }
}

/**
 * Asks the agent for the messages' titles in a hidden session of its own, then removes it.
 * Rejects when the agent cannot open one that leaves no trace, fails, takes longer than the
 * timeout or answers with nothing that parses.
 */
export async function writeTitles(
  runtime: HiddenRuntime,
  request: SummaryRequest,
): Promise<OutlineTitle[]> {
  const { positions, prompt } = summaryPrompt(request.messages, request.cut, request.instruction)
  const messages = await askSmallModel(runtime, {
    dir: request.dir,
    model: request.model,
    prompt,
    name: request.name ?? 'the outline titles',
    log: request.log,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  })
  const titles = parseTitles(messages.join('\n'), new Set(positions))
  if (!titles) throw new Error('its reply holds no JSON object of titles')
  return titles
}
