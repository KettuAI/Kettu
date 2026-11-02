import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RELEASES_URL, releaseUrl } from '@shared/updates'
import { Button } from '@renderer/components/ui/button'
import { PopoverTitle } from '@renderer/components/ui/popover'
import { useUpdatesStore } from '@renderer/stores/updates'
import { appUpdateText } from './app-updates'
import { harnessRowNote, versionsText, type HarnessItem, type UpdateItem } from './card-model'
import { unskipHarnessUpdate, updateHarnesses } from './harness-updates'
import { CARD_BUTTON } from './update-actions'
import { AppAction, ItemTile } from './update-parts'

/**
 * Every update, one row each, each acting on its own. Updating the harnesses never restarts
 * Kettu: its restart stays on its own row.
 */
export function UpdateReview({ items }: { items: UpdateItem[] }) {
  const { t } = useTranslation('updates')
  const current = useUpdatesStore((s) => s.status?.current)
  const app = items.find((item) => item.kind === 'app')
  const latest = app?.notice.version ?? current
  const harnesses = items.filter((item): item is HarnessItem => item.kind === 'harness')
  const pending = harnesses.filter((item) => !item.skipped && !item.waiting && !item.queued)
  return (
    <div className="flex flex-col">
      <div className="flex items-center px-3 py-2.5 shadow-[inset_0_calc(var(--hairline)*-1)_0_var(--border-subtle)]">
        <PopoverTitle className="flex-1 text-control font-semibold">
          {t('review.title')}
        </PopoverTitle>
        <a
          href={latest ? releaseUrl(latest) : RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="rounded-xs text-small text-tertiary outline-none hover:text-secondary focus-visible:focus-ring"
        >
          {t('whatsNew')}
        </a>
      </div>
      <ul className="flex flex-col">
        {items.map((item) =>
          item.kind === 'app' ? (
            <Row
              key="kettu"
              item={item}
              versions={current ? `${current} → ${item.notice.version}` : item.notice.version}
              note={appUpdateText(item.notice).rowNote}
              action={<AppAction notice={item.notice} />}
            />
          ) : (
            <HarnessRow key={item.offer.agentId} item={item} />
          ),
        )}
      </ul>
      {harnesses.length > 0 && (
        <div className="flex items-center gap-2 bg-subtle px-3 py-2.25 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          <span className="flex-1 text-caption text-tertiary">{t('review.note')}</span>
          <Button
            size="xs"
            variant="secondary"
            disabled={pending.length === 0}
            onClick={() => updateHarnesses(pending.map((item) => item.offer.agentId))}
            className={CARD_BUTTON}
          >
            {t('review.updateAll')}
          </Button>
        </div>
      )}
    </div>
  )
}

function Row({
  item,
  versions,
  note,
  action,
}: {
  item: UpdateItem
  versions: string
  note: string
  action: ReactNode
}) {
  const name = item.kind === 'app' ? 'Kettu' : item.offer.name
  return (
    <li className="flex items-center gap-2.5 px-3 py-2.25 not-last:shadow-[inset_0_calc(var(--hairline)*-1)_0_var(--border-subtle)]">
      <ItemTile item={item} size={20} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-control text-primary">
          {name}{' '}
          <span className="font-mono text-caption text-tertiary [font-variant-ligatures:none]">
            {versions}
          </span>
        </div>
        <div className="mt-px truncate text-caption text-tertiary">{note}</div>
      </div>
      {action}
    </li>
  )
}

function HarnessRow({ item }: { item: HarnessItem }) {
  const { t } = useTranslation('updates')
  const { offer } = item
  let action: ReactNode
  if (item.skipped) {
    action = (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => unskipHarnessUpdate(offer.agentId)}
        className={CARD_BUTTON}
      >
        {t('review.undo')}
      </Button>
    )
  } else if (item.queued || item.waiting) {
    action = <span className="text-caption text-tertiary">{t('review.queued')}</span>
  } else {
    action = (
      <Button
        size="xs"
        variant="secondary"
        onClick={() => updateHarnesses([offer.agentId])}
        className={CARD_BUTTON}
      >
        {t('harness.update')}
      </Button>
    )
  }
  return (
    <Row item={item} versions={versionsText(offer)} note={harnessRowNote(item)} action={action} />
  )
}
