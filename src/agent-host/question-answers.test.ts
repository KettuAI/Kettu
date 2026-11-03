import { describe, expect, it } from 'vitest'
import type { PendingQuestion } from '@shared/thread'
import { answeredQuestions, answerWords, checkAnswers, questionsResult } from './question-answers'

const where: PendingQuestion = {
  header: 'Where',
  question: 'Fix it here or in a separate session?',
  multiSelect: false,
  options: [{ label: 'Fix it here' }, { label: 'Separate session', description: 'Smaller' }],
  allowsText: true,
  secret: false,
}
const which: PendingQuestion = {
  header: 'Which',
  question: 'Which checks should run?',
  multiSelect: true,
  options: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }],
  allowsText: true,
  secret: false,
}
const token: PendingQuestion = {
  header: 'Token',
  question: 'What is the API token?',
  multiSelect: false,
  options: [],
  allowsText: true,
  secret: true,
}
const fixed: PendingQuestion = { ...where, allowsText: false }

function rejects(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
}

describe('checkAnswers', () => {
  it('accepts a choice, several choices, a typed answer and no answer at all', () => {
    expect(() => checkAnswers([where, which], [])).not.toThrow()
    expect(() =>
      checkAnswers(
        [where, which],
        [
          { question: 0, choices: [1] },
          { question: 1, choices: [0, 2], text: 'and a build' },
        ],
      ),
    ).not.toThrow()
    expect(() =>
      checkAnswers([where], [{ question: 0, choices: [], text: 'In a branch' }]),
    ).not.toThrow()
  })

  it('rejects a question or a choice that is not there, or named twice', () => {
    rejects(() => checkAnswers([where], [{ question: 1, choices: [0] }]))
    rejects(() => checkAnswers([where], [{ question: 0, choices: [2] }]))
    rejects(() => checkAnswers([which], [{ question: 0, choices: [1, 1] }]))
    rejects(() =>
      checkAnswers(
        [where],
        [
          { question: 0, choices: [0] },
          { question: 0, choices: [1] },
        ],
      ),
    )
  })

  it('takes one answer for a single-select question', () => {
    rejects(() => checkAnswers([where], [{ question: 0, choices: [0, 1] }]))
    rejects(() => checkAnswers([where], [{ question: 0, choices: [0], text: 'both' }]))
  })

  it('takes typed text only where the question allows it, and never an empty answer', () => {
    rejects(() => checkAnswers([fixed], [{ question: 0, choices: [], text: 'mine' }]))
    rejects(() => checkAnswers([where], [{ question: 0, choices: [] }]))
    rejects(() => checkAnswers([where], [{ question: 0, choices: [], text: '   ' }]))
  })
})

describe('answerWords', () => {
  it('lists the chosen labels in the agent order, then the typed text', () => {
    expect(answerWords(which, { question: 1, choices: [2, 0], text: ' and a build ' })).toEqual([
      'Lint',
      'Tests',
      'and a build',
    ])
    expect(answerWords(where, { question: 0, choices: [], text: 'In a branch' })).toEqual([
      'In a branch',
    ])
  })
})

describe('answeredQuestions', () => {
  it('lists every question in order with what it got, and leaves a secret answer out', () => {
    expect(
      answeredQuestions(
        [where, which, token],
        [
          { question: 2, choices: [], text: 's3cret' },
          { question: 1, choices: [0, 1] },
        ],
      ),
    ).toEqual([
      { question: where.question, answered: false },
      { question: which.question, answered: true, answer: 'Lint, Types' },
      { question: token.question, answered: true },
    ])
  })
})

describe('questionsResult', () => {
  it('records the answered questions, with the device that answered', () => {
    expect(
      questionsResult([where, which], [{ question: 1, choices: [2] }], {
        id: 'd1',
        name: 'iPhone',
      }),
    ).toEqual({
      optionId: 'answers',
      kind: 'allow_once',
      questions: [
        { question: where.question, answered: false },
        { question: which.question, answered: true, answer: 'Tests' },
      ],
      device: { id: 'd1', name: 'iPhone' },
    })
  })

  it('reads as a refusal when every question was skipped, and rejects answers that do not fit', () => {
    expect(questionsResult([where], [])).toMatchObject({
      kind: 'reject_once',
      questions: [{ question: where.question, answered: false }],
    })
    rejects(() => questionsResult([where], [{ question: 4, choices: [0] }]))
  })
})
