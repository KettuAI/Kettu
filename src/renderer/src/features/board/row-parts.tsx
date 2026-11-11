import { useId, useState, type ReactNode } from 'react'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'

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

/** A section of the board: its icon, name and count, and how many of it run, over its content. */
export function Section({
  icon,
  title,
  count,
  running,
  children,
}: {
  icon: IconSvgElement
  title: string
  count?: number
  running?: string | null
  children: ReactNode
}) {
  return (
    <section className="kb-section" aria-label={title}>
      <h3 className="kb-section__head">
        <PaneIcon icon={icon} size={14} />
        <span>{title}</span>
        {count !== undefined && <span className="kb-section__n">{count}</span>}
        {running && <span className="kb-section__run">{running}</span>}
      </h3>
      <div className="kb-section__body">{children}</div>
    </section>
  )
}

/** The ended items of a section behind one line that counts them and their failures. */
export function Finished({
  count,
  failed,
  open: initial = false,
  children,
}: {
  count: number
  failed: number
  /** Starts unfolded, as when nothing runs above it. */
  open?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('board')
  const id = useId()
  const [open, setOpen] = useState(initial)
  return (
    <div className="kb-finished">
      <button
        type="button"
        className="kb-finished__head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <PaneIcon icon={ArrowRight01Icon} size={12} className="kb-chev" />
        <span>{t('finished.label', { count })}</span>
        {failed > 0 && (
          <span className="kb-finished__failed">{t('finished.failed', { count: failed })}</span>
        )}
      </button>
      <div id={id} className="kb-fold" data-open={open}>
        <div>{children}</div>
      </div>
    </div>
  )
}
