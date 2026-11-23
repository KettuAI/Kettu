// agy's turn as Kettu steers it. agy 1.5.15 takes a `session/prompt` sent while one runs: the
// running one answers `end_turn` at once and the new message is answered in the new prompt, which
// agy holds open, as it did the first, while a command it started runs. It refuses one while a
// permission request or a question waits. Kettu's turn is that chain of prompts and ends with the
// last one's answer, its tokens those of them all.

import type { PromptResponse } from '@agentclientprotocol/sdk/unstable'
import type { TokenTotals } from '@shared/thread'
import type { ModelTokens } from '../connection'
import { addTokenTotals } from '../session-updates'
import { versionAtLeast } from '../versions'
import { mapModelUsage, mapTokenTotals } from './mapper'

export const AGY_STEERING_VERSION = '1.5.15'

const WAITING_FOR_ANSWER = /the running prompt is waiting for a permission or question answer/i

export function steersAgy(version: string | null): boolean {
  return versionAtLeast(version, AGY_STEERING_VERSION)
}

/** agy refused a prompt because the running one waits for the user's answer to a card. */
export function refusedForAnswer(error: unknown): boolean {
  return error instanceof Error && WAITING_FOR_ANSWER.test(error.message)
}

export interface ChainAnswer {
  response: PromptResponse
  tokens: TokenTotals | null
  models: ModelTokens[]
}

function addModels(sum: ModelTokens[], more: ModelTokens[]): ModelTokens[] {
  const out = sum.map((item) => ({ ...item }))
  for (const item of more) {
    const known = out.find((other) => other.model === item.model)
    if (known) known.tokens = addTokenTotals(known.tokens, item.tokens)
    else out.push({ ...item })
  }
  return out
}

/** The prompts of one turn: the first, then those steered into it, each ending the one before. */
export class PromptChain {
  private readonly steered: Promise<PromptResponse>[] = []
  /** The latest prompt agy took, which the next one steered ends. */
  private last: Promise<PromptResponse>
  private steering: Promise<unknown> = Promise.resolve()
  private done = false

  constructor(private readonly first: Promise<PromptResponse>) {
    this.last = first
  }

  /**
   * Sends a prompt into the turn with `send`: `injected` once agy took it, which it shows by
   * answering the prompt before it; `promptRequired` once the turn's last answer is in or agy
   * refused it for a card that waits, and the prompt is then no part of the turn.
   */
  steer(send: () => Promise<PromptResponse>): Promise<'injected' | 'promptRequired'> {
    // One at a time, so each waits on a prompt agy took rather than on one it may still refuse.
    const run = this.steering.then(() => this.steerNow(send))
    this.steering = run.catch(() => {})
    return run
  }

  private async steerNow(
    send: () => Promise<PromptResponse>,
  ): Promise<'injected' | 'promptRequired'> {
    if (this.done) return 'promptRequired'
    const before = this.last
    const sent = send()
    // Answered or refused, it is read below or by `settle`, never left unhandled.
    sent.catch(() => {})
    this.steered.push(sent)
    this.last = sent
    const refused = await Promise.race([
      before.then(
        () => null,
        () => null,
      ),
      sent.then(
        () => null,
        (error: unknown) => ({ error }),
      ),
    ])
    if (!refused) return 'injected'
    const at = this.steered.indexOf(sent)
    if (at >= 0) this.steered.splice(at, 1)
    if (this.last === sent) this.last = before
    if (refusedForAnswer(refused.error)) return 'promptRequired'
    throw refused.error
  }

  /**
   * Waits for the first prompt's answer and every one steered in after it, and answers with the
   * last, the tokens of them all added up. A prompt that failed before another was answered after
   * it ends nothing; the turn fails only when its last prompt did.
   */
  async settle(): Promise<ChainAnswer> {
    let answered: PromptResponse | null = null
    let failure: { error: unknown } | null = null
    let tokens: TokenTotals | null = null
    let models: ModelTokens[] = []
    let current: Promise<PromptResponse> | undefined = this.first
    try {
      while (current) {
        try {
          const response: PromptResponse = await current
          answered = response
          failure = null
          const turn = mapTokenTotals(response.usage)
          if (turn) tokens = addTokenTotals(tokens, turn)
          models = addModels(models, mapModelUsage(response._meta))
        } catch (error) {
          // Refused while a card waited: agy never took it, and the prompt before it still runs.
          if (current === this.first || !refusedForAnswer(error)) failure = { error }
        }
        current = this.steered.shift()
      }
    } finally {
      // In the same step as the empty queue is seen, so a prompt steered later finds it done.
      this.done = true
    }
    // With no failure left, a prompt was answered.
    if (failure) throw failure.error
    return { response: answered!, tokens, models }
  }
}
