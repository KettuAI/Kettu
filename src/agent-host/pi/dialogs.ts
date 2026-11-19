// What an extension of Pi asks through its UI, such as ask-user-question: a choice, a confirmation
// or a text. Pi's own tools ask nothing; these dialogs are the only thing a Pi session waits on.

import type { PendingPermission, PendingQuestion } from '@shared/thread'
import type { PermissionAnswer } from '../connection'
import { t } from '../i18n'
import type { PiUiAnswer, PiUiRequest } from './protocol'

const CHOICE = 'choice-'
const YES = 'yes'
const NO = 'no'
const OTHER = 'other'

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * An extension's labels often read "1. Name - what it means". The card numbers its rows itself and
 * sets what a choice means on a second line, so the number and the dash are taken out.
 */
export function shapeChoice(label: string, index: number): { name: string; description?: string } {
  const own = new RegExp(`^\\s*${index + 1}[.)]\\s+`)
  const text = label.replace(own, '').trim() || label.trim()
  const cut = text.indexOf(' — ')
  if (cut <= 0) return { name: text }
  const description = text.slice(cut + 3).trim()
  return description ? { name: text.slice(0, cut).trim(), description } : { name: text }
}

/** A dialog as the card that asks it, and the answer pi takes for what the user gave. */
export interface Dialog {
  /** What it asks, which the card and its row show. */
  question: string
  /** Text that goes with it and is no part of the question, such as an editor's first content. */
  detail?: string
  options: PendingPermission['options']
  questions?: PendingQuestion[]
  answer(answer: PermissionAnswer): PiUiAnswer
}

const CANCELLED: PiUiAnswer = { cancelled: true }

/** The dialog an extension's request opens; null for one that asks nothing of the user. */
export function dialogOf(request: PiUiRequest): Dialog | null {
  const title = asString(request.title)
  switch (request.method) {
    case 'select': {
      const choices = Array.isArray(request.options) ? request.options.map(String) : []
      if (choices.length === 0 || !title) return null
      return {
        question: title,
        options: choices.map((choice, index) => ({
          id: `${CHOICE}${index}`,
          kind: 'allow_once',
          ...shapeChoice(choice, index),
        })),
        answer: (answer) => {
          if (answer === 'cancelled' || !('optionId' in answer)) return CANCELLED
          if (!answer.optionId.startsWith(CHOICE)) return CANCELLED
          const value = choices[Number(answer.optionId.slice(CHOICE.length))]
          return value === undefined ? CANCELLED : { value }
        },
      }
    }
    case 'confirm': {
      const message = asString(request.message)
      const question = [title, message].filter(Boolean).join('\n\n')
      if (!question) return null
      return {
        question,
        options: [
          { id: YES, name: t('elicitation.yes'), kind: 'allow_once' },
          { id: NO, name: t('elicitation.no'), kind: 'reject_once' },
        ],
        answer: (answer) =>
          answer === 'cancelled' || !('optionId' in answer)
            ? CANCELLED
            : { confirmed: answer.optionId === YES },
      }
    }
    case 'input':
    case 'editor': {
      if (!title) return null
      const detail = asString(request.method === 'editor' ? request.prefill : request.placeholder)
      return {
        question: title,
        ...(detail ? { detail } : {}),
        // For a client that shows no questions: its only option leaves the dialog unanswered.
        options: [{ id: OTHER, name: t('question.other'), kind: 'reject_once' }],
        questions: [
          {
            header: '',
            question: title,
            multiSelect: false,
            options: [],
            allowsText: true,
            secret: false,
          },
        ],
        answer: (answer) => {
          if (answer === 'cancelled' || !('answers' in answer)) return CANCELLED
          const text = answer.answers.find((given) => given.question === 0)?.text
          return text && text.trim() !== '' ? { value: text } : CANCELLED
        },
      }
    }
    default:
      return null
  }
}
