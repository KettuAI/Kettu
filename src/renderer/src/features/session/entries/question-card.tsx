import { useMemo, useRef, useState, type Ref } from 'react'
import { Cancel01Icon, CheckmarkCircle02Icon, LockIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AnsweredQuestion, PendingQuestion, PermissionOption, ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  ExperimentCard,
  type ExperimentLabels,
  type ExperimentMetric,
} from '@renderer/components/affect/experiment-card'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { codeSpans, respondToPermission, respondToQuestions } from './helpers'
import {
  choose,
  chooseOwn,
  goTo,
  isAnswered,
  startQuestions,
  toAnswers,
  typeText,
  withDraft,
  type QuestionState,
} from './question-state'
import { useAnswering } from './use-answering'

const OWN = 'other'

/** An option's name as plain words; a card's rows set no code. */
const plainName = (name: string): string =>
  codeSpans(name)
    .map((part) => part.text)
    .join('')

/** What every question card shares: the agent's mark, the waiting tag and the last row's words. */
function useChoiceCard(sessionId: string) {
  const { t } = useTranslation('session')
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const labels = useMemo<Partial<ExperimentLabels>>(
    () => ({
      pickOne: t('question.hint.one'),
      pickAny: t('question.hint.any'),
      picked: (count) => t('question.picked', { count }),
      ownAnswer: t('question.ownAnswer'),
      typing: t('question.typing'),
    }),
    [t],
  )
  return {
    kind: 'choice' as const,
    className: 'ks-question',
    mark: agentId ? <AgentMark agent={agentId} size={16} hostId={hostId} /> : undefined,
    status: { label: t('question.asksYou'), tone: 'amber' as const },
    lead: null,
    trigger: 'click' as const,
    defaultOpen: true,
    closeOnOutside: false,
    labels,
  }
}

function hintOf(
  t: ReturnType<typeof useTranslation<'session'>>['t'],
  question: PendingQuestion,
): string {
  if (question.secret) return t('question.secretHint')
  if (question.options.length === 0) return t('question.typing')
  if (question.multiSelect)
    return t(question.allowsText ? 'question.hint.anyOrOwn' : 'question.hint.any')
  return t(question.allowsText ? 'question.hint.oneOrOwn' : 'question.hint.one')
}

/**
 * An agent's questions on affectUI's Experiment Card as a question: its switch steps through the
 * questions and only the last one submits. Each answer is one choice, several or the user's own
 * words; nothing goes until it is submitted.
 */
