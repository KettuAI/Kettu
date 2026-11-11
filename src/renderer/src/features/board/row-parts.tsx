import { useId, type ReactNode } from 'react'
import { ArrowDown01Icon, Cancel01Icon, StopIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { longAgo, shortDuration } from '@renderer/lib/format'
import { useNow, useSeconds } from '@renderer/lib/use-now'

export type RowState = 'running' | 'needs' | 'done' | 'failed' | 'stopped'

/** A row's state as a mark: a turning ring, an amber dot, a check, a cross or a stop. */
export function StatusGlyph({ state }: { state: RowState }) {
  const { t } = useTranslation('board')
  return (
    <span role="img" aria-label={t(`status.${state}`)} className="kb-glyph" data-state={state}>
      {state === 'done' && <PaneIcon icon={Tick02Icon} size={14} />}
      {state === 'failed' && <PaneIcon icon={Cancel01Icon} size={14} />}
      {state === 'stopped' && <PaneIcon icon={StopIcon} size={13} />}
    </span>
  )
}

/** How long something has run, counting on the one clock every ticking time shares. */
export function Elapsed({ since }: { since: number }) {
  const now = useSeconds()
  return <span>{shortDuration(Math.max(0, now - since))}</span>
}

export function Ago({ at }: { at: number }) {
  const now = useNow()
  return <span>{longAgo(at, now)}</span>
}

/**
 * One line of the board. A button covers the row, so the whole row is the click target while the
 * buttons beside its time stay buttons of their own; the row's words are not interactive.
 */
export function Row({
  label,
  onClick,
  expanded,
  controls,
  glyph,
  head,
  detail,
  mono,
  when,
  actions,
  hint,
  tile,
}: {
  /** The name of the button that covers the row. */
  label: string
  onClick: () => void
  /** Set when the row folds a detail open. */
  expanded?: boolean
  controls?: string
  glyph?: ReactNode
  head: ReactNode
  detail?: ReactNode
  mono?: boolean
  /** The row's time, which a hover or a keyboard focus swaps for its actions. */
  when?: ReactNode
  /** Buttons of their own, such as Stop. */
  actions?: ReactNode
  /** What a click does, drawn in the actions' place; the covering button does it. */
  hint: ReactNode
  /** A tile in place of the status mark. */
  tile?: ReactNode
}) {
  return (
    <div className="kb-row" data-open={expanded || undefined} data-tile={tile ? '' : undefined}>
      <button
        type="button"
        className="kb-row__hit"
        aria-label={label}
        title={label}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onClick}
      />
      <span className="kb-row__lead">{tile ?? glyph}</span>
      <span className="kb-row__text">
        <span className="kb-row__head">{head}</span>
        {detail ? (
          <span className="kb-row__detail" data-mono={mono || undefined}>
            {detail}
          </span>
        ) : null}
      </span>
      <span className="kb-row__side">
        <span className="kb-row__acts">
          {actions}
          <span aria-hidden className="kb-row__hint">
            {hint}
          </span>
        </span>
        {when != null && <span className="kb-row__when">{when}</span>}
      </span>
    </div>
  )
}

/** A group of rows under a heading that folds them away. */
export function Group({
  title,
  count,
  folded,
  onToggle,
  children,
}: {
  title: string
  count?: number
  folded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className="kb-group">
      <h3 className="kb-group__title">
        <button
          type="button"
          className="kb-group__head"
          aria-expanded={!folded}
          aria-controls={id}
          onClick={onToggle}
        >
          <PaneIcon icon={ArrowDown01Icon} size={12} className="kb-chev" />
          <span>{title}</span>
          {count !== undefined && <span className="kb-group__n">{count}</span>}
        </button>
      </h3>
      <div id={id} className="kb-fold" data-open={!folded}>
        <div>{children}</div>
      </div>
    </section>
  )
}
