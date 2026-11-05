import { useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { CheckIcon, EyeOffIcon, LockIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AnsweredQuestion, PendingQuestion, ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { cn } from '@renderer/lib/utils'
import {
  AgentWho,
  CardError,
  CardFooter,
  CheckMark,
  ConfirmButton,
  FooterButton,
  NUMBERED,
  OptionName,
  RadioMark,
  TileKey,
  WaitingCard,
  WaitingHeader,
  WaitingStatus,
} from './answer-list'
import { isConfirmKey, tileClass } from './card-style'
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

/** Choices this short sit two to a row on a question that takes several. */
const SHORT_LABEL = 28
const SHORT_DESCRIPTION = 44

function twoPerRow(question: PendingQuestion): boolean {
  return (
    question.multiSelect &&
    question.options.length > 1 &&
    question.options.every(
      (option) =>
        option.label.length <= SHORT_LABEL &&
        (option.description?.length ?? 0) <= SHORT_DESCRIPTION,
    )
  )
}

/**
 * An agent's questions as one card: the question shown, its choices as tiles and a tile for an
 * answer of the user's own, and steps to switch question. Nothing goes until Submit, which sends
 * only the questions that have an answer.
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

  const confirm = () => {
    if (last) void submit()
    else setState((s) => goTo(s, s.step + 1))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isConfirmKey(event)) {
      event.preventDefault()
      event.stopPropagation()
      confirm()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const target = event.target as HTMLElement
    const onTab = !!target.closest('[role="tab"]')
    // The tabs move among themselves with the arrows, and a tile or button presses itself.
    if (onTab && event.key !== 'Enter') return
    const intent = keyIntent(
      { key: event.key, isComposing: event.nativeEvent.isComposing || event.keyCode === 229 },
      {
        step: state.step,
        count,
        inText: target instanceof HTMLInputElement,
        onButton:
          onTab || !!target.closest('[data-card-action], [role="radio"], [role="checkbox"]'),
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
        <AgentWho
          sessionId={sessionId}
          name={agentName}
          sub={count > 1 ? t('question.count', { count }) : question.header || null}
        />
        <WaitingStatus>{t('question.asksYou')}</WaitingStatus>
      </WaitingHeader>
      {/* The card's own keys: the arrows switch question, Enter goes on, Mod+Enter confirms. */}
      <div ref={body} onKeyDownCapture={onKeyDown} className="flex min-w-0 flex-col">
        {count > 1 && (
          <Tabs
            value={String(state.step)}
            onValueChange={(value) => setState((s) => goTo(s, Number(value)))}
            className="px-5 pt-3"
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
                    {done && i !== state.step ? (
                      <CheckIcon aria-hidden strokeWidth={2.4} className="size-3" />
                    ) : (
                      <span className="font-semibold tabular">{i + 1}</span>
                    )}
                    {asked.header && <span className="max-w-32 truncate">{asked.header}</span>}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
        )}
        <p data-selectable="" className="px-5 pt-2.5 text-heading font-semibold text-foreground">
          {question.question}
        </p>
        {question.multiSelect && (
          <p className="px-5 pt-0.5 text-control text-tertiary">{t('question.selectMany')}</p>
        )}
        <Choices
          question={question}
          selected={draft.choices}
          text={draft.text}
          disabled={busy}
          onChoose={(index) => setState((s) => choose(s, question, index))}
          onText={(text) => setState((s) => typeText(s, question, text))}
        />
        <CardError error={error} />
        <CardFooter>
          <FooterButton
            disabled={busy || (last && !isAnswered(draft))}
            onClick={() => setState(skipStep)}
          >
            {t('question.skip')}
          </FooterButton>
          <ConfirmButton busy={answering === 'submit'} disabled={busy} onClick={confirm}>
            {last
              ? given > 0
                ? t('question.submit')
                : t(count > 1 ? 'question.skipAll' : 'question.skip')
              : t('question.next')}
          </ConfirmButton>
        </CardFooter>
      </div>
    </WaitingCard>
  )
}