export function QuestionCard({
  ref,
  sessionId,
  entry,
  agentName,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const shared = useChoiceCard(sessionId)
  const permission = entry.permission!
  const questions = permission.questions!
  const count = questions.length
  const [state, setState] = useState(() => startQuestions(count))
  // The question whose own answer row is picked while it is still empty.
  const [ownOpen, setOwnOpen] = useState<number | null>(null)
  const { answering, error, away, send } = useAnswering(sessionId)
  const root = useRef<HTMLDivElement>(null)
  const busy = away || answering !== null

  const submit = async (from: QuestionState) => {
    if (busy) return
    // An answer from the card's own controls would leave the focus on nothing once the card goes.
    const focused = !!root.current?.contains(document.activeElement)
    const sent = await send('submit', () =>
      respondToQuestions(sessionId, permission.requestId, toAnswers(from)),
    )
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const steps: ExperimentMetric[] = questions.map((asked, i) => ({
    id: String(i),
    label: asked.header || t('question.step', { number: i + 1 }),
  }))
  const switching = {
    metrics: steps,
    metric: String(state.step),
    onMetricChange: (id: string) => setState((s) => goTo(s, Number(id))),
    switchLabel: t('question.steps'),
  }

  const question = questions[state.step]!
  const draft = state.drafts[state.step]!
  const own = ownOpen === state.step || draft.text.trim() !== ''
  const takesText = question.allowsText || question.options.length === 0
  const cleared = withDraft(state, { choices: [], text: '' })
  const last = state.step === count - 1
  const given = state.drafts.filter(isAnswered).length

  return (
    <div ref={ref} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div ref={root} className="min-w-0">
        <ExperimentCard
          key={state.step}
          {...shared}
          {...switching}
          title={question.question}
          note={
            count > 1
              ? t('question.of', { agent: agentName, number: state.step + 1, count })
              : agentName
          }
          variants={question.options.map((option, i) => ({
            id: String(i),
            key: String(i + 1),
            name: option.label,
            description: option.description,
          }))}
          multiple={question.multiSelect}
          picks={
            question.multiSelect ? [...draft.choices.map(String), ...(own ? [OWN] : [])] : undefined
          }
          onPicksChange={(ids) => {
            const choices = ids
              .filter((id) => id !== OWN)
              .map(Number)
              .sort((a, b) => a - b)
            const keepsOwn = ids.includes(OWN)
            setOwnOpen(keepsOwn ? state.step : null)
            setState((s) =>
              withDraft(s, { choices, text: keepsOwn ? (s.drafts[s.step]?.text ?? '') : '' }),
            )
          }}
          winner={
            question.multiSelect
              ? undefined
              : own
                ? OWN
                : draft.choices[0] !== undefined
                  ? String(draft.choices[0])
                  : null
          }
          onWinnerChange={(id) => {
            if (id === OWN) {
              setOwnOpen(state.step)
              setState((s) => chooseOwn(s, question))
            } else if (id === null) {
              setOwnOpen(null)
              setState((s) => withDraft(s, { choices: [], text: '' }))
            } else {
              setOwnOpen(null)
              setState((s) => choose(s, question, Number(id)))
            }
          }}
          other={
            takesText
              ? {
                  id: OWN,
                  placeholder:
                    question.options.length === 0
                      ? t('question.otherPlaceholder')
                      : t('question.otherTell', { agent: agentName }),
                  value: draft.text,
                  onChange: (text) => setState((s) => typeText(s, question, text)),
                  secret: question.secret,
                }
              : undefined
          }
          hint={hintOf(t, question)}
          // On the last question an unanswered Skip would only repeat the main button.
          secondary={
            last && count > 1 && !isAnswered(draft)
              ? undefined
              : {
                  label: t('question.skip'),
                  onClick: () => {
                    setOwnOpen(null)
                    if (last) void submit(cleared)
                    else setState(goTo(cleared, state.step + 1))
                  },
                }
          }
          actionReady={last && count > 1}
          action={{
            label: !last
              ? t('question.next')
              : t(given > 0 || count === 1 ? 'question.submit' : 'question.skipAll'),
            onClick: () => (last ? void submit(state) : setState((s) => goTo(s, s.step + 1))),
          }}
        />
      </div>
      <CardError error={error} />
    </div>
  )
}

/**
 * A question asked as a request for permission, whose options are its answers: the choices as the
 * card's rows, and the agent's answer that leaves it to the user's next message as Skip's place.
 */
export function OptionQuestionCard({
  ref,
  sessionId,
  entry,
  agentName,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const shared = useChoiceCard(sessionId)
  const permission = entry.permission!
  const [winner, setWinner] = useState<string | null>(null)
  const { answering, error, away, send } = useAnswering(sessionId)
  const root = useRef<HTMLDivElement>(null)
  const choices = permission.options.filter(
    (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
  )
  const elsewhere = permission.options.find((o) => !choices.includes(o)) ?? null

  const respond = async (option: PermissionOption | undefined) => {
    if (!option || away || answering !== null) return
    const focused = !!root.current?.contains(document.activeElement)
    const sent = await send(option.id, () =>
      respondToPermission(sessionId, permission.requestId, option.id),
    )
    // The answer of the user's own goes on in the composer.
    if (sent && (focused || option === elsewhere)) emitAppEvent({ kind: 'focus-composer' })
  }

  return (
    <div ref={ref} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div ref={root} className="min-w-0">
        <ExperimentCard
          {...shared}
          metrics={[]}
          title={entry.question ?? ''}
          note={agentName}
          variants={choices.map((option, i) => ({
            id: option.id,
            key: String(i + 1),
            name: plainName(option.name),
            description: option.description,
          }))}
          winner={winner}
          onWinnerChange={setWinner}
          hint={t('question.hint.one')}
          secondary={
            elsewhere
              ? { label: plainName(elsewhere.name), onClick: () => void respond(elsewhere) }
              : undefined
          }
          action={{
            label: t('question.submit'),
            onClick: (variant) => void respond(choices.find((o) => o.id === variant.id)),
          }}
        />
      </div>
      <CardError error={error} />
    </div>
  )
}

function CardError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="ks-card-error">
      {error}
    </p>
  )
}

/** An ask once answered: how many questions got an answer, and each question over its answer. */
export function AnsweredAsk({
  questions,
  device,
}: {
  questions: AnsweredQuestion[]
  device: string | null
}) {
  const { t } = useTranslation('session')
  const given = questions.filter((q) => q.answered).length
  return (
    <div className="ks-answered" data-kind={given > 0 ? 'done' : 'other'}>
      <div className="ks-answered__head">
        <Icon icon={given > 0 ? CheckmarkCircle02Icon : Cancel01Icon} size={16} />
        <span className="ks-answered__title">
          {given === 0
            ? t('question.skipped')
            : questions.length === 1
              ? t('question.answeredOne')
              : t('question.answered', { answered: given, total: questions.length })}
        </span>
        {device && <span className="ks-answered__device">· {device}</span>}
      </div>
      <ul className="ks-answered__list">
        {questions.map((asked, i) => (
          <li key={i}>
            <span data-selectable="" className="ks-answered__question">
              {asked.question}
            </span>
            {asked.answer !== undefined ? (
              <span data-selectable="" className="ks-answered__answer">
                {asked.answer}
              </span>
            ) : asked.answered ? (
              <span className="ks-answered__answer ks-answered__answer--quiet">
                <Icon icon={LockIcon} size={13} />
                {t('question.secret')}
              </span>
            ) : (
              <span className="ks-answered__answer ks-answered__answer--quiet">
                {t('question.skipped')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
