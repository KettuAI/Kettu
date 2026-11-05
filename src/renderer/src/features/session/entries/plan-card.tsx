import { useRef, useState, type KeyboardEvent, type Ref } from 'react'
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { PermissionOption, ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { toast } from '@renderer/components/ui/toast'
import { cn } from '@renderer/lib/utils'
import { Clamp } from '../clamp'
import { MODE_ICON } from '../composer/control-row'
import { modeLook } from '../composer/modes'
import { Markdown } from '../markdown'
import {
  AgentWho,
  CardError,
  CardFooter,
  ConfirmButton,
  NUMBERED,
  RadioMark,
  TileKey,
  WaitingCard,
  WaitingHeader,
  WaitingStatus,
} from './answer-list'
import { isConfirmKey, tileClass } from './card-style'
import { PANEL, respondToPermission } from './helpers'
import { planDiff } from './plan-diff'
import { useAnswering } from './use-answering'

/** The Claude Code options that build in a mode, by the mode each sets. */
const BUILD_MODES: Record<string, string> = {
  'exit-plan-auto': 'auto',
  'exit-plan-accept-edits': 'acceptEdits',
  'exit-plan-default': 'default',
}

/** The plan the entry holds: the request's, or once answered, the entry's own text. */
function planMarkdown(entry: ToolEntry): string {
  if (entry.permission?.plan) return entry.permission.plan.markdown
  const text = entry.content.find((c) => c.type === 'markdown')
  return text?.type === 'markdown' ? text.markdown : ''
}

/** The plan as a document: its Markdown on paper, cut short when long, with a copy button. */
function PlanDoc({ markdown, clamp = true }: { markdown: string; clamp?: boolean }) {
  const { t } = useTranslation('session')
  const copy = () => {
    navigator.clipboard
      .writeText(markdown)
      .then(() => toast(t('planCard.copied')))
      .catch(() => toast(t('planCard.copyFailed')))
  }
  const body = <Markdown markdown={markdown} className="markdown-compact" />
  return (
    <div className="relative min-w-0 rounded-card bg-code-block px-4.5 pt-3.5 pb-4 shadow-sunk">
      <button
        type="button"
        aria-label={t('planCard.copy')}
        title={t('planCard.copy')}
        onClick={copy}
        className="absolute top-2 right-2 z-1 flex size-7 items-center justify-center rounded-lg text-tertiary outline-none hover:bg-hover hover:text-secondary focus-ring"
      >
        <CopyIcon aria-hidden className="size-3.75" />
      </button>
      <div data-selectable="" className="min-w-0 pr-8">
        {clamp ? (
          <Clamp maxHeight={260} more={t('planCard.showWhole')}>
            {body}
          </Clamp>
        ) : (
          body
        )}
      </div>
    </div>
  )
}

/** What changed since the plan the user sent back: removed and added lines, the rest folded. */
function PlanChanges({ previous, markdown }: { previous: string; markdown: string }) {
  const { t } = useTranslation('session')
  const lines = planDiff(previous, markdown)
  return (
    <div className="min-w-0 rounded-card bg-code-block px-4.5 pt-3.5 pb-4 shadow-sunk">
      <p className="text-control text-secondary">{t('planCard.changesSince')}</p>
      <ul data-selectable="" className="mt-2.5 flex flex-col gap-1">
        {lines.map((line, i) =>
          line.kind === 'same' ? (
            <li key={i} className="px-2.5 text-control text-tertiary">
              {t('planCard.unchanged', { count: line.count })}
            </li>
          ) : (
            <li
              key={i}
              className={cn(
                'flex gap-2.5 rounded-lg px-2.5 py-1.5 text-row wrap-anywhere',
                line.kind === 'added' ? 'bg-success-tint' : 'bg-danger-tint text-secondary',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'w-3 shrink-0 text-center font-mono font-semibold',
                  line.kind === 'added' ? 'text-success' : 'text-danger',
                )}
              >
                {line.kind === 'added' ? '+' : '−'}
              </span>
              <span className="sr-only">
                {line.kind === 'added' ? t('planCard.added') : t('planCard.removed')}
              </span>
              <span className={cn('min-w-0', line.kind === 'removed' && 'line-through')}>
                {line.text}
              </span>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}

/**
 * A plan waiting for the user: the plan as a document, then what to do with it. Claude Code's
 * options are the modes to build in, as tiles; Codex's are to implement it. Last comes a tile
 * to keep planning with a note. Nothing goes until the user confirms.
 */
export function PlanCard({
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
  const plan = permission.plan!
  const options = permission.options
  const noteOption = options.find((o) => o.note)
  const choices = options.filter((o) => !o.note)
  const modes = choices.filter((o) => Object.hasOwn(BUILD_MODES, o.id))
  const [chosen, setChosen] = useState<string>(
    () => (choices.find((o) => o.preferred) ?? choices[0] ?? noteOption)?.id ?? '',
  )
  const [note, setNote] = useState('')
  const [view, setView] = useState<'plan' | 'changes'>(plan.previous ? 'changes' : 'plan')
  const { answering, error, away, send } = useAnswering(sessionId)
  const body = useRef<HTMLDivElement>(null)
  const busy = away || answering !== null
  const option = options.find((o) => o.id === chosen)
  const keeping = !!option?.note
  const version = entry.planVersion ?? 1

  const confirm = async () => {
    if (busy || !option) return
    const focused = !!body.current?.contains(document.activeElement)
    const text = keeping ? note.trim() : ''
    const sent = await send(option.id, () =>
      respondToPermission(sessionId, permission.requestId, option.id, text || undefined),
    )
    // Keeping on planning without a note goes on in the composer, where the user says what.
    if (sent && (focused || (keeping && !text))) emitAppEvent({ kind: 'focus-composer' })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inField = event.target instanceof HTMLInputElement
    const plainEnter =
      inField &&
      event.key === 'Enter' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229
    if (!isConfirmKey(event) && !plainEnter) return
    event.preventDefault()
    event.stopPropagation()
    void confirm()
  }

  const numbered = [...choices, ...(noteOption ? [noteOption] : [])]
  const keyOf = (o: PermissionOption) => numbered.indexOf(o) + 1

  return (
    <WaitingCard
      ref={ref}
      entryId={entry.id}
      label={t('planCard.label')}
      description={t('planCard.ask', { agent: agentName })}
      className={className}
      onKeyDownCapture={onKeyDown}
    >
      <WaitingHeader>
        <AgentWho
          sessionId={sessionId}
          name={agentName}
          sub={version > 1 ? t('planCard.version', { version }) : t('planCard.label')}
        />
        <WaitingStatus>{t('question.asksYou')}</WaitingStatus>
      </WaitingHeader>
      <div ref={body} className="flex min-w-0 flex-col">
        {plan.previous && (
          <div className="px-5 pt-3">
            <SegmentedControl
              size="small"
              value={view}
              onChange={setView}
              aria-label={t('planCard.show')}
              segments={[
                { value: 'plan', label: t('planCard.plan') },
                { value: 'changes', label: t('planCard.changes') },
              ]}
            />
          </div>
        )}
        <div className="px-5 pt-3">
          {view === 'changes' && plan.previous ? (
            <PlanChanges previous={plan.previous} markdown={plan.markdown} />
          ) : (
            <PlanDoc markdown={plan.markdown} />
          )}
        </div>
        {modes.length > 0 && (
          <>
            <p className="px-5 pt-4.5 text-row font-semibold text-foreground">
              {t('planCard.buildIn')}
            </p>
            <div
              role="radiogroup"
              aria-label={t('planCard.buildIn')}
              className={cn(
                'grid gap-2 px-5 pt-3',
                modes.length >= 3 ? 'grid-cols-3' : 'grid-cols-2',
              )}
            >
              {modes.map((mode) => {
                const on = chosen === mode.id
                const Icon = MODE_ICON[modeLook(BUILD_MODES[mode.id])]
                const n = keyOf(mode)
                return (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy}
                    data-answer-option={n <= NUMBERED ? n : undefined}
                    aria-keyshortcuts={n <= NUMBERED ? String(n) : undefined}
                    onClick={() => setChosen(mode.id)}
                    className={cn(
                      tileClass(on),
                      'flex-col items-stretch gap-2.5 pt-3 pr-3 pb-3.5 pl-3.5',
                    )}
                  >
                    <span
                      className={cn(
                        'flex items-center justify-between',
                        on ? 'text-control-on' : 'text-secondary',
                      )}
                    >
                      <Icon aria-hidden className="size-4" />
                      <TileKey n={n} on={on} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-row font-medium">{mode.name}</span>
                      {mode.description && (
                        <span className="text-control text-tertiary">{mode.description}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
        {modes.length === 0 && choices.length > 0 && (
          <p className="px-5 pt-4.5 text-row font-semibold text-foreground">
            {t('planCard.implementAsk')}
          </p>
        )}
        <div
          role={modes.length === 0 ? 'radiogroup' : undefined}
          aria-label={modes.length === 0 ? t('planCard.implementAsk') : undefined}
          className={cn('flex flex-col gap-2 px-5', modes.length > 0 ? 'pt-2' : 'pt-3')}
        >
          {modes.length === 0 &&
            choices.map((choice) => {
              const on = chosen === choice.id
              const n = keyOf(choice)
              return (
                <button
                  key={choice.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={busy}
                  data-answer-option={n <= NUMBERED ? n : undefined}
                  aria-keyshortcuts={n <= NUMBERED ? String(n) : undefined}
                  onClick={() => setChosen(choice.id)}
                  className={cn(tileClass(on), 'min-h-14 py-2.5 pr-3 pl-3.5')}
                >
                  <RadioMark on={on} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-row font-medium">{choice.name}</span>
                    {choice.description && (
                      <span className="text-control text-tertiary">{choice.description}</span>
                    )}
                  </span>
                  <TileKey n={n} on={on} />
                </button>
              )
            })}
          {noteOption && (
            <label
              className={cn(
                'flex min-h-12 min-w-0 cursor-text items-center gap-3 rounded-card py-1.5 pr-3 pl-3.5 transition-[background-color,box-shadow] duration-(--duration-fast)',
                keeping
                  ? 'bg-control-on-tint shadow-tile-on'
                  : 'border border-dashed border-border-strong',
              )}
            >
              {modes.length > 0 ? (
                <RotateCcwIcon
                  aria-hidden
                  className={cn('size-4 shrink-0', keeping ? 'text-control-on' : 'text-tertiary')}
                />
              ) : (
                <RadioMark on={keeping} />
              )}
              <input
                type="text"
                autoComplete="off"
                value={note}
                disabled={busy}
                placeholder={t('planCard.keepPlanning', { agent: agentName })}
                aria-label={noteOption.name}
                data-answer-option={keyOf(noteOption) <= NUMBERED ? keyOf(noteOption) : undefined}
                onFocus={() => setChosen(noteOption.id)}
                onChange={(event) => {
                  setNote(event.target.value)
                  setChosen(noteOption.id)
                }}
                className="h-8 min-w-0 flex-1 bg-transparent text-row text-foreground outline-none placeholder:text-tertiary"
              />
              <TileKey n={keyOf(noteOption)} on={keeping} />
            </label>
          )}
        </div>
        <CardError error={error} />
        <CardFooter
          note={
            !option
              ? null
              : keeping
                ? t('planCard.staysPlanning', { agent: agentName })
                : Object.hasOwn(BUILD_MODES, option.id)
                  ? t('planCard.leavesTo', { mode: option.name })
                  : (option.description ?? null)
          }
        >
          <ConfirmButton
            busy={answering !== null}
            disabled={busy || !option}
            onClick={() => void confirm()}
          >
            {keeping
              ? note.trim()
                ? t('planCard.sendNote')
                : t('planCard.keepPlanningButton')
              : modes.length > 0
                ? t('planCard.startBuilding')
                : t('planCard.implement')}
          </ConfirmButton>
        </CardFooter>
      </div>
    </WaitingCard>
  )
}

/**
 * A plan once answered, or one still on its way: a row that says what became of it, with the
 * plan under Show plan; an approval notes the mode it moved to, a plan sent back quotes the note.
 */
export function PlanSettled({ entry }: { entry: ToolEntry }) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const result = entry.permissionResult
  const markdown = planMarkdown(entry)
  const version = entry.planVersion ?? 1
  const approved =
    typeof result === 'object' &&
    result !== null &&
    (result.kind === 'allow_once' || result.kind === 'allow_always')
  const keptPlanning = typeof result === 'object' && result !== null && !approved
  const mode =
    approved && Object.hasOwn(BUILD_MODES, result.optionId) ? (result.name ?? null) : null
  const Icon = approved ? CheckIcon : keptPlanning ? RotateCcwIcon : result ? XIcon : null
  const title = approved
    ? t('planCard.approved')
    : keptPlanning
      ? t('planCard.keptPlanning')
      : result === 'cancelled' || result === 'withdrawn'
        ? t('planCard.dropped')
        : version > 1
          ? t('planCard.version', { version })
          : t('planCard.label')
  const meta = approved
    ? mode
    : keptPlanning
      ? version > 1
        ? t('planCard.version', { version })
        : t('planCard.label')
      : null
  return (
    <div data-entry-id={entry.id} className="flex min-w-0 flex-col gap-2">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        render={<div className="min-w-0 rounded-card bg-card shadow-card" />}
      >
        <div className="flex min-h-12 min-w-0 items-center gap-2.5 py-2 pr-2.5 pl-4">
          {Icon && <Icon aria-hidden strokeWidth={2} className="size-4 shrink-0 text-secondary" />}
          <span className="shrink-0 text-ui font-medium text-foreground">{title}</span>
          {meta && <span className="min-w-0 truncate text-control text-tertiary">· {meta}</span>}
          <CollapsibleTrigger className="ml-auto flex h-7 shrink-0 cursor-default items-center gap-1 rounded-lg px-2.5 text-control text-secondary outline-none hover:bg-hover focus-ring">
            {open ? t('planCard.hidePlan') : t('planCard.showPlan')}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                'size-3.5 transition-[rotate] duration-(--duration-fast) motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </CollapsibleTrigger>
        </div>
        {keptPlanning && result.note && (
          <p
            data-selectable=""
            className="mx-4 mb-3.5 ml-11 border-l-2 border-border-strong pl-2.5 text-control text-secondary"
          >
            {result.note}
          </p>
        )}
        <CollapsibleContent className={PANEL} keepMounted={false}>
          <div className="px-3 pb-3">
            <PlanDoc markdown={markdown} clamp={false} />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {mode && (
        <p className="flex h-5.5 items-center gap-2 text-control text-tertiary">
          <ArrowRightIcon aria-hidden className="size-3.5 shrink-0" />
          <span>
            <Trans
              t={t}
              i18nKey="planCard.modeChanged"
              values={{ mode }}
              components={{ b: <b className="font-medium text-secondary" /> }}
            />
          </span>
        </p>
      )}
    </div>
  )
}
