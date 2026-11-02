import {
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { Progress as ProgressPrimitive } from '@base-ui/react/progress'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CommandLine } from '@renderer/components/command-line'
import { Button } from '@renderer/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
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
  type HarnessItem,
  type UpdateCard,
  type UpdateItem,
} from './card-model'
import {
  closeHarnessFailure,
  forgetHarnessUpdate,
  retryHarnessUpdate,
  skipHarnessUpdates,
  stopHarnessUpdate,
  updateHarnesses,
} from './harness-updates'
import {
  AppAction,
  CardButton,
  HarnessTile,
  ItemTile,
  KettuTile,
  UpdateNowDialog,
} from './update-parts'
import { CARD_BUTTON, runAppAction } from './update-actions'
import { UpdateReview } from './update-review'

// From the card's edge past the footer's padding and the sidebar's border, to sit beside it.
const BESIDE_SIDEBAR = 18

/** What one entry of the stack names on hover: "Claude Code 2.4.1 → 2.5.0". */
function itemVersions(item: UpdateItem): { name: string; versions: string } {
  if (item.kind === 'harness') return { name: item.offer.name, versions: versionsText(item.offer) }
  const { notice } = item
  const from = notice.kind === 'updated' ? notice.from : useUpdatesStore.getState().status?.current
  return { name: 'Kettu', versions: from ? `${from} → ${notice.version}` : notice.version }
}

/** The entries' marks, overlapping at rest and fanned out while the card is hovered. */
function UpdateStack({ items, onOpen }: { items: UpdateItem[]; onOpen: () => void }) {
  return (
    <span className="relative flex shrink-0 items-center">
      {items.map((item, index) => {
        const { name, versions } = itemVersions(item)
        return (
          <Tooltip key={item.kind === 'app' ? 'kettu' : item.offer.agentId}>
            <TooltipTrigger
              delay={150}
              onClick={onOpen}
              style={{ zIndex: items.length - index }}
              render={
                <span
                  className={cn(
                    'relative flex rounded-tile shadow-[0_0_0_2px_var(--bg-surface)] motion-safe:transition-[margin-left,translate] motion-safe:duration-(--duration-slow) motion-safe:ease-standard',
                    index > 0 && '-ml-2.25 motion-safe:group-hover/card:ml-1',
                    'motion-safe:group-hover/card:hover:-translate-y-px',
                  )}
                />
              }
            >
              <ItemTile item={item} size={20} />
            </TooltipTrigger>
            <TooltipContent>
              {name} <span className="opacity-65">{versions}</span>
            </TooltipContent>
          </Tooltip>
        )
      })}
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
  onClose,
  closeLabel,
}: FrameProps) {
  const { t } = useTranslation('updates')
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onClose || (event.key !== 'Backspace' && event.key !== 'Delete')) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
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
        'group/card relative rounded-xl bg-surface transition-shadow duration-(--duration-fast) motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:animation-duration-(--duration-slow)',
        failed
          ? 'shadow-(--card-failed)'
          : open
            ? 'shadow-(--card-open)'
            : 'shadow-card hover:shadow-(--card-lift)',
      )}
    >
      {hit}
      <div className="pointer-events-none relative flex min-h-11 items-center gap-2.5 py-1.75 pr-1.75 pl-2.5">
        <span className="pointer-events-auto relative flex shrink-0">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-hint leading-3.75 font-medium text-primary">{title}</span>
          <span className="mt-px truncate text-caption leading-3.5 text-tertiary">{note}</span>
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
                className="absolute -top-1.5 -right-1.5 size-5 rounded-full text-icon opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/card:opacity-100 group-hover/card:opacity-100 hover:text-primary focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [&_svg:not([class*=size-])]:size-3"
              />
            }
          >
            <XIcon strokeWidth={1.8} />
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
export function UpdateCardView({ card, items }: { card: UpdateCard; items: UpdateItem[] }) {
  const label = updateCardLabel(card)
  switch (card.kind) {
    case 'installing':
      return <InstallingCard card={card} label={label} />
    case 'failed':
      return <FailedCard failure={card.failure} label={label} />
    case 'waiting':
      return <WaitingCard item={card.item} label={label} />
    case 'one':
      return card.item.kind === 'app' ? (
        <AppCard notice={card.item.notice} label={label} />
      ) : (
        <HarnessCard item={card.item} label={label} />
      )
    case 'several':
      return <SeveralCard shown={card.items} items={items} label={label} />
  }
}

