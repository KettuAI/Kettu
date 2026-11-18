import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { Progress as ProgressPrimitive } from '@base-ui/react/progress'
import { ArrowRight01Icon, Cancel01Icon, Clock01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import type { AgentId } from '@shared/thread'
import { useTranslation } from 'react-i18next'
import { CommandLine } from '@renderer/components/command-line'
import { Button } from '@renderer/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { i18n } from '@renderer/lib/i18n'
import { cn } from '@renderer/lib/utils'
import { setSettingsDot, useUpdatesStore } from '@renderer/stores/updates'
import { openHarnessSettings } from '@renderer/stores/view'
import type { HarnessFailure } from './agent-updates'
import { appUpdateText, type AppUpdateNotice } from './app-updates'
import {
  harnessOfferText,
  severalNote,
  updateCardLabel,
  versionsText,
  type BatchItem,
  type BatchState,
  type HarnessItem,
  type UpdateCard,
  type UpdateItem,
} from './card-model'
import {
  closeHarnessFailure,
  endHarnessBatch,
  forgetHarnessUpdate,
  retryHarnessUpdate,
  skipHarnessUpdates,
  stopHarnessBatch,
  stopHarnessUpdate,
  updateHarnesses,
} from './harness-updates'
import { AppAction, CardButton, UpdateMark, UpdateNowDialog } from './update-parts'
import { runAppAction } from './update-actions'
import { UpdateReview } from './update-review'
import { Glyph } from '@renderer/features/shell/glyph'

// From the card's edge past the footer's padding and the sidebar's border, to sit beside it.
const BESIDE_SIDEBAR = 18

// Marks stacked before the rest fold into "+N".
const STACK = 3
// A single update's mark, and the marks of a stack or a batch.
const ONE_MARK = 20
const MARK = 22
// How long a batch that installed says so.
const SETTLED_MS = 3000

/** One mark of the stack and what it names on hover: "Claude Code 2.4.1 → 2.5.0". */
interface StackEntry {
  key: string
  agentId: AgentId | null
  name: string
  versions: string
  updated?: boolean
}

function itemEntry(item: UpdateItem, current: string | undefined): StackEntry {
  if (item.kind === 'harness') {
    const { offer } = item
    return {
      key: offer.agentId,
      agentId: offer.agentId,
      name: offer.name,
      versions: versionsText(offer),
    }
  }
  const { notice } = item
  const from = notice.kind === 'updated' ? notice.from : current
  return {
    key: 'kettu',
    agentId: null,
    name: 'Kettu',
    versions: from ? `${from} → ${notice.version}` : notice.version,
  }
}

function batchVersions(item: BatchItem): string {
  return item.from ? `${item.from} → ${item.to}` : item.to
}

function batchEntry(item: BatchItem): StackEntry {
  return {
    key: item.agentId,
    agentId: item.agentId,
    name: item.name,
    versions: batchVersions(item),
    updated: item.state === 'updated',
  }
}

const BADGES = {
  updated: { icon: Tick02Icon, fill: 'bg-success' },
  failed: { icon: Cancel01Icon, fill: 'bg-danger' },
  waiting: { icon: Clock01Icon, fill: 'bg-warning' },
} as const

/** How an update stands, at the corner of its mark. */
function MarkBadge({ state, className }: { state: keyof typeof BADGES; className: string }) {
  const { icon, fill } = BADGES[state]
  return (
    <span
      aria-hidden
      className={cn(
        'absolute grid size-2.75 place-items-center rounded-full text-(--on-fill) shadow-[0_0_0_1.5px_var(--shell-card)]',
        fill,
        className,
      )}
    >
      <Glyph icon={icon} size={8} />
    </span>
  )
}

/** The mark of the update a card is about: a turning ring while it installs, else its badge. */
function SubjectMark({ agentId, state }: { agentId: AgentId | null; state: BatchState }) {
  return (
    <span className="relative flex shrink-0">
      <UpdateMark agentId={agentId} size={MARK} />
      {state === 'installing' && (
        <RingSpinner aria-hidden className="absolute -inset-1 size-auto" />
      )}
      {(state === 'updated' || state === 'failed' || state === 'waiting') && (
        <MarkBadge state={state} className="-right-0.75 -bottom-0.75" />
      )}
    </span>
  )
}

/**
 * The marks stacked, the first on top, each on a disc of the card's color so an overlap cuts a
 * round edge. Hovering the card fans them out, those behind "+N" too.
 */
function UpdateStack({ entries, onOpen }: { entries: StackEntry[]; onOpen?: () => void }) {
  const hidden = entries.length > STACK ? entries.length - (STACK - 1) : 0
  return (
    <span
      className="relative flex shrink-0 items-center"
      style={{ '--disc': `${MARK + 4}px` } as CSSProperties}
    >
      {entries.map((entry, index) => {
        const folded = hidden > 0 && index >= STACK - 1
        return (
          <Tooltip key={entry.key}>
            <TooltipTrigger
              delay={150}
              onClick={onOpen}
              style={{ zIndex: entries.length - index }}
              render={
                <span
                  className={cn(
                    'relative grid h-(--disc) shrink-0 place-items-center rounded-full bg-(--shell-card) motion-safe:transition-[margin-left,width,opacity,translate] motion-safe:duration-(--duration-slow) motion-safe:ease-standard',
                    folded
                      ? 'w-0 overflow-hidden opacity-0 group-hover/card:ml-0.75 group-focus-within/card:ml-0.75 group-hover/card:w-(--disc) group-focus-within/card:w-(--disc) group-hover/card:overflow-visible group-focus-within/card:overflow-visible group-hover/card:opacity-100 group-focus-within/card:opacity-100'
                      : cn(
                          'w-(--disc)',
                          index > 0 &&
                            '-ml-2.25 group-hover/card:ml-0.75 group-focus-within/card:ml-0.75',
                        ),
                    'motion-safe:group-hover/card:hover:-translate-y-px',
                  )}
                />
              }
            >
              <UpdateMark agentId={entry.agentId} size={MARK} />
              {entry.updated && <MarkBadge state="updated" className="-right-0.25 -bottom-0.25" />}
            </TooltipTrigger>
            {/* Clear of the card's top edge, as the marks sit 12 px into it. */}
            <TooltipContent sideOffset={16} className="gap-1">
              {entry.name}
              <span className="opacity-65">{entry.versions}</span>
            </TooltipContent>
          </Tooltip>
        )
      })}
      {hidden > 0 && (
        <span className="ml-0.75 max-w-6 overflow-hidden text-caption font-semibold text-(--shell-muted) tabular motion-safe:transition-[max-width,margin-left,opacity] motion-safe:duration-(--duration-slow) motion-safe:ease-standard group-hover/card:ml-0 group-focus-within/card:ml-0 group-hover/card:max-w-0 group-focus-within/card:max-w-0 group-hover/card:opacity-0 group-focus-within/card:opacity-0">
          +{hidden}
        </span>
      )}
    </span>
  )
}

interface FrameProps {
  ref?: Ref<HTMLDivElement>
  label: string
  icon: ReactNode
  title: ReactNode
  note: ReactNode
  action?: ReactNode
  below?: ReactNode
  /** Runs from anywhere on the card: its one action, or opening the list. */
  hit?: ReactNode
  failed?: boolean
  open?: boolean
  /** The words give way while a hovered stack fans out past three marks. */
  fades?: boolean
  onClose?: () => void
  closeLabel?: string
}

/** The update card's frame: a raised card over the account row, closed with ⌫ while focused. */
function CardFrame({
  ref,
  label,
  icon,
  title,
  note,
  action,
  below,
  hit,
  failed,
  open,
  fades,
  onClose,
  closeLabel,
}: FrameProps) {
  const { t } = useTranslation('updates')
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClose || (event.key !== 'Backspace' && event.key !== 'Delete')) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Keys bubble out of a popover's portal too, such as the log's; only the card's own count.
    if (!event.currentTarget.contains(event.target as Node)) return
    event.preventDefault()
    onClose()
  }
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      data-update-card=""
      onKeyDown={onKeyDown}
      className={cn(
        'group/card relative rounded-xl bg-(--shell-card) transition-shadow duration-(--duration-fast) motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:animation-duration-(--duration-slow)',
        failed
          ? 'shadow-(--card-failed)'
          : open
            ? 'shadow-(--shell-card-shadow-hover)'
            : 'shadow-(--shell-card-shadow) hover:shadow-(--shell-card-shadow-hover)',
      )}
    >
      {hit}
      <div className="pointer-events-none relative flex min-h-11 items-center gap-2.5 py-2 pr-2 pl-2.5">
        <span className="pointer-events-auto relative flex shrink-0">{icon}</span>
        <span
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            fades &&
              'motion-safe:transition-opacity motion-safe:duration-(--duration-fast) group-focus-within/card:opacity-0 group-hover/card:opacity-0',
          )}
        >
          <span className="truncate text-control font-medium text-(--shell-ink)">{title}</span>
          <span className="truncate text-small text-(--shell-muted)">{note}</span>
        </span>
        {action && <span className="pointer-events-auto relative flex shrink-0">{action}</span>}
      </div>
      {below && <div className="relative px-2.5 pb-2.25">{below}</div>}
      {onClose && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                aria-label={closeLabel ?? t('close')}
                onClick={onClose}
                className="absolute -top-1.5 -right-1.5 size-4.5 rounded-full text-(--shell-faint) opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/card:opacity-100 group-hover/card:opacity-100 hover:text-(--shell-ink) focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [&_svg:not([class*=size-])]:size-3"
              />
            }
          >
            <Glyph icon={Cancel01Icon} size={12} />
          </TooltipTrigger>
          <TooltipContent>{closeLabel ?? t('close')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** The button under the card's content that runs its action from anywhere on it. */
function hitButton(label: string, onClick?: () => void): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onClick}
      className="absolute inset-0 rounded-xl outline-none"
    />
  )
}

