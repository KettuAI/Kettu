import type { ReactNode } from 'react'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { RELEASES_URL, releaseUrl } from '@shared/updates'
import { Button } from '@renderer/components/ui/button'
import { PopoverTitle } from '@renderer/components/ui/popover'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { useUpdatesStore } from '@renderer/stores/updates'
import { Glyph } from '@renderer/features/shell/glyph'
import { appUpdateText, type AppUpdateNotice } from './app-updates'
import {
  harnessRowNote,
  versionsText,
  type BatchItem,
  type HarnessItem,
  type UpdateItem,
} from './card-model'
import {
  requestHarnessUpdates,
  retryHarnessUpdate,
  skipHarnessUpdates,
  unskipHarnessUpdate,
} from './harness-updates'
import { CARD_BUTTON } from './update-actions'
import { AppAction, UpdateMark } from './update-parts'

/**
 * Every update, one row each, each acting on its own; the batch's rows say where they are.
 * Updating the harnesses never restarts Kettu: its restart stays on its own row.
 */
export function UpdateReview({ items, batch }: { items: UpdateItem[]; batch: BatchItem[] }) {
  const { t } = useTranslation('updates')
  const current = useUpdatesStore((s) => s.status?.current)
  const app = items.find((item) => item.kind === 'app')
  const latest = app?.notice.version ?? current
  const harnesses = items.filter((item): item is HarnessItem => item.kind === 'harness')
  const pending = harnesses.filter((item) => !item.skipped && !item.waiting && !item.queued)
  const offerOf = (agentId: AgentId) => harnesses.find((item) => item.offer.agentId === agentId)
  const inBatch = (agentId: AgentId) => batch.some((item) => item.agentId === agentId)
  return (
    <div className="flex flex-col">
      <div className="flex items-center px-3 py-2.5 shadow-[inset_0_calc(var(--hairline)*-1)_0_var(--border-subtle)]">
        <PopoverTitle className="flex-1 text-control leading-4 font-semibold">
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
        {app?.kind === 'app' && (
          <Row
            agentId={null}
            name="Kettu"
            versions={appVersions(app.notice, current)}
            note={appUpdateText(app.notice).rowNote}
            action={<AppAction notice={app.notice} />}
          />
        )}
        {batch.map((item) => (
          <BatchRow key={item.agentId} item={item} offer={offerOf(item.agentId)} />
        ))}
        {harnesses
          .filter((item) => !inBatch(item.offer.agentId))
          .map((item) => (
            <HarnessRow key={item.offer.agentId} item={item} />
          ))}
      </ul>
      {harnesses.length + batch.length > 0 && (
        <div className="flex items-center gap-2 bg-subtle px-3 py-2.25 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          <span className="flex-1 text-caption text-tertiary">{t('review.note')}</span>
          <Button
            size="xs"
            disabled={pending.length === 0}
            onClick={() => void requestHarnessUpdates(pending.map((item) => item.offer.agentId))}
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
  agentId,
  name,
  versions,
  note,
  noteClass,
  action,
  faded,
}: {
  agentId: AgentId | null
  name: string
  versions: string
  note: string
  noteClass?: string
  action: ReactNode
  faded?: boolean
}) {
  return (
    <li className="group/row flex items-center gap-2.5 px-3 py-2.25 not-last:shadow-[inset_0_calc(var(--hairline)*-1)_0_var(--border-subtle)]">
      <span className={cn('flex shrink-0', faded && 'opacity-45 grayscale')}>
        <UpdateMark agentId={agentId} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-control leading-4',
            faded ? 'text-tertiary' : 'text-primary',
          )}
        >
          {name}{' '}
          <span className="font-mono text-caption text-tertiary [font-variant-ligatures:none]">
            {versions}
          </span>
        </div>
        <div
          title={note}
          className={cn('mt-px truncate text-caption leading-3.5 text-tertiary', noteClass)}
        >
          {note}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{action}</div>
    </li>
  )
}

/** Where an update of the batch is, in words. */
function RowState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('flex items-center gap-1.25 text-caption text-tertiary', className)}>
      {children}
    </span>
  )
}

function BatchRow({ item, offer }: { item: BatchItem; offer: HarnessItem | undefined }) {
  const { t } = useTranslation('updates')
  const versions = offer
    ? versionsText(offer.offer)
    : item.from
      ? `${item.from} → ${item.to}`
      : item.to
  let note = offer ? harnessRowNote(offer) : t('review.updatedNote')
  let noteClass: string | undefined
  let action: ReactNode
  switch (item.state) {
    case 'installing':
      action = (
        <RowState>
          <RingSpinner aria-hidden />
          {t('review.updating')}
        </RowState>
      )
      break
    case 'queued':
      action = <RowState>{t('review.queued')}</RowState>
      break
    case 'waiting':
      note = t('review.waits', { count: Math.max(item.running, 1) })
      noteClass = 'text-warning'
      action = <RowState>{t('review.queued')}</RowState>
      break
    case 'updated':
      note = t('review.updatedNote')
      action = (
        <RowState className="text-success">
          <Glyph icon={Tick02Icon} size={12} />
          {t('review.updated')}
        </RowState>
      )
      break
    case 'failed': {
      const { failure } = item
      note = failure?.error ?? ''
      noteClass = 'text-danger'
      action = (
        <>
          <RowState className="text-danger">{t('review.failed')}</RowState>
          {failure && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() => retryHarnessUpdate(failure.agentId, failure.retry)}
              className={CARD_BUTTON}
            >
              {t('harness.retry')}
            </Button>
          )}
        </>
      )
      break
    }
  }
  return (
    <Row
      agentId={item.agentId}
      name={item.name}
      versions={versions}
      note={note}
      noteClass={noteClass}
      action={action}
    />
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
    action = <RowState>{t('review.queued')}</RowState>
  } else {
    action = (
      <>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => skipHarnessUpdates([offer.agentId])}
          className={cn(
            CARD_BUTTON,
            'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          )}
        >
          {t('review.skip')}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          onClick={() => void requestHarnessUpdates([offer.agentId])}
          className={CARD_BUTTON}
        >
          {t('harness.update')}
        </Button>
      </>
    )
  }
  return (
    <Row
      agentId={offer.agentId}
      name={offer.name}
      versions={versionsText(offer)}
      note={harnessRowNote(item)}
      action={action}
      faded={item.skipped}
    />
  )
}

/** "0.0.9 → 0.1.0": from the running version, or the one an update came from. */
function appVersions(notice: AppUpdateNotice, current: string | undefined): string {
  const from = notice.kind === 'updated' ? notice.from : current
  return from ? `${from} → ${notice.version}` : notice.version
}
