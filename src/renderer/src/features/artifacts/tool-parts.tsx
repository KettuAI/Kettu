// The parts the viewer's tools share: a card's head, the chip that says what an edit saved, and a
// notice in place of fields.

import { type ReactNode } from 'react'
import { Alert02Icon, CheckmarkCircle02Icon, Undo02Icon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { formatShortcut } from '@renderer/lib/platform'

/** A right card's head: its icon on a tile, its title, a line under it, and its own actions. */
export function CardHead({
  icon,
  title,
  sub,
  status,
  children,
}: {
  icon: IconSvgElement
  title: ReactNode
  sub?: ReactNode
  /** At the end of the line under the title: what an edit saved. */
  status?: ReactNode
  /** After the title, before the shell's close: a save chip, Undo. */
  children?: ReactNode
}) {
  return (
    <div className="k-vt-head">
      <span aria-hidden className="k-vt-head__tile">
        <Icon icon={icon} size={16} />
      </span>
      <span className="k-vt-head__text">
        <span className="k-vt-head__row">
          <h2 className="k-vt-head__title">{title}</h2>
          {children}
        </span>
        {(sub !== undefined || status) && (
          <span className="k-vt-head__subrow">
            <span className="k-vt-head__sub">{sub}</span>
            {status}
          </span>
        )}
      </span>
    </div>
  )
}

/** What an edit or a tweak has saved so far. */
export type SaveState =
  | { state: 'pending' }
  | { state: 'saved'; version: number; edits: number }
  | { state: 'undone'; version: number }
  /** `text` says why in place of "Couldn't save"; `retry` false where trying again cannot help. */
  | { state: 'failed'; error: string; text?: string; retry?: boolean }

/** The chip in a card's head: "Editing…", then "Saved as v20 · 3 edits", or why it failed. */
export function SaveChip({ save, onRetry }: { save: SaveState | null; onRetry: () => void }) {
  const { t } = useTranslation('artifacts')
  const reduce = useReducedMotionConfig()
  if (!save) return null
  if (save.state === 'failed') {
    return (
      <span className="k-vt-save" data-state="failed" role="alert" title={save.error}>
        <Icon icon={Alert02Icon} size={14} />
        {save.text ?? t('edit.notSaved')}
        {save.retry !== false && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t('viewer.retry')}
          </Button>
        )}
      </span>
    )
  }
  const text =
    save.state === 'pending'
      ? t('edit.editing')
      : save.state === 'undone'
        ? t('edit.undone', { version: save.version })
        : save.edits > 1
          ? t('edit.savedEdits', { version: save.version, count: save.edits })
          : t('edit.saved', { version: save.version })
  return (
    <span className="k-vt-save" data-state={save.state} role="status">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          className="k-vt-save__in"
          initial={reduce ? false : { opacity: 0, filter: 'blur(6px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)', transition: { duration: reduce ? 0 : 0.24 } }}
          exit={{ opacity: 0, filter: 'blur(6px)', transition: { duration: reduce ? 0 : 0.16 } }}
        >
          {save.state === 'pending' ? (
            <span aria-hidden className="k-vt-save__dot" />
          ) : (
            <Icon icon={save.state === 'undone' ? Undo02Icon : CheckmarkCircle02Icon} size={14} />
          )}
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/** Under a card's head while its save failed: the change stays on screen until it saves. */
export function KeptNote({ save }: { save: SaveState | null }) {
  const { t } = useTranslation('artifacts')
  if (save?.state !== 'failed') return null
  return <p className="k-vt-kept">{t('viewer.keptUntilSaved')}</p>
}

/** Undo in a card's head, which Mod+Z presses too. */
export function UndoButton({ onUndo }: { onUndo: (() => void) | null }) {
  const { t } = useTranslation('artifacts')
  const label = `${t('edit.undo')} ${formatShortcut('Mod+Z')}`
  return (
    <button
      type="button"
      aria-label={t('edit.undo')}
      title={label}
      disabled={!onUndo}
      onClick={() => onUndo?.()}
      className="k-vt-icon"
    >
      <Icon icon={Undo02Icon} size={15} />
    </button>
  )
}

/** In place of a card's fields: why they are not there, and what to do instead. */
export function Notice({
  head,
  children,
  actions,
}: {
  head?: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="k-vt-notice">
      {head && <span className="k-vt-notice__head">{head}</span>}
      <p>{children}</p>
      {actions && <span className="k-vt-notice__acts">{actions}</span>}
    </div>
  )
}
