import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { changeCount, changesLabel } from './change-words'
import type { ChangeWalk } from './use-change-walk'
import { useShell } from './viewer-shell-context'

/**
 * The pill at the top of the content that says what changed, for every kind alike: "4 frames
 * changed in v19", or "9 frames changed since v17" when versions came since the user last saw it,
 * "5 changed" where it is narrow. Its arrows walk the changes; a web page's files are only counted.
 */
export function ChangePill({
  walk,
  label,
  onStep,
}: {
  walk: ChangeWalk
  /** Said in place of what changed, such as which version a document shows its changes from. */
  label?: string
  onStep: (direction: 1 | -1) => void
}) {
  const { t } = useTranslation('artifacts')
  const { tier } = useShell()
  const { range, changes, places, at } = walk
  const changed = changesLabel(changes)
  const text =
    label ??
    (tier === 'narrow'
      ? t('sheet.changedShort', { count: changeCount(changes).count })
      : range.since
        ? t('sheet.changedSince', { changes: changed, version: range.from })
        : t('sheet.changedIn', { changes: changed, version: range.to }))
  return (
    <div
      role="status"
      aria-label={
        range.since
          ? t('sheet.changedSince', { changes: changed, version: range.from })
          : t('sheet.changedIn', { changes: changed, version: range.to })
      }
      className="avs-pill__in aps-pill"
    >
      <span className="avs-pill__dot aps-pill__dot" aria-hidden />
      <span className="avs-pill__text">
        <b>{text}</b>
      </span>
      {walk.steps && (
        <>
          <span aria-hidden className="avs-dock__rule" />
          <button
            type="button"
            aria-label={t('sheet.previousChange')}
            title={t('sheet.previousChange')}
            onClick={() => onStep(-1)}
            className="avs-dock__btn"
          >
            <Icon icon={ArrowLeft01Icon} size={14} />
          </button>
          <span className="aps-pill__count">
            {t('sheet.changeAt', { number: at + 1, count: places.length })}
          </span>
          <button
            type="button"
            aria-label={t('sheet.nextChange')}
            title={t('sheet.nextChange')}
            onClick={() => onStep(1)}
            className="avs-dock__btn"
          >
            <Icon icon={ArrowRight01Icon} size={14} />
          </button>
        </>
      )}
      <button
        type="button"
        aria-label={t('viewer.dismiss')}
        title={t('viewer.dismiss')}
        onClick={walk.dismiss}
        className="avs-dock__btn"
      >
        <Icon icon={Cancel01Icon} size={14} />
      </button>
    </div>
  )
}