/** Hides what the card offers until something newer; Settings keeps a dot until it is opened. */
function closeItems(items: readonly UpdateItem[]): void {
  let pending = false
  for (const item of items) {
    if (item.kind === 'harness') {
      skipHarnessUpdates([item.offer.agentId])
      pending = true
    } else if (item.notice.kind === 'updated') {
      useUpdatesStore.setState({ updatedDismissed: true })
    } else {
      void window.kettu.updates.dismiss()
      pending = true
    }
  }
  if (pending) setSettingsDot(true)
}

/** The sidebar's one update card, for Kettu and the harnesses; it never stacks a second. */
export function UpdateCardView({
  card,
  items,
  batch,
}: {
  card: UpdateCard
  items: UpdateItem[]
  batch: BatchItem[]
}) {
  const label = updateCardLabel(card)
  const settled = card.kind === 'done' || (card.kind === 'one' && card.updated > 0)
  useEffect(() => {
    if (!settled) return
    const timer = setTimeout(endHarnessBatch, SETTLED_MS)
    return () => clearTimeout(timer)
  }, [settled])
  switch (card.kind) {
    case 'installing':
      return <InstallingCard card={card} items={items} batch={batch} label={label} />
    case 'batch':
      return <BatchCard card={card} items={items} batch={batch} label={label} />
    case 'failed':
      return <FailedCard failure={card.failure} updated={card.updated} label={label} />
    case 'waiting':
      return <WaitingCard item={card.item} batch={card.batch} label={label} />
    case 'one':
      return card.item.kind === 'app' ? (
        <AppCard notice={card.item.notice} updated={card.updated} label={label} />
      ) : (
        <HarnessCard item={card.item} label={label} />
      )
    case 'several':
      return <SeveralCard shown={card.items} items={items} batch={batch} label={label} />
    case 'done':
      return <DoneCard items={card.items} label={label} />
  }
}

