// A choice an extension of Pi asks with its select UI, such as ask-user-question. pi-acp 0.0.34
// sends it as a request for permission whose options are all "allow once", with the call's raw input
// naming the method, so it is told apart from a real permission by that shape.

import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { PendingPermission } from '@shared/thread'

export interface SelectQuestion {
  question: string
  options: PendingPermission['options']
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * An extension's labels often read "1. Name - what it means". The card numbers its rows itself and
 * sets what a choice means on a second line, so the number and the dash are taken out.
 */
function shapeChoice(label: string, index: number): { name: string; description?: string } {
  const own = new RegExp(`^\\s*${index + 1}[.)]\\s+`)
  const text = label.replace(own, '').trim() || label.trim()
  const cut = text.indexOf(' — ')
  if (cut <= 0) return { name: text }
  const description = text.slice(cut + 3).trim()
  return description ? { name: text.slice(0, cut).trim(), description } : { name: text }
}

/** The question and its choices when the request is an extension's select, else null. */
export function selectQuestion(
  toolCall: Pick<acp.ToolCallUpdate, 'title' | 'rawInput'>,
  options: readonly acp.PermissionOption[],
): SelectQuestion | null {
  const input = toolCall.rawInput
  if (typeof input !== 'object' || input === null) return null
  const { method, options: choices, title } = input as Record<string, unknown>
  if (method !== 'select' || !Array.isArray(choices)) return null
  if (options.length === 0 || options.length !== choices.length) return null
  const alike = options.every(
    (option, i) => option.kind === 'allow_once' && option.name === String(choices[i]),
  )
  if (!alike) return null
  const question = asString(title) || asString(toolCall.title)
  if (!question) return null
  return {
    question,
    options: options.map((option, i) => ({
      id: option.optionId,
      kind: 'allow_once',
      ...shapeChoice(option.name, i),
    })),
  }
}
