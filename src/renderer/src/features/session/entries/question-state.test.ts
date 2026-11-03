import { describe, expect, it } from 'vitest'
import type { PendingQuestion } from '@shared/thread'
import {
  answeredCount,
  choose,
  goTo,
  isAnswered,
  keyIntent,
  skipStep,
  startQuestions,
  toAnswers,
  typeText,
} from './question-state'

const single: PendingQuestion = {
  header: 'Where',
  question: 'Where?',
  multiSelect: false,
  options: [{ label: 'Here' }, { label: 'There' }],
  allowsText: true,
  secret: false,
}
const many: PendingQuestion = { ...single, header: 'Which', question: 'Which?', multiSelect: true }

describe('startQuestions', () => {
  it('starts on the first question with nothing answered', () => {
    expect(startQuestions(3)).toEqual({
      step: 0,
      drafts: [
        { choices: [], text: '' },
        { choices: [], text: '' },
        { choices: [], text: '' },
      ],
    })
  })
})

describe('choose', () => {
  it('selects one choice of a single-select question and drops what was typed', () => {
    let state = typeText(startQuestions(1), single, 'mine')
    state = choose(state, single, 1)
    expect(state.drafts[0]).toEqual({ choices: [1], text: '' })
    state = choose(state, single, 0)
    expect(state.drafts[0]).toEqual({ choices: [0], text: '' })
    // Choosing the chosen one again keeps it, as a radio does.
    expect(choose(state, single, 0).drafts[0]).toEqual({ choices: [0], text: '' })
  })

  it('toggles the choices of a multi-select question and keeps what was typed', () => {
    let state = typeText(startQuestions(1), many, 'more')
    state = choose(choose(state, many, 1), many, 0)
    expect(state.drafts[0]).toEqual({ choices: [0, 1], text: 'more' })
    state = choose(state, many, 1)
    expect(state.drafts[0]).toEqual({ choices: [0], text: 'more' })
  })

  it('acts on the question the card is on', () => {
    const state = choose(goTo(startQuestions(2), 1), single, 1)
    expect(state.drafts).toEqual([
      { choices: [], text: '' },
      { choices: [1], text: '' },
    ])
  })
})

describe('typeText', () => {
  it('replaces the choice of a single-select question once something is typed', () => {
    let state = choose(startQuestions(1), single, 0)
    // An empty field changes nothing.
    expect(typeText(state, single, '').drafts[0]).toEqual({ choices: [0], text: '' })
    state = typeText(state, single, 'mine')
    expect(state.drafts[0]).toEqual({ choices: [], text: 'mine' })
  })

  it('keeps the choices of a multi-select question', () => {
    const state = typeText(choose(startQuestions(1), many, 0), many, 'and more')
    expect(state.drafts[0]).toEqual({ choices: [0], text: 'and more' })
  })
})

describe('answers', () => {
  it('counts a question as answered by a choice or by text that is not blank', () => {
    expect(isAnswered({ choices: [], text: '' })).toBe(false)
    expect(isAnswered({ choices: [], text: '  ' })).toBe(false)
    expect(isAnswered({ choices: [0], text: '' })).toBe(true)
    expect(isAnswered({ choices: [], text: 'x' })).toBe(true)
  })

  it('gives only the answered questions, with their position and trimmed text', () => {
    let state = startQuestions(3)
    state = choose(goTo(state, 2), many, 1)
    state = typeText(state, many, ' also ')
    state = typeText(goTo(state, 1), single, '  ')
    expect(answeredCount(state)).toBe(1)
    expect(toAnswers(state)).toEqual([{ question: 2, choices: [1], text: 'also' }])
    expect(toAnswers(startQuestions(2))).toEqual([])
  })
})

describe('goTo', () => {
  it('stays inside the questions', () => {
    expect(goTo(startQuestions(3), 7).step).toBe(2)
    expect(goTo(startQuestions(3), -1).step).toBe(0)
  })
})

describe('skipStep', () => {
  it('clears the question shown and goes on, staying on the last one', () => {
    let state = choose(startQuestions(2), single, 1)
    state = skipStep(state)
    expect(state.step).toBe(1)
    expect(state.drafts[0]).toEqual({ choices: [], text: '' })
    state = skipStep(choose(state, single, 0))
    expect(state.step).toBe(1)
    expect(state.drafts[1]).toEqual({ choices: [], text: '' })
  })
})

describe('keyIntent', () => {
  const at = { step: 1, count: 3, inText: false, onButton: false }

  it('moves between questions with the arrows, but not inside the text field', () => {
    expect(keyIntent({ key: 'ArrowLeft', isComposing: false }, at)).toBe('previous')
    expect(keyIntent({ key: 'ArrowRight', isComposing: false }, at)).toBe('next')
    expect(keyIntent({ key: 'ArrowRight', isComposing: false }, { ...at, inText: true })).toBeNull()
    expect(keyIntent({ key: 'ArrowLeft', isComposing: false }, { ...at, step: 0 })).toBeNull()
    expect(keyIntent({ key: 'ArrowRight', isComposing: false }, { ...at, step: 2 })).toBeNull()
  })

  it('goes on with Enter, and submits on the last question', () => {
    expect(keyIntent({ key: 'Enter', isComposing: false }, at)).toBe('next')
    expect(keyIntent({ key: 'Enter', isComposing: false }, { ...at, step: 2 })).toBe('submit')
    expect(keyIntent({ key: 'Enter', isComposing: false }, { ...at, step: 0, count: 1 })).toBe(
      'submit',
    )
    expect(keyIntent({ key: 'Enter', isComposing: false }, { ...at, inText: true })).toBe('next')
  })

  it('leaves Enter to a button that has its own, and ignores IME composition', () => {
    expect(keyIntent({ key: 'Enter', isComposing: false }, { ...at, onButton: true })).toBeNull()
    expect(keyIntent({ key: 'Enter', isComposing: true }, { ...at, inText: true })).toBeNull()
    expect(keyIntent({ key: 'ArrowRight', isComposing: true }, at)).toBeNull()
    expect(keyIntent({ key: 'a', isComposing: false }, at)).toBeNull()
  })
})
