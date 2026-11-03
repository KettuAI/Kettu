import { useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { CheckIcon, HandIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AnsweredQuestion, PendingQuestion, ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { cn } from '@renderer/lib/utils'
import { NUMBERED, OptionName, WaitingCard, WaitingHeader, WaitingStatus } from './answer-list'
import { respondToQuestions } from './helpers'
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
import { useAnswering } from './use-answering'

const ROW =
  'flex min-h-9 w-full min-w-0 cursor-default items-center gap-2.5 rounded-lg py-1.5 pr-2.5 pl-2 text-left text-row text-foreground outline-none transition-colors duration-(--duration-fast) focus-ring disabled:opacity-60 aria-checked:bg-selected data-checked:bg-selected hover:enabled:bg-hover'

/**
 * An agent's questions as one card: the question shown, its choices and a field for an answer of
 * the user's own, and steps to switch question. Nothing goes until Submit, which sends only the
 * questions that have an answer.
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
  const permission = entry.permission!
  const questions = permission.questions!
  const [state, setState] = useState(() => startQuestions(questions.length))
  const { answering, error, away, send } = useAnswering(sessionId)
  const body = useRef<HTMLDivElement>(null)
  const count = questions.length
  const question = questions[state.step]!
  const draft = state.drafts[state.step]!
  const last = state.step === count - 1
  const given = answeredCount(state)
  const busy = away || answering !== null

  const submit = async () => {
    if (busy) return
    // An answer from the card's own controls would leave the focus on nothing once the card goes.
    const focused = !!body.current?.contains(document.activeElement)
    const sent = await send('submit', () =>
      respondToQuestions(sessionId, permission.requestId, toAnswers(state)),
    )
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const target = event.target as HTMLElement
    const onTab = !!target.closest('[role="tab"]')
    // The tabs move among themselves with the arrows, and a button presses itself with Enter.
    if (onTab && event.key !== 'Enter') return
    const intent = keyIntent(
      { key: event.key, isComposing: event.nativeEvent.isComposing || event.keyCode === 229 },
      {
        step: state.step,
        count,
        inText: target instanceof HTMLInputElement,
        onButton: onTab || !!target.closest('[data-card-action]'),
      },
    )
    if (!intent) return
    event.preventDefault()
    event.stopPropagation()
    if (intent === 'submit') void submit()
    else setState((s) => goTo(s, s.step + (intent === 'next' ? 1 : -1)))
  }

  return (
    <WaitingCard
      ref={ref}
      entryId={entry.id}
      label={t('question.label')}
      description={t('question.ask', { agent: agentName })}
      className={className}
    >
      <WaitingHeader>
        <HandIcon aria-hidden className="size-3.75 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-secondary">
          {t('question.label')}
        </span>
        <WaitingStatus>{t('question.asksYou')}</WaitingStatus>
      </WaitingHeader>
      {/* The card's own keys: the arrows switch question and Enter goes on. */}
      <div ref={body} onKeyDownCapture={onKeyDown} className="flex min-w-0 flex-col">
        {count > 1 && (
          <Tabs
            value={String(state.step)}
            onValueChange={(value) => setState((s) => goTo(s, Number(value)))}
            className="px-3.5 pt-3"
          >
            <TabsList activateOnFocus aria-label={t('question.steps')}>
              {questions.map((asked, i) => {
                const done = isAnswered(state.drafts[i]!)
                return (
                  <TabsTrigger
                    key={i}
                    value={String(i)}
                    disabled={busy}
                    aria-label={t(done ? 'question.stepAnswered' : 'question.step', {
                      number: i + 1,
                    })}
                    title={asked.header || undefined}
                  >
                    {i + 1}
                    {done && <CheckIcon aria-hidden className="size-3" />}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
        )}
        {question.header && (
          <p className="px-3.5 pt-3 text-hint font-medium text-tertiary">{question.header}</p>
        )}
        <p
          data-selectable=""
          className={cn(
            'px-3.5 pb-1 text-row leading-normal text-foreground',
            question.header ? 'pt-0.5' : 'pt-3',
          )}
        >
          {question.question}
        </p>
        {question.multiSelect && (
          <p className="px-3.5 pb-1 text-hint text-tertiary">{t('question.selectMany')}</p>
        )}
        <Choices
          question={question}
          selected={draft.choices}
          text={draft.text}
          disabled={busy}
          onChoose={(index) => setState((s) => choose(s, question, index))}
          onText={(text) => setState((s) => typeText(s, question, text))}
        />
        {error && <p className="mx-3.5 mb-2.5 text-xs text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2 border-t border-border-soft px-3.5 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            data-card-action=""
            disabled={busy || (last && !isAnswered(draft))}
            onClick={() => setState(skipStep)}
          >
            {t('question.skip')}
          </Button>
          {!last && (
            <Button
              size="sm"
              data-card-action=""
              data-answer-enter=""
              disabled={busy}
              onClick={() => setState((s) => goTo(s, s.step + 1))}
            >
              {t('question.next')}
            </Button>
          )}
          <Button
            variant={last ? 'default' : 'outline'}
            size="sm"
            data-card-action=""
            data-answer-enter={last ? '' : undefined}
            disabled={busy}
            onClick={() => void submit()}
          >
            {answering === 'submit' && <Spinner className="size-3.5" />}
            {given > 0 ? t('question.submit') : t(count > 1 ? 'question.skipAll' : 'question.skip')}
          </Button>
        </div>
      </div>
    </WaitingCard>
  )
}

/** A question's choices, then the field for an answer of the user's own. */
function Choices({
  question,
  selected,
  text,
  disabled,
  onChoose,
  onText,
}: {
  question: PendingQuestion
  selected: number[]
  text: string
  disabled: boolean
  onChoose: (index: number) => void
  onText: (text: string) => void
}) {
  const { t } = useTranslation('session')
  const options = question.options
  const own = options.length
  return (
    <div
      role={question.multiSelect ? 'group' : 'radiogroup'}
      aria-label={question.question}
      className="flex flex-col gap-px p-1.5"
    >
      {options.map((option, i) => {
        const chosen = selected.includes(i)
        return (
          <button
            key={i}
            type="button"
            role={question.multiSelect ? 'checkbox' : 'radio'}
            aria-checked={chosen}
            disabled={disabled}
            data-answer-option={i < NUMBERED ? i + 1 : undefined}
            aria-keyshortcuts={i < NUMBERED ? String(i + 1) : undefined}
            onClick={() => onChoose(i)}
            className={ROW}
          >
            {i < NUMBERED ? (
              <Kbd
                aria-hidden
                variant={chosen ? 'primary' : 'default'}
                className="h-5 min-w-5 rounded-md text-key font-semibold"
              >
                {i + 1}
              </Kbd>
            ) : (
              <span aria-hidden className="size-5 shrink-0" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="min-w-0 truncate">
                <OptionName name={option.label} />
              </span>
              {option.description && (
                <span className="min-w-0 truncate text-hint text-tertiary">
                  {option.description}
                </span>
              )}
            </span>
            {chosen && <CheckIcon aria-hidden className="size-3.5 shrink-0 text-secondary" />}
          </button>
        )
      })}
      {question.allowsText && (
        <div
          data-checked={text.trim() !== '' ? '' : undefined}
          className={cn(ROW, 'cursor-text py-1')}
        >
          {own < NUMBERED ? (
            <Kbd
              aria-hidden
              variant={text.trim() !== '' ? 'primary' : 'default'}
              className="h-5 min-w-5 rounded-md text-key font-semibold"
            >
              {own + 1}
            </Kbd>
          ) : (
            <span aria-hidden className="size-5 shrink-0" />
          )}
          <Input
            type={question.secret ? 'password' : 'text'}
            autoComplete="off"
            value={text}
            disabled={disabled}
            placeholder={t('question.other')}
            aria-label={t('question.other')}
            data-answer-option={own < NUMBERED ? own + 1 : undefined}
            onChange={(event) => onText(event.target.value)}
            className="h-7 flex-1 border-transparent bg-transparent shadow-none"
          />
        </div>
      )}
    </div>
  )
}

/** What each question of an answered ask got, under the row that says how many were answered. */
export function AnsweredQuestions({ questions }: { questions: AnsweredQuestion[] }) {
  const { t } = useTranslation('session')
  return (
    <ul className="flex flex-col gap-2">
      {questions.map((asked, i) => (
        <li key={i} className="flex min-w-0 flex-col text-control">
          <span data-selectable="" className="text-secondary">
            {asked.question}
          </span>
          <span
            data-selectable=""
            className={cn('wrap-anywhere', asked.answered ? 'text-foreground' : 'text-tertiary')}
          >
            {asked.answer ?? (asked.answered ? t('question.secret') : t('question.skipped'))}
          </span>
        </li>
      ))}
    </ul>
  )
}
