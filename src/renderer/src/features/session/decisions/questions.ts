import type { QuestionAnswer, ToolEntry } from '@shared/thread'
import { plainName, respondToPermission, respondToQuestions } from '../entries/helpers'
import type { Ask, AskContext } from './ask'

// An agent marks the option it recommends at the end of its label, as Claude Code is told to.
const RECOMMENDED = /\s*\((?:recommended|推荐)\)\s*$/i

/**
 * An agent's questions on the Decision Card, a page each. An option answers its question at once,
 * a multiple one's rows check and the last row's arrow sends them; the answers go to the agent
 * together once every question has one.
 */
export function questionAsks(entry: ToolEntry, ctx: AskContext): Ask[] {
  const { t, sessionId, agentName } = ctx
  const { requestId, questions } = entry.permission!
  const asked = questions!
  const [given, setGiven] = ctx.state<Record<number, QuestionAnswer>>(`${requestId}:given`, {})
  return asked.flatMap((question, i): Ask[] => {
    if (given[i]) return []
    const header =
      question.header || (asked.length > 1 ? t('question.step', { number: i + 1 }) : '')
    const takesText = question.allowsText || question.options.length === 0
    return [
      {
        key: `${requestId}:${i}`,
        group: requestId,
        decision: {
          task: header ? `${agentName} · ${header}` : agentName,
          question: question.question,
          options: question.options.map((option, j) => ({
            id: String(j),
            title: option.label.replace(RECOMMENDED, ''),
            summary: option.description,
            recommended: RECOMMENDED.test(option.label),
          })),
          multiple: question.multiSelect,
          own: !takesText
            ? false
            : question.secret
              ? t('question.secretHint')
              : question.options.length === 0
                ? t('question.typing')
                : t('question.otherTell', { agent: agentName }),
          secret: question.secret,
        },
        answer: (answer) => {
          if (typeof answer !== 'object') return
          const choices = answer.options ?? (answer.option !== undefined ? [answer.option] : [])
          const next = {
            ...given,
            [i]: {
              question: i,
              choices: choices.map(Number).sort((a, b) => a - b),
              ...(answer.text ? { text: answer.text } : {}),
            },
          }
          setGiven(next)
          if (Object.keys(next).length < asked.length) return
          // Answers that did not go are asked again, every question with them.
          void ctx
            .go(requestId, () =>
              respondToQuestions(
                sessionId,
                requestId,
                Object.values(next).sort((a, b) => a.question - b.question),
              ),
            )
            .then((sent) => {
              if (!sent) setGiven({})
            })
        },
      },
    ]
  })
}

/**
 * A question asked as a request for permission, whose allows are its answers. The last row takes
 * the agent's answer that leaves it to the user's next message, which their words then are.
 */
export function optionQuestionAsk(entry: ToolEntry, ctx: AskContext): Ask {
  const { t, sessionId, agentName } = ctx
  const { requestId, options } = entry.permission!
  const choices = options.filter((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
  const elsewhere = options.find((o) => !choices.includes(o)) ?? null
  return {
    key: requestId,
    group: requestId,
    decision: {
      task: agentName,
      question: entry.question ?? '',
      options: choices.map((option) => ({
        id: option.id,
        title: plainName(option.name).replace(RECOMMENDED, ''),
        summary: option.description,
        recommended: RECOMMENDED.test(option.name),
      })),
      own: elsewhere ? t('question.otherTell', { agent: agentName }) : false,
    },
    answer: (answer) => {
      if (typeof answer !== 'object') return
      const option = choices.find((o) => o.id === answer.option)
      if (option) {
        void ctx.go(requestId, () => respondToPermission(sessionId, requestId, option.id))
      } else if (answer.text && elsewhere) {
        const text = answer.text
        void ctx.go(requestId, async () => {
          await respondToPermission(sessionId, requestId, elsewhere.id)
          await ctx.say(text)
        })
      }
    },
  }
}