/** "2 harnesses updated" under the card that follows a batch. */
function UpdatedLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1 text-caption text-tertiary">
      <Glyph icon={Tick02Icon} size={12} className="text-success" />
      <span className="truncate">{text}</span>
    </div>
  )
}

function AppCard({
  notice,
  updated,
  label,
}: {
  notice: AppUpdateNotice
  updated: number
  label: string
}) {
  const { t } = useTranslation('updates')
  const text = appUpdateText(notice)
  const hit = text.href
    ? () => window.open(text.href!, '_blank', 'noopener')
    : () => runAppAction(text.action)
  return (
    <CardFrame
      label={label}
      icon={<UpdateMark agentId={null} size={ONE_MARK} />}
      title={text.title}
      note={text.note}
      action={<AppAction notice={notice} />}
      below={updated > 0 && <UpdatedLine text={t('batch.updated', { count: updated })} />}
      hit={hitButton(text.actionLabel, hit)}
      onClose={() => closeItems([{ kind: 'app', notice }])}
    />
  )
}

function HarnessCard({ item, label }: { item: HarnessItem; label: string }) {
  const { t } = useTranslation('updates')
  const text = harnessOfferText(item)
  const update = () => updateHarnesses([item.offer.agentId])
  return (
    <CardFrame
      label={label}
      icon={<UpdateMark agentId={item.offer.agentId} size={ONE_MARK} />}
      title={text.title}
      note={<span title={item.offer.command ?? undefined}>{text.note}</span>}
      action={
        <CardButton primary onClick={update}>
          {t('harness.update')}
        </CardButton>
      }
      hit={hitButton(t('harness.update'), update)}
      onClose={() => closeItems([item])}
    />
  )
}

