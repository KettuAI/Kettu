// Questions Codex asks through `request_user_input_async`: the tool returns at once, the turn goes
// on, and the question reaches the client as an agent message. The answer goes back as a user
// message in the form Codex's own client sends it.

import type { AsyncUserInputQuestion, ThreadItem } from './protocol'

const TOOL = 'request_user_input_async'
const TAG = 'send_user_message_question_reply'

export type AsyncQuestionItem = Extract<ThreadItem, { type: 'agentMessage' }> & {
  questions: AsyncUserInputQuestion[]
}

/** An agent message that carries questions for the user to answer. */
export function isAsyncQuestion(item: ThreadItem): item is AsyncQuestionItem {
  return (
    item.type === 'agentMessage' &&
    item.delivery === 'async' &&
    Array.isArray(item.questions) &&
    item.questions.length > 0
  )
}

/** The questions with their choices as a list, for a step that no card answers. */
export function questionsMarkdown(questions: readonly AsyncUserInputQuestion[]): string {
  return questions
    .map((question, index) => {
      const choices = (question.options ?? []).map((choice) => `\n   - ${choice}`).join('')
      return `${index + 1}. ${question.title}${choices}`
    })
    .join('\n')
}

export interface QuestionReply {
  itemId: string
  index: number
  question: string
  answer: string
}

/** The message that answers questions of one item; a question left out is a skipped one. */
export function replyText(answers: readonly QuestionReply[]): string {
  const body = answers.map(({ itemId, index, question, answer }) => ({
    questionItemId: JSON.stringify([TOOL, itemId, index]),
    question,
    answer,
  }))
  return `<${TAG}>\n${JSON.stringify(body)}\n</${TAG}>`
}

/** The answers a reply message holds; null for any other message, or one that is not well formed. */
export function parseReply(text: string): QuestionReply[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(`<${TAG}>`) || !trimmed.endsWith(`</${TAG}>`)) return null
  let body: unknown
  try {
    body = JSON.parse(trimmed.slice(TAG.length + 2, -(TAG.length + 3)))
  } catch {
    return null
  }
  if (!Array.isArray(body) || body.length === 0) return null
  const replies: QuestionReply[] = []
  for (const entry of body as unknown[]) {
    const { questionItemId, question, answer } = (entry ?? {}) as Record<string, unknown>
    if (typeof questionItemId !== 'string' || typeof answer !== 'string') return null
    let key: unknown
    try {
      key = JSON.parse(questionItemId)
    } catch {
      return null
    }
    if (!Array.isArray(key) || key[0] !== TOOL) return null
    const [, itemId, index] = key as unknown[]
    if (typeof itemId !== 'string' || typeof index !== 'number') return null
    replies.push({ itemId, index, question: typeof question === 'string' ? question : '', answer })
  }
  return replies
}
