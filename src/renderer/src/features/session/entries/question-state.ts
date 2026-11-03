// What a question card holds while the user answers: a draft per question and the one shown.

import type { PendingQuestion, QuestionAnswer } from '@shared/thread'

export interface QuestionDraft {
  choices: number[]
  text: string
}

export interface QuestionState {
  step: number
  drafts: QuestionDraft[]
}

export function startQuestions(count: number): QuestionState {
  return { step: 0, drafts: Array.from({ length: count }, () => ({ choices: [], text: '' })) }
}

export function isAnswered(draft: QuestionDraft): boolean {
  return draft.choices.length > 0 || draft.text.trim() !== ''
}

export function answeredCount(state: QuestionState): number {
  return state.drafts.filter(isAnswered).length
}

function withDraft(state: QuestionState, draft: QuestionDraft): QuestionState {
  return { ...state, drafts: state.drafts.map((d, i) => (i === state.step ? draft : d)) }
}

/** Selects a choice of the question shown: one at a time, or toggled when several may be. */
export function choose(
  state: QuestionState,
  question: PendingQuestion,
  index: number,
): QuestionState {
  const draft = state.drafts[state.step]
  if (!draft) return state
  if (!question.multiSelect) return withDraft(state, { choices: [index], text: '' })
  const choices = draft.choices.includes(index)
    ? draft.choices.filter((choice) => choice !== index)
    : [...draft.choices, index].sort((a, b) => a - b)
  return withDraft(state, { ...draft, choices })
}

/** Sets the text of the question shown; written text replaces the choice of a single-select one. */
export function typeText(
  state: QuestionState,
  question: PendingQuestion,
  text: string,
): QuestionState {
  const draft = state.drafts[state.step]
  if (!draft) return state
  const replaces = !question.multiSelect && text.trim() !== ''
  return withDraft(state, { choices: replaces ? [] : draft.choices, text })
}

/** Leaves the question shown unanswered and goes on to the next, if there is one. */
export function skipStep(state: QuestionState): QuestionState {
  const cleared = withDraft(state, { choices: [], text: '' })
  return goTo(cleared, state.step + 1)
}

export function goTo(state: QuestionState, step: number): QuestionState {
  return { ...state, step: Math.min(Math.max(step, 0), state.drafts.length - 1) }
}

/** The answered questions only, which is what a submit gives the agent. */
export function toAnswers(state: QuestionState): QuestionAnswer[] {
  const answers: QuestionAnswer[] = []
  state.drafts.forEach((draft, question) => {
    if (!isAnswered(draft)) return
    const text = draft.text.trim()
    answers.push({ question, choices: draft.choices, ...(text ? { text } : {}) })
  })
  return answers
}

export type KeyIntent = 'previous' | 'next' | 'submit'

/**
 * What a key does in the card: the arrows switch question outside the text field, and Enter goes
 * on to the next question or submits from the last, unless a button has its own Enter or an IME
 * is composing.
 */
export function keyIntent(
  event: { key: string; isComposing: boolean },
  at: { step: number; count: number; inText: boolean; onButton: boolean },
): KeyIntent | null {
  if (event.isComposing) return null
  const last = at.step >= at.count - 1
  switch (event.key) {
    case 'ArrowLeft':
      return at.inText || at.step === 0 ? null : 'previous'
    case 'ArrowRight':
      return at.inText || last ? null : 'next'
    case 'Enter':
      if (at.onButton) return null
      return last ? 'submit' : 'next'
    default:
      return null
  }
}