/** The button under the card's content that opens the list beside it. */
function listHit(label: string): ReactNode {
  return (
    <PopoverTrigger
      render={
        <button
          type="button"
          tabIndex={-1}
          aria-label={label}
          className="absolute inset-0 rounded-xl outline-none"
        />
      }
    />
  )
}

/** Two tiers: what the updates are over a full-width Update all; the rest of the card lists them. */
function SeveralCard({
  shown,
  items,
  batch,
  label,
}: {
  shown: UpdateItem[]
  items: UpdateItem[]
  batch: BatchItem[]
  label: string
}) {
  const { t } = useTranslation('updates')
  const current = useUpdatesStore((s) => s.status?.current)
  const [open, setOpen] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const harnesses = shown.flatMap((item) =>
    item.kind === 'harness' && !item.skipped ? [item.offer.agentId] : [],
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <CardFrame
        ref={card}
        label={label}
        open={open}
        icon={
          <UpdateStack
            entries={shown.map((item) => itemEntry(item, current))}
            onOpen={() => setOpen(true)}
          />
        }
        fades={shown.length > STACK}
        title={t('several.title', { count: shown.length })}
        note={severalNote(shown)}
        hit={listHit(t('several.details'))}
        action={
          <PopoverTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('several.details')}
                className="text-(--shell-faint) hover:text-(--shell-ink)"
              />
            }
          >
            <Glyph icon={ArrowRight01Icon} size={14} />
          </PopoverTrigger>
        }
        below={
          <Button
            size="sm"
            disabled={harnesses.length === 0}
            onClick={() => updateHarnesses(harnesses)}
            className="w-full rounded-lg"
          >
            {t('several.updateAll')}
          </Button>
        }
        onClose={() => closeItems(shown)}
        closeLabel={t('several.skip')}
      />
      <ReviewPopover anchor={card} items={items} batch={batch} />
    </Popover>
  )
}

/** The review list beside the card, inside the card's Popover. */
function ReviewPopover({
  anchor,
  items,
  batch,
}: {
  anchor: RefObject<HTMLDivElement | null>
  items: UpdateItem[]
  batch: BatchItem[]
}) {
  return (
    <PopoverContent
      anchor={anchor}
      side="right"
      align="end"
      sideOffset={BESIDE_SIDEBAR}
      className="w-92.5 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0"
    >
      <UpdateReview items={items} batch={batch} />
    </PopoverContent>
  )
}

