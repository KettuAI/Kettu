import { useState } from 'react'
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
import { Icon } from '@renderer/components/affect/app-shell'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { toast } from '@renderer/components/ui/toast'
import { Clamp } from '../clamp'
import { BUILD_MODES } from '../decisions/plan'
import { Markdown } from '../markdown'
import { planDiff } from './plan-diff'

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
 * A plan waiting for the user's approval, which the Decision Card above the composer asks: the
 * plan as a document, and once revised, what changed since the one sent back.
 */
export function PlanWaiting({ entry }: { entry: ToolEntry }) {
  const { t } = useTranslation('session')
  const plan = entry.permission!.plan!
  const [view, setView] = useState<'plan' | 'changes'>(plan.previous ? 'changes' : 'plan')
  const version = entry.planVersion ?? 1
  return (
    <div data-entry-id={entry.id} className="ks-answered" data-kind="other">
      <div className="ks-answered__head">
        <Icon icon={FileEditIcon} size={16} />
        <span className="ks-answered__title">
          {version > 1 ? t('planCard.version', { version }) : t('planCard.label')}
        </span>
        <span className="ks-answered__device">· {t('decision.planWaiting')}</span>
      </div>
      <div className="ks-answered__plan ks-plan__preview">
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
      </div>
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
