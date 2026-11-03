// What a user's answers to an ask's questions may hold, and what the card keeps of them.

import type {
  AnsweredQuestion,
  FromDevice,
  PendingQuestion,
  QuestionAnswer,
  ToolEntry,
} from '@shared/thread'
import { invalidParams } from './errors'

/** The words one answer gives: the chosen labels in the agent's order, then the typed text. */
export function answerWords(question: PendingQuestion, answer: QuestionAnswer): string[] {
  const words = [...answer.choices]
    .sort((a, b) => a - b)
    .map((index) => question.options[index]?.label ?? '')
    .filter((label) => label !== '')
  const text = answer.text?.trim()
  return text ? [...words, text] : words
}

/** Throws unless the answers fit the questions; a question left out is a skipped one. */
export function checkAnswers(
  questions: readonly PendingQuestion[],
  answers: readonly QuestionAnswer[],
): void {
  const seen = new Set<number>()
  for (const answer of answers) {
    const question = questions[answer.question]
    if (!question) throw invalidParams(`There is no question ${answer.question}`)
    if (seen.has(answer.question))
      throw invalidParams(`Question ${answer.question} is answered twice`)
    seen.add(answer.question)
    const choices = new Set(answer.choices)
    if (choices.size !== answer.choices.length) {
      throw invalidParams(`Question ${answer.question} names a choice twice`)
    }
    for (const index of choices) {
      if (!question.options[index]) {
        throw invalidParams(`Question ${answer.question} has no choice ${index}`)
      }
    }
    const text = answer.text?.trim()
    if (text && !question.allowsText) {
      throw invalidParams(`Question ${answer.question} does not take an answer of your own`)
    }
    const given = answer.choices.length + (text ? 1 : 0)
    if (given === 0) throw invalidParams(`Question ${answer.question} has no answer`)
    if (!question.multiSelect && given > 1) {
      throw invalidParams(`Question ${answer.question} takes one answer`)
    }
  }
}

/** Every question with what it got, in order; a secret answer is never kept. */
export function answeredQuestions(
  questions: readonly PendingQuestion[],
  answers: readonly QuestionAnswer[],
): AnsweredQuestion[] {
  return questions.map((question, index) => {
    const answer = answers.find((a) => a.question === index)
    if (!answer) return { question: question.question, answered: false }
    if (question.secret) return { question: question.question, answered: true }
    return {
      question: question.question,
      answered: true,
      answer: answerWords(question, answer).join(', '),
    }
  })
}

// The result's option id when an ask's questions were answered, which is not one option.
export const ANSWERS_OPTION = 'answers'

/**
 * What an ask's answered questions leave on the entry; none answered counts as a refusal, so the
 * thread reads as skipped. Throws when the answers do not fit the questions.
 */
export function questionsResult(
  questions: readonly PendingQuestion[],
  answers: readonly QuestionAnswer[],
  device?: FromDevice,
): Exclude<NonNullable<ToolEntry['permissionResult']>, string> {
  checkAnswers(questions, answers)
  return {
    optionId: ANSWERS_OPTION,
    kind: answers.length > 0 ? 'allow_once' : 'reject_once',
    questions: answeredQuestions(questions, answers),
    ...(device ? { device } : {}),
  }
}