/** A segment per update of the batch: filled once installed, sweeping while it installs. */
function BatchBar({ items }: { items: BatchItem[] }) {
  const { t } = useTranslation('updates')
  const done = items.filter((item) => item.state === 'updated').length
  return (
    <div
      role="progressbar"
      aria-label={t('harness.progress')}
      aria-valuemin={0}
      aria-valuemax={items.length}
      aria-valuenow={done}
      className="flex gap-0.75"
    >
      {items.map((item) => (
        <span
          key={item.agentId}
          className={cn(
            'relative h-0.75 flex-1 overflow-hidden rounded-xs',
            item.state === 'waiting'
              ? 'bg-[repeating-linear-gradient(-45deg,var(--border-soft)_0_3px,transparent_3px_5px)] shadow-[inset_0_0_0_var(--hairline)_var(--border-soft)]'
              : 'bg-border-soft',
          )}
        >
          {item.state === 'updated' && (
            <span className="absolute inset-0 rounded-xs bg-(--text-secondary)" />
          )}
          {item.state === 'failed' && <span className="absolute inset-0 rounded-xs bg-danger" />}
          {item.state === 'installing' && (
            <span
              aria-hidden
              className="absolute inset-0 motion-safe:animate-[sheen_1.4s_var(--ease-standard)_infinite] motion-reduce:opacity-40"
            >
              <span className="block h-full w-2/5 rounded-xs bg-(--text-secondary) motion-reduce:w-full" />
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

/** The bar and, for more than one update, what comes next and how many are done. */
function BatchProgress({ items, sayWaiting }: { items: BatchItem[]; sayWaiting: boolean }) {
  const { t } = useTranslation('updates')
  const done = items.filter((item) => item.state === 'updated').length
  const queued = items.filter((item) => item.state === 'queued').length
  const waiting = sayWaiting ? items.find((item) => item.state === 'waiting') : undefined
  return (
    <>
      <BatchBar items={items} />
      {items.length > 1 && (
        <div className="mt-1.25 flex gap-2 text-[11px] leading-3.5 text-tertiary tabular">
          <span className={cn('min-w-0 flex-1 truncate', waiting && 'text-warning')}>
            {waiting
              ? t('batch.waits', { name: waiting.name })
              : queued > 0 && t('harness.more', { count: queued })}
          </span>
          <span>{t('batch.of', { done, total: items.length })}</span>
        </div>
      )}
    </>
  )
}

/** A batch installing: the update it is on, the batch's bar under it. */
function BatchCard({
  card,
  items,
  batch,
  label,
}: {
  card: Extract<UpdateCard, { kind: 'batch' }>
  items: UpdateItem[]
  batch: BatchItem[]
  label: string
}) {
  const { t } = useTranslation('updates')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const subject =
    card.items.find((item) => item.state === 'installing') ??
    card.items.find((item) => item.state === 'queued')!
  const run = card.run?.agentId === subject.agentId ? card.run : null
  const note = run?.output.at(-1) ?? run?.command ?? batchVersions(subject)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <CardFrame
        ref={ref}
        label={label}
        open={open}
        hit={listHit(t('several.details'))}
        icon={<SubjectMark agentId={subject.agentId} state={subject.state} />}
        title={label}
        note={<span title={run?.command}>{note}</span>}
        below={<BatchProgress items={card.items} sayWaiting />}
        onClose={stopHarnessBatch}
        closeLabel={t('harness.stop')}
      />
      <ReviewPopover anchor={ref} items={items} batch={batch} />
    </Popover>
  )
}

function WaitingCard({
  item,
  batch,
  label,
}: {
  item: HarnessItem
  batch: BatchItem[]
  label: string
}) {
  const { t } = useTranslation('updates')
  const [asking, setAsking] = useState(false)
  const { offer } = item
  return (
    <>
      <CardFrame
        label={label}
        icon={<SubjectMark agentId={offer.agentId} state="waiting" />}
        title={label}
        note={t('harness.waitingNote', { count: item.running })}
        action={
          <CardButton quiet onClick={() => setAsking(true)}>
            {t('harness.now')}
          </CardButton>
        }
        below={batch.length > 1 && <BatchProgress items={batch} sayWaiting={false} />}
        onClose={() => forgetHarnessUpdate(offer.agentId)}
        closeLabel={t('harness.dontWait')}
      />
      <UpdateNowDialog
        agentId={offer.agentId}
        name={offer.name}
        open={asking}
        onOpenChange={setAsking}
      />
    </>
  )
}

/** A 3 px bar in grey: updating is routine work. Without a percentage a segment sweeps across. */
function UpdateBar({ percent, label }: { percent: number | null; label: string }) {
  return (
    <ProgressPrimitive.Root value={percent} aria-label={label}>
      <ProgressPrimitive.Track className="relative h-0.75 overflow-hidden rounded-xs bg-border-soft">
        {percent === null ? (
          <span
            aria-hidden
            className="absolute inset-0 motion-safe:animate-[sheen_1.4s_var(--ease-standard)_infinite] motion-reduce:opacity-40"
          >
            <span className="block h-full w-2/5 rounded-xs bg-(--text-secondary) motion-reduce:w-full" />
          </span>
        ) : (
          <ProgressPrimitive.Indicator className="h-full rounded-xs bg-(--text-secondary) transition-[width] duration-(--duration-base)" />
        )}
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

/** Kettu's own download, or a harness update started outside the card. */
function InstallingCard({
  card,
  items,
  batch,
  label,
}: {
  card: Extract<UpdateCard, { kind: 'installing' }>
  /** The other updates, which the card opens the list of so each can still act on its own. */
  items: UpdateItem[]
  batch: BatchItem[]
  label: string
}) {
  const { t } = useTranslation('updates')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { run } = card
  const app = run.kind === 'app' ? appUpdateText(run.notice) : null
  const harness = run.kind === 'harness' ? run.run : null
  const note = app?.note ?? harness?.output.at(-1) ?? harness?.command ?? ''
  const close =
    run.kind === 'harness'
      ? () => stopHarnessUpdate(run.run.agentId)
      : run.notice.kind === 'downloading'
        ? () => void window.kettu.updates.cancel()
        : undefined
  const frame = (
    <CardFrame
      ref={ref}
      label={label}
      open={open}
      hit={
        items.length > 0 && (
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={t('several.details')}
                className="absolute inset-0 rounded-xl outline-none focus-visible:focus-ring"
              />
            }
          />
        )
      }
      icon={
        harness ? (
          <SubjectMark agentId={harness.agentId} state="installing" />
        ) : (
          <UpdateMark agentId={null} size={ONE_MARK} />
        )
      }
      title={label}
      note={<span title={harness?.command}>{note}</span>}
      below={
        <>
          <UpdateBar
            percent={card.percent}
            label={app ? t('app.installing') : t('harness.progress')}
          />
          {(card.more > 0 || card.percent !== null) && (
            <div className="mt-1.25 flex text-[11px] leading-3.5 text-tertiary tabular">
              <span className="flex-1">
                {card.more > 0 && t('harness.more', { count: card.more })}
              </span>
              {card.percent !== null && <span>{card.percent}%</span>}
            </div>
          )}
        </>
      }
      onClose={close}
      closeLabel={run.kind === 'harness' ? t('harness.stop') : t('app.cancel')}
    />
  )
  if (items.length === 0) return frame
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {frame}
      <ReviewPopover anchor={ref} items={items} batch={batch} />
    </Popover>
  )
}

function FailedCard({
  failure,
  updated,
  label,
}: {
  failure: HarnessFailure
  updated: number
  label: string
}) {
  const { t } = useTranslation('updates')
  const retry = () => retryHarnessUpdate(failure.agentId, failure.retry)
  const card = useRef<HTMLDivElement>(null)
  return (
    <CardFrame
      ref={card}
      failed
      label={label}
      icon={<SubjectMark agentId={failure.agentId} state="failed" />}
      title={label}
      note={<span title={failure.error}>{failure.error}</span>}
      action={
        <CardButton primary onClick={retry}>
          {t('harness.retry')}
        </CardButton>
      }
      below={
        <>
          <div className="text-caption text-tertiary">
            <UpdateLog failure={failure} anchor={card} /> ·{' '}
            <button
              type="button"
              onClick={() => openHarnessSettings(failure.harnessId)}
              className="rounded-xs text-secondary underline decoration-border-strong underline-offset-2 outline-none hover:text-primary hover:decoration-current focus-visible:focus-ring"
            >
              {t('harness.otherWay')}
            </button>
          </div>
          {updated > 0 && (
            <div className="mt-1">
              <UpdatedLine text={t('batch.othersUpdated', { count: updated })} />
            </div>
          )}
        </>
      }
      onClose={() => closeHarnessFailure(failure.agentId)}
    />
  )
}

/** Every update of the batch installed: said for a moment, or until clicked. */
function DoneCard({ items, label }: { items: BatchItem[]; label: string }) {
  const { t } = useTranslation('updates')
  return (
    <CardFrame
      label={label}
      icon={<UpdateStack entries={items.map(batchEntry)} />}
      fades={items.length > STACK}
      title={label}
      note={items
        .map((item) => `${item.name} ${item.to}`)
        .join(i18n.t('sidebar:footer.listSeparator'))}
      hit={hitButton(t('close'), endHarnessBatch)}
    />
  )
}

/** The failed update's command and the last lines it printed. */
function UpdateLog({
  failure,
  anchor,
}: {
  failure: HarnessFailure
  anchor: RefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation('updates')
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="rounded-xs text-secondary underline decoration-border-strong underline-offset-2 outline-none hover:text-primary hover:decoration-current focus-visible:focus-ring"
          />
        }
      >
        {t('harness.viewLog')}
      </PopoverTrigger>
      <PopoverContent
        anchor={anchor}
        side="right"
        align="end"
        sideOffset={BESIDE_SIDEBAR}
        className="w-100 max-w-[calc(100vw-2rem)] gap-2 p-3"
      >
        <PopoverTitle className="text-control font-semibold">
          {t('harness.logTitle', { name: failure.name })}
        </PopoverTitle>
        {failure.command && <CommandLine command={failure.command} />}
        {failure.output.length > 0 ? (
          <pre className="max-h-48 overflow-auto rounded-lg bg-code-block p-2 font-mono text-code leading-4.5 whitespace-pre-wrap text-secondary">
            {failure.output.join('\n')}
          </pre>
        ) : (
          <p className="text-caption text-tertiary">{t('harness.noLog')}</p>
        )}
        <p className="text-caption break-words text-danger">{failure.error}</p>
      </PopoverContent>
    </Popover>
  )
}
