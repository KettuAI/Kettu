import { useRef, useState, type Ref } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  FileEditIcon,
  RepeatIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import { ApprovalCard } from '@renderer/components/affect/approval-card'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { toast } from '@renderer/components/ui/toast'
import { cn } from '@renderer/lib/utils'
import { Clamp } from '../clamp'
import { Markdown } from '../markdown'
import { respondToPermission } from './helpers'
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

/** The plan's text, cut short when long, with a quiet button that copies it. */
function PlanBody({ markdown, clamp = true }: { markdown: string; clamp?: boolean }) {
  const { t } = useTranslation('session')
  const copy = () => {
    navigator.clipboard
      .writeText(markdown)
      .then(() => toast(t('planCard.copied')))
      .catch(() => toast(t('planCard.copyFailed')))
  }
  const body = <Markdown markdown={markdown} className="markdown-compact" />
  return (
    <div className="ks-plan__body">
      <button
        type="button"
        className="ks-plan__copy"
        aria-label={t('planCard.copy')}
        title={t('planCard.copy')}
        onClick={copy}
      >
        <Icon icon={Copy01Icon} size={14} />
      </button>
      <div data-selectable="" className="min-w-0">
        {clamp ? (
          <Clamp maxHeight={320} more={t('planCard.showWhole')}>
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
    <div className="ks-plan__changes">
      <p className="ks-plan__label">{t('planCard.changesSince')}</p>
      <ul data-selectable="">
        {lines.map((line, i) =>
          line.kind === 'same' ? (
            <li key={i} data-kind="same">
              {t('planCard.unchanged', { count: line.count })}
            </li>
          ) : (
            <li key={i} data-kind={line.kind}>
              <span aria-hidden>{line.kind === 'added' ? '+' : '−'}</span>
              <span className="sr-only">
                {line.kind === 'added' ? t('planCard.added') : t('planCard.removed')}
              </span>
              <span>{line.text}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}

/**
 * A plan waiting for the user, on affectUI's Approval Card: the plan, the mode Claude Code builds
 * in on a Segmented Control (Codex's choices to implement it), and a note for keeping on planning.
 * Approve starts building; Deny keeps planning, with the note when there is one.
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
  const keepOption =
    options.find((o) => o.note) ??
    options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always') ??
    null
  const choices = options.filter((o) => o !== keepOption)
  const modes = choices.filter((o) => Object.hasOwn(BUILD_MODES, o.id))
  const [chosen, setChosen] = useState<string>(
    () => (choices.find((o) => o.preferred) ?? choices[0])?.id ?? '',
  )
  const [note, setNote] = useState('')
  const [view, setView] = useState<'plan' | 'changes'>(plan.previous ? 'changes' : 'plan')
  const { answering, error, away, send } = useAnswering(sessionId)
  const root = useRef<HTMLDivElement>(null)
  const version = entry.planVersion ?? 1
  const option = choices.find((o) => o.id === chosen)

  const answer = async (id: string | undefined, text?: string): Promise<boolean> => {
    if (!id || away || answering !== null) return false
    const focused = !!root.current?.contains(document.activeElement)
    const sent = await send(id, () =>
      respondToPermission(sessionId, permission.requestId, id, text || undefined),
    )
    // Keeping on planning without a note goes on in the composer, where the user says what.
    if (sent && (focused || (id === keepOption?.id && !text))) {
      emitAppEvent({ kind: 'focus-composer' })
    }
    return sent
  }

  const approve = async () => {
    // A rejection keeps the card waiting, with the reason under it.
    if (!(await answer(option?.id))) throw new Error('not sent')
  }
  const keepPlanning = () => void answer(keepOption?.id, keepOption?.note ? note.trim() : '')

  return (
    <div ref={ref} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div ref={root} className="min-w-0">
        <ApprovalCard
          className="ks-plan"
          title={version > 1 ? t('planCard.version', { version }) : t('planCard.label')}
          description={t(
            modes.length > 0 ? 'planCard.finishedBuild' : 'planCard.finishedImplement',
            {
              agent: agentName,
            },
          )}
          icon={<Icon icon={FileEditIcon} size={15} />}
          label={t('question.asksYou')}
          approveLabel={modes.length > 0 ? t('planCard.startBuilding') : t('planCard.implement')}
          denyLabel={note.trim() ? t('planCard.sendNote') : t('planCard.keepPlanningButton')}
          allowAlways={false}
          shortcuts
          status="pending"
          onApprove={approve}
          onDeny={keepPlanning}
          preview={
            <div className="ks-plan__preview">
              {plan.previous && (
                <SegmentedControl
                  aria-label={t('planCard.show')}
                  variant="tray"
                  size="sm"
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'plan', label: t('planCard.plan') },
                    { value: 'changes', label: t('planCard.changes') },
                  ]}
                />
              )}
              {view === 'changes' && plan.previous ? (
                <PlanChanges previous={plan.previous} markdown={plan.markdown} />
              ) : (
                <PlanBody markdown={plan.markdown} />
              )}
              {(modes.length > 0 || choices.length > 1) && (
                <>
                  <span className="ks-plan__label">
                    {modes.length > 0 ? t('planCard.buildIn') : t('planCard.implementAsk')}
                  </span>
                  <SegmentedControl
                    aria-label={
                      modes.length > 0 ? t('planCard.buildIn') : t('planCard.implementAsk')
                    }
                    variant="tray"
                    size="lg"
                    fullWidth
                    value={chosen}
                    onChange={setChosen}
                    options={(modes.length > 0 ? modes : choices).map((o) => ({
                      value: o.id,
                      label: o.name,
                    }))}
                  />
                </>
              )}
              {keepOption?.note && (
                <input
                  type="text"
                  className="ks-plan__note"
                  autoComplete="off"
                  value={note}
                  placeholder={t('planCard.keepPlanning', { agent: agentName })}
                  aria-label={keepOption.name}
                  onChange={(event) => setNote(event.target.value)}
                  onKeyDown={(event) => {
                    // Esc leaves the field rather than sending a half-written note.
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      event.currentTarget.blur()
                      return
                    }
                    if (
                      event.key !== 'Enter' ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.nativeEvent.isComposing ||
                      event.keyCode === 229
                    ) {
                      return
                    }
                    event.preventDefault()
                    if (note.trim()) keepPlanning()
                  }}
                />
              )}
            </div>
          }
        />
      </div>
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
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
  const glyph = approved
    ? CheckmarkCircle02Icon
    : keptPlanning
      ? RepeatIcon
      : result
        ? Cancel01Icon
        : FileEditIcon
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
      <div className="ks-answered" data-kind={approved ? 'done' : 'other'}>
        <div className="ks-answered__head">
          <Icon icon={glyph} size={16} />
          <span className="ks-answered__title">{title}</span>
          {meta && <span className="ks-answered__device">· {meta}</span>}
          <button
            type="button"
            className="ks-answered__toggle"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t('planCard.hidePlan') : t('planCard.showPlan')}
            <Icon icon={ArrowDown01Icon} size={14} />
          </button>
        </div>
        {keptPlanning && result.note && (
          <p data-selectable="" className="ks-answered__quote">
            {result.note}
          </p>
        )}
        {open && (
          <div className="ks-answered__plan">
            <PlanBody markdown={markdown} clamp={false} />
          </div>
        )}
        {!open && !(keptPlanning && result.note) && <div className="ks-answered__end" />}
      </div>
      {mode && (
        <p className="ks-plan__moved">
          <Icon icon={ArrowRight02Icon} size={14} />
          <span>
            <Trans
              t={t}
              i18nKey="planCard.modeChanged"
              values={{ mode }}
              components={{ b: <b /> }}
            />
          </span>
        </p>
      )}
    </div>
  )
}
