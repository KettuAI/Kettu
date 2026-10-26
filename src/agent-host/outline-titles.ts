// Titles the message outline shows for the user messages: a small model of the session's own
// agent summarizes them in a hidden session, removed afterwards as the reports' are. A session's
// own title is written the same way, from its first message.

import type { OutlineTitle } from '@shared/agent-host'
import type { ConfigOption } from '@shared/thread'
import {
  hiddenRemoval,
  hiddenSessionMeta,
  removeHiddenSession,
  REPORT_TIMEOUT_MS,
  type HiddenRuntime,
} from './reports'

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

/** The first of the agent's models that is a small one, else the session's own model. */
export function pickModel(
  config: readonly ConfigOption[],
  sessionModel: string | null,
): string | null {
  const small = modelOption(config)?.choices?.find(
    (choice) => SMALL_MODEL.test(choice.name) || SMALL_MODEL.test(choice.value),
  )
  return small?.value ?? sessionModel
}

/** The prompt for the newest SUMMARY_MESSAGES messages, each named by its position and cut short. */
export function summaryPrompt(
  messages: readonly { pos: number; text: string }[],
  cut: number = SUMMARY_CHARS,
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
    prompt: `${INSTRUCTION}\n\n${JSON.stringify(list)}`,
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
  /** The session's model, for an agent that offers no small one. */
  sessionModel: string | null
  messages: readonly { pos: number; text: string }[]
  /** Each message is cut to this many characters, 500 by default. */
  cut?: number
  /** What the titles are for, in its log lines: the outline's messages by default. */
  name?: string
  log(message: string): void
  timeoutMs?: number
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
  const removal = hiddenRemoval(runtime.agentId, runtime.init)
  if (!removal) throw new Error("the agent's hidden sessions cannot be removed without a trace")
  const { connection } = runtime
  const timeoutMs = request.timeoutMs ?? REPORT_TIMEOUT_MS
  const name = request.name ?? 'the outline titles'
  const { positions, prompt } = summaryPrompt(request.messages, request.cut)
  const remove = (acpSessionId: string): Promise<void> =>
    removeHiddenSession(runtime, acpSessionId, removal, (message) =>
      request.log(`Could not remove the session of ${name}: ${message}`),
    )
  const opening = connection.newSession(request.dir, hiddenSessionMeta(runtime.agentId))
  let acpSessionId: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const work = async (): Promise<string[]> => {
    const setup = await opening
    acpSessionId = setup.acpSessionId
    const option = modelOption(setup.config)
    const model = pickModel(setup.config, request.sessionModel)
    if (option && model !== null && model !== option.value) {
      await connection.setConfigOption(setup.acpSessionId, option.id, model)
    }
    return connection.collect(setup.acpSessionId, prompt)
  }
  try {
    const messages = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (acpSessionId) void connection.cancel(acpSessionId).catch(() => {})
          reject(new Error(`no answer within ${timeoutMs / 1000} s`))
        }, timeoutMs)
      }),
    ])
    const titles = parseTitles(messages.join('\n'), new Set(positions))
    if (!titles) throw new Error('its reply holds no JSON object of titles')
    return titles
  } finally {
    if (timer) clearTimeout(timer)
    if (acpSessionId) await remove(acpSessionId)
    // One that opens after the timeout goes the same way.
    else
      void opening.then(
        (setup) => remove(setup.acpSessionId),
        () => {},
      )
  }
}