/** A question's choices as tiles, then the tile for an answer of the user's own. */
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
  const written = text.trim() !== ''
  const two = twoPerRow(question)
  const Mark = question.multiSelect ? CheckMark : RadioMark

  // A question that takes only words: one field, with no key, and a lock when it is a secret.
  if (options.length === 0) {
    return (
      <div className="flex flex-col px-5 pt-3.5">
        <label
          className={cn(
            'flex min-h-12 cursor-text items-center gap-2.5 rounded-card border border-input bg-card pr-3 pl-3.5 shadow-field transition-[border-color,box-shadow] duration-(--duration-fast)',
            'hover:border-strong focus-within:border-focused focus-within:shadow-field-focus',
          )}
        >
          {question.secret && <LockIcon aria-hidden className="size-4 shrink-0 text-tertiary" />}
          <input
            type={question.secret ? 'password' : 'text'}
            autoComplete="off"
            value={text}
            disabled={disabled}
            aria-label={question.question}
            data-answer-option={1}
            onChange={(event) => onText(event.target.value)}
            className="h-11 min-w-0 flex-1 bg-transparent text-label text-foreground outline-none placeholder:text-tertiary"
          />
        </label>
        {question.secret && <SecretHint className="px-0.5" />}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.question}
        className={cn('grid gap-2 px-5 pt-3.5', two ? 'grid-cols-2' : 'grid-cols-1')}
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
              className={cn(tileClass(chosen), 'min-h-14 py-2.5 pr-3 pl-3.5')}
            >
              <Mark on={chosen} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="min-w-0 text-row font-medium wrap-anywhere">
                  <OptionName name={option.label} />
                </span>
                {option.description && (
                  <span className="min-w-0 text-control text-tertiary wrap-anywhere">
                    {option.description}
                  </span>
                )}
              </span>
              <TileKey n={i + 1} on={chosen} />
            </button>
          )
        })}
        {question.allowsText && (
          <label
            className={cn(
              'flex min-h-12 min-w-0 cursor-text items-center gap-3 rounded-card py-1.5 pr-3 pl-3.5 transition-[background-color,box-shadow] duration-(--duration-fast)',
              two && 'col-span-2',
              written
                ? 'bg-control-on-tint shadow-tile-on'
                : 'border border-dashed border-border-strong focus-within:border-transparent focus-within:bg-control-on-tint focus-within:shadow-tile-on',
            )}
          >
            <Mark on={written} />
            <input
              type={question.secret ? 'password' : 'text'}
              autoComplete="off"
              value={text}
              disabled={disabled}
              placeholder={t('question.other')}
              aria-label={t('question.other')}
              data-answer-option={own < NUMBERED ? own + 1 : undefined}
              onChange={(event) => onText(event.target.value)}
              className="h-8 min-w-0 flex-1 bg-transparent text-row text-foreground outline-none placeholder:text-tertiary"
            />
            <TileKey n={own + 1} on={written} />
          </label>
        )}
      </div>
      {question.secret && <SecretHint className="px-5.5" />}
    </div>
  )
}

function SecretHint({ className }: { className?: string }) {
  const { t } = useTranslation('session')
  return (
    <p className={cn('flex items-center gap-1.5 pt-2 text-hint text-tertiary', className)}>
      <EyeOffIcon aria-hidden className="size-3.25 shrink-0" />
      {t('question.secretHint')}
    </p>
  )
}

/** What each question of an answered ask got: the question in gray, the answer under it. */
export function AnsweredQuestions({ questions }: { questions: AnsweredQuestion[] }) {
  const { t } = useTranslation('session')
  return (
    <ul className="flex flex-col">
      {questions.map((asked, i) => (
        <li
          key={i}
          className="flex min-w-0 flex-col gap-0.5 border-t border-border-soft py-2.5 first:border-t-0 first:pt-0"
        >
          <span data-selectable="" className="text-control text-tertiary">
            {asked.question}
          </span>
          {asked.answer !== undefined ? (
            <span data-selectable="" className="text-row wrap-anywhere text-foreground">
              {asked.answer}
            </span>
          ) : asked.answered ? (
            <span className="flex items-center gap-1.5 text-row text-tertiary">
              <LockIcon aria-hidden className="size-3.5 shrink-0" />
              {t('question.secret')}
            </span>
          ) : (
            <span className="text-row text-tertiary">{t('question.skipped')}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