function AppCard({ notice, label }: { notice: AppUpdateNotice; label: string }) {
  const text = appUpdateText(notice)
  const hit = text.href
    ? () => window.open(text.href!, '_blank', 'noopener')
    : () => runAppAction(text.action)
  return (
    <CardFrame
      label={label}
      icon={<KettuTile size={22} />}
      title={text.title}
      note={text.note}
      action={<AppAction notice={notice} />}
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
      icon={<HarnessTile agentId={item.offer.agentId} size={22} />}
      title={text.title}
      note={<span title={item.offer.command ?? undefined}>{text.note}</span>}
      action={<CardButton onClick={update}>{t('harness.update')}</CardButton>}
      hit={hitButton(t('harness.update'), update)}
      onClose={() => closeItems([item])}
    />
  )
}

function SeveralCard({
  shown,
  items,
  label,
}: {
  shown: UpdateItem[]
  items: UpdateItem[]
  label: string
}) {
  const { t } = useTranslation('updates')
  const [open, setOpen] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <CardFrame
        ref={card}
        label={label}
        open={open}
        icon={<UpdateStack items={shown} onOpen={() => setOpen(true)} />}
        title={t('several.title', { count: shown.length })}
        note={severalNote(shown)}
        hit={
          <PopoverTrigger
            render={
              <button
                type="button"
                tabIndex={-1}
                aria-label={t('several.review')}
                className="absolute inset-0 rounded-xl outline-none"
              />
            }
          />
        }
        action={
          <PopoverTrigger render={<Button size="xs" variant="secondary" className={CARD_BUTTON} />}>
            {t('several.review')}
          </PopoverTrigger>
        }
        onClose={() => closeItems(shown)}
      />
      <PopoverContent
        anchor={card}
        side="right"
        align="end"
        sideOffset={BESIDE_SIDEBAR}
        className="w-92.5 gap-0 overflow-hidden p-0"
      >
        <UpdateReview items={items} />
      </PopoverContent>
    </Popover>
  )
}

function WaitingCard({ item, label }: { item: HarnessItem; label: string }) {
  const { t } = useTranslation('updates')
  const [asking, setAsking] = useState(false)
  const { offer } = item
  return (
    <>
      <CardFrame
        label={label}
        icon={<HarnessTile agentId={offer.agentId} size={22} />}
        title={label}
        note={t('harness.waitingNote', { count: item.running })}
        action={
          <CardButton quiet onClick={() => setAsking(true)}>
            {t('harness.now')}
          </CardButton>
        }
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

function InstallingCard({
  card,
  label,
}: {
  card: Extract<UpdateCard, { kind: 'installing' }>
  label: string
}) {
  const { t } = useTranslation('updates')
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
  return (
    <CardFrame
      label={label}
      icon={harness ? <HarnessTile agentId={harness.agentId} size={22} /> : <KettuTile size={22} />}
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
}

function FailedCard({ failure, label }: { failure: HarnessFailure; label: string }) {
  const { t } = useTranslation('updates')
  const retry = () => retryHarnessUpdate(failure.agentId, failure.retry)
  const card = useRef<HTMLDivElement>(null)
  return (
    <CardFrame
      ref={card}
      failed
      label={label}
      icon={
        <span className="relative flex">
          <HarnessTile agentId={failure.agentId} size={22} />
          <span
            aria-hidden
            className="absolute -right-0.75 -bottom-0.75 grid size-2.75 place-items-center rounded-full bg-danger text-(--on-fill) shadow-[0_0_0_1.5px_var(--bg-surface)]"
          >
            <XIcon strokeWidth={3.2} className="size-2" />
          </span>
        </span>
      }
      title={label}
      note={<span title={failure.error}>{failure.error}</span>}
      action={<CardButton onClick={retry}>{t('harness.retry')}</CardButton>}
      below={
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
      }
      onClose={() => closeHarnessFailure(failure.agentId)}
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
