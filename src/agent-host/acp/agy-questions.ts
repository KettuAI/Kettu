// agy's `ask_question` as Kettu's question card. Told the client takes forms, agy 1.5.15 asks it as
// a form elicitation tied to the call: a field `qN` for each question, a choice among its `oneOf`
// values or, for a multiple choice, a list of its `items.anyOf` values, and `qN_other`, the user's
// own words. It answers the call once the form is accepted and goes on in the same turn; a form
// declined or not offered, it asks in the chat.

import type {
  CreateElicitationResponse,
  SessionUpdate,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable'
import type { PendingQuestion, PermissionOption, QuestionAnswer } from '@shared/thread'
import type { SessionTarget } from '../connection'
import { t } from '../i18n'
import { compareVersions } from '../versions'
import { mapPermissionToolCall } from './mapper'

export const AGY_QUESTIONS_VERSION = '1.5.15'

/** What agy is told it may ask: forms, beside the pages of a sign-in. */
export const AGY_ELICITATION = { form: {}, url: {} }

/** Whether agy asks its questions as forms: a version it was measured on. */
export function asksQuestions(version: string | null): boolean {
  return version !== null && compareVersions(version, AGY_QUESTIONS_VERSION) >= 0
}

/** Where one question's answer goes in the form: its field, the values it offers, its text field. */
interface AskField {
  key: string
  multiple: boolean
  /** The value of each option, in the order of the card's tiles. */
  values: string[]
  other: string | null
}

/** The questions of one form, as the card shows them and as the form takes their answers. */
export interface AgyAsk {
  questions: PendingQuestion[]
  fields: AskField[]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The `{ const, title }` options of a choice, or null when they are not all that shape. */
function options(list: unknown): { value: string; label: string }[] | null {
  if (!Array.isArray(list) || list.length === 0) return null
  const found: { value: string; label: string }[] = []
  for (const item of list) {
    const option = record(item)
    if (typeof option?.const !== 'string' || typeof option.title !== 'string') return null
    if (option.title === '') return null
    found.push({ value: option.const, label: option.title })
  }
  return new Set(found.map((option) => option.value)).size === found.length ? found : null
}

/**
 * The questions a form schema asks, in agy's order. Null for any schema that is not exactly agy's
 * ask: a field that is neither a question nor the text of one, or a required one.
 */
export function agyAsk(schema: unknown): AgyAsk | null {
  const root = record(schema)
  const properties = record(root?.properties)
  if (!properties || root?.type !== 'object') return null
  if (Array.isArray(root.required) && root.required.length > 0) return null
  const asked: { number: number; key: string; field: Record<string, unknown> }[] = []
  const texts = new Map<number, string>()
  for (const [key, value] of Object.entries(properties)) {
    const field = record(value)
    const match = /^q(\d+)(_other)?$/.exec(key)
    if (!field || !match) return null
    const number = Number(match[1])
    if (match[2]) {
      if (field.type !== 'string') return null
      texts.set(number, key)
    } else {
      asked.push({ number, key, field })
    }
  }
  if (asked.length === 0) return null
  asked.sort((a, b) => a.number - b.number)
  const numbers = new Set(asked.map((question) => question.number))
  if (numbers.size !== asked.length || [...texts.keys()].some((n) => !numbers.has(n))) return null
  const ask: AgyAsk = { questions: [], fields: [] }
  for (const { number, key, field } of asked) {
    const multiple = field.type === 'array'
    const choices = multiple ? options(record(field.items)?.anyOf) : options(field.oneOf)
    if (!choices || (!multiple && field.type !== 'string')) return null
    if (typeof field.title !== 'string' || field.title === '') return null
    const other = texts.get(number) ?? null
    ask.questions.push({
      header: '',
      question: field.title,
      multiSelect: multiple,
      options: choices.map((choice) => ({ label: choice.label })),
      allowsText: other !== null,
      secret: false,
    })
    ask.fields.push({ key, multiple, values: choices.map((choice) => choice.value), other })
  }
  return ask
}

/** The form's content for the user's answers; a question left unanswered has no field. */
export function askContent(
  ask: AgyAsk,
  answers: readonly QuestionAnswer[],
): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {}
  for (const answer of answers) {
    const field = ask.fields[answer.question]
    if (!field) continue
    const picked = [...answer.choices]
      .sort((a, b) => a - b)
      .flatMap((index) => field.values[index] ?? [])
    if (field.multiple && picked.length > 0) content[field.key] = picked
    else if (!field.multiple && picked[0] !== undefined) content[field.key] = picked[0]
    const text = answer.text?.trim()
    if (text && field.other) content[field.other] = text
  }
  return content
}

/**
 * The first question's choices and Something else, which a client that shows no questions answers
 * with: a choice answers the first question alone, Something else leaves it to the chat.
 */
function askOptions(ask: AgyAsk): PermissionOption[] {
  return [
    ...ask.questions[0]!.options.map((option, index) => ({
      id: `answer:${index}`,
      name: option.label,
      kind: 'allow_once' as const,
    })),
    { id: 'other', name: t('question.other'), kind: 'reject_once' as const },
  ]
}

/**
 * Shows an ask's form as a question card and answers it: the answered questions accepted, a form
 * nothing was answered in declined, which sends agy to ask in the chat, and a withdrawn or
 * cancelled request cancelled. Null for a form that is not agy's ask, which is not shown.
 */
export async function askInCard(
  params: unknown,
  target: SessionTarget,
  signal: AbortSignal,
): Promise<CreateElicitationResponse | null> {
  const { mode, toolCallId, requestedSchema } = record(params) ?? {}
  if (mode !== 'form' || typeof toolCallId !== 'string' || toolCallId === '') return null
  const ask = agyAsk(requestedSchema)
  if (!ask) return null
  const first = ask.questions[0]!.question
  const call: ToolCallUpdate = { toolCallId, title: first, kind: 'other' }
  const { entryId, output } = mapPermissionToolCall(call, target.context(), first)
  let answer
  try {
    answer = await target.requestPermission(
      {
        toolCallId,
        toolEntryId: entryId,
        output,
        options: askOptions(ask),
        questions: ask.questions,
      },
      signal,
    )
  } catch {
    // Withdrawn: agy no longer waits for the answer.
    return { action: 'cancel' }
  }
  if (answer === 'cancelled' || 'values' in answer) return { action: 'cancel' }
  let answers: readonly QuestionAnswer[] = []
  if ('answers' in answer) {
    answers = answer.answers
  } else {
    const index = /^answer:(\d+)$/.exec(answer.optionId)
    if (index) answers = [{ question: 0, choices: [Number(index[1])] }]
  }
  const content = askContent(ask, answers)
  return Object.keys(content).length > 0 ? { action: 'accept', content } : { action: 'decline' }
}

/**
 * The asks whose card waits for the user, by session and call. agy can stop waiting for an answer
 * without cancelling its request, as it did for a sub-agent's question not answered in time: it
 * only fails the call. Its card is then withdrawn, so a late answer is not shown as given.
 */
export class OpenAsks {
  private readonly open = new Map<string, AbortController>()

  /** Runs `ask` with a signal that also aborts once agy ends the call the form belongs to. */
  async run<T>(
    params: unknown,
    signal: AbortSignal,
    ask: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const { sessionId, toolCallId } = record(params) ?? {}
    if (typeof sessionId !== 'string' || typeof toolCallId !== 'string') return ask(signal)
    const key = `${sessionId}\n${toolCallId}`
    const controller = new AbortController()
    const stop = (): void => controller.abort(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
    this.open.set(key, controller)
    try {
      return await ask(controller.signal)
    } finally {
      signal.removeEventListener('abort', stop)
      if (this.open.get(key) === controller) this.open.delete(key)
    }
  }

  /** Withdraws the card of an ask whose call agy finished or failed while the card waited. */
  ended(sessionId: string, update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call_update') return
    if (update.status !== 'completed' && update.status !== 'failed') return
    this.open
      .get(`${sessionId}\n${update.toolCallId}`)
      ?.abort(new Error('agy ended the call its question belongs to'))
  }
}
