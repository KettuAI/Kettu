// `sample`: one question from a page to the agent new sessions in its project start with, which
// answers in a hidden session of its own with no tools, no MCP servers and no memory of the last
// question, using the user's own plan; only an agent that can run that way offers it.

import type { PromptBlock } from '../../connection'
import { CapabilityError, type CapabilityHandler } from './dispatcher'

export const PROMPT_CHARS = 100_000
export const IMAGES = 4
export const IMAGE_BYTES = 5 * 1024 * 1024
/** Questions of one artifact at once, and in a minute. */
export const AT_ONCE = 2
export const PER_MINUTE = 10
const MINUTE_MS = 60_000

const IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/

const JSON_INSTRUCTION =
  'Answer with only a JSON value, no other text and no code fence. The question follows.\n\n'

export interface SampleAgent {
  /** The agent's id, as the host runs it. */
  id: string
  name: string
}

export interface SampleQuestion {
  prompt: PromptBlock[]
  onText(text: string): void
  signal: AbortSignal
}

export interface SampleDeps {
  /**
   * The agent that answers for an artifact of `project`, null for No project; null when none can
   * without tools.
   */
  agentFor(project: string | null): Promise<SampleAgent | null>
  /** Asks `agent` in a hidden session without tools; resolves with the whole answer. */
  answer(agent: SampleAgent, question: SampleQuestion): Promise<string>
  now?: () => number
}

/** The page's images as prompt blocks, each a checked data URL. */
function images(value: unknown): PromptBlock[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > IMAGES) {
    throw new CapabilityError('invalid', `images must be a list of at most ${IMAGES} data URLs.`)
  }
  return value.map((item: unknown) => {
    const match = typeof item === 'string' ? IMAGE.exec(item) : null
    if (!match) {
      throw new CapabilityError(
        'invalid',
        'Each image must be a data URL of a PNG, JPEG, GIF or WebP in base64.',
      )
    }
    if (Math.floor((match[2]!.length * 3) / 4) > IMAGE_BYTES) {
      throw new CapabilityError('too_large', 'An image may be at most 5 MiB.')
    }
    return { type: 'image', mimeType: match[1]!, data: match[2]! }
  })
}

/** The JSON in an answer, fenced or not; undefined when it holds none. */
export function answerJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  try {
    return JSON.parse((fenced ?? text).trim()) as unknown
  } catch {
    return undefined
  }
}

export function sampleCapability(deps: SampleDeps): CapabilityHandler {
  const running = new Map<string, number>()
  const recent = new Map<string, number[]>()
  const now = (): number => (deps.now ?? Date.now)()
  return {
    name: 'sample',
    consent: true,
    ops: ['ask'],
    available: async (ctx) => (await deps.agentFor(ctx.project)) !== null,
    call: (_, op) => Promise.reject(new CapabilityError('unsupported', `sample.${op} streams.`)),
    async stream(ctx, op, value, emit) {
      if (op !== 'ask') throw new CapabilityError('unsupported', `sample has no ${op}.`)
      const o = (typeof value === 'object' && value !== null ? value : {}) as Record<
        string,
        unknown
      >
      if (typeof o.prompt !== 'string' || o.prompt.trim() === '') {
        throw new CapabilityError('invalid', 'prompt must be the question, as text.')
      }
      if (o.prompt.length > PROMPT_CHARS) {
        throw new CapabilityError('too_large', `prompt may be at most ${PROMPT_CHARS} characters.`)
      }
      const format = o.format ?? 'text'
      if (format !== 'text' && format !== 'json') {
        throw new CapabilityError('invalid', 'format must be text or json.')
      }
      const pictures = images(o.images)
      const agent = await deps.agentFor(ctx.project)
      if (!agent) throw new CapabilityError('unsupported', 'No agent can answer here.')
      const at = now()
      const minute = (recent.get(ctx.artifactId) ?? []).filter((t) => t > at - MINUTE_MS)
      if (minute.length >= PER_MINUTE) {
        throw new CapabilityError('rate_limited', 'Too many questions in a minute; wait a little.')
      }
      const busy = running.get(ctx.artifactId) ?? 0
      if (busy >= AT_ONCE) {
        throw new CapabilityError('rate_limited', `At most ${AT_ONCE} questions at a time.`)
      }
      minute.push(at)
      recent.set(ctx.artifactId, minute)
      running.set(ctx.artifactId, busy + 1)
      try {
        const text = format === 'json' ? JSON_INSTRUCTION + o.prompt : o.prompt
        const answer = await deps.answer(agent, {
          prompt: [{ type: 'text', text }, ...pictures],
          onText: (delta) => {
            if (delta) emit({ type: 'text', text: delta })
          },
          signal: ctx.signal,
        })
        if (ctx.signal.aborted) return
        if (format === 'json') {
          const json = answerJson(answer)
          if (json === undefined) throw new CapabilityError('failed', 'The answer was not JSON.')
          emit({ type: 'answer', text: answer, json })
        } else {
          emit({ type: 'answer', text: answer })
        }
      } finally {
        const left = (running.get(ctx.artifactId) ?? 1) - 1
        if (left > 0) running.set(ctx.artifactId, left)
        else running.delete(ctx.artifactId)
      }
    },
  }
}
