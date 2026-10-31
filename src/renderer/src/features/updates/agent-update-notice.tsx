import { useRef, useState } from 'react'
import { ArrowRightIcon, BotIcon, CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { CommandLine } from '@renderer/components/command-line'
import { Button } from '@renderer/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import {
  agentUpdateLabel,
  offerRoute,
  type AgentUpdateNotice,
  type AgentUpdateOffer,
  type AgentUpdateRoute,
} from './agent-updates'
import { NoticeCard, NoticeVersion } from './update-notice'

// From the card's edge past the footer's padding and the sidebar's border, to sit beside the sidebar.
const BESIDE_SIDEBAR = 16

/** The offers Update all has yet to run; stopping the one running drops them. */
let queued: AgentUpdateOffer[] = []

function runUpdate(agentId: AgentId, route: AgentUpdateRoute): Promise<void> {
  const agents = useAgentsStore.getState()
  return route === 'cli' ? agents.updateCli(agentId) : agents.update(agentId)
}

async function updateAll(offers: AgentUpdateOffer[]): Promise<void> {
  queued = [...offers]
  for (let offer = queued.shift(); offer; offer = queued.shift()) {
    await runUpdate(offer.agentId, offerRoute(offer))
  }
}

/** Stops a running update, or clears a failed one. */
function cancelTask(agentId: AgentId): void {
  queued = []
  void useAgentsStore.getState().cancelTask(agentId)
}

function skip(offers: AgentUpdateOffer[]): void {
  for (const { agentId } of offers) {
    void host('agents.skipUpdate', { agentId }).catch((error: unknown) =>
      console.warn(`Could not skip the agent update: ${errorMessage(error)}`),
    )
  }
}

/** A newer Claude Code, Codex or adapter as a card in the sidebar's notices, updated from there. */
export function AgentUpdateCard({ notice }: { notice: AgentUpdateNotice }) {
  const { t } = useTranslation(['updates', 'common'])
  const label = agentUpdateLabel(notice)
  switch (notice.kind) {
    case 'one':
      return <OfferCard offer={notice.offer} label={label} />
    case 'many':
      return <OffersCard offers={notice.offers} label={label} />
    case 'running':
      return (
        <NoticeCard
          icon={<Spinner aria-hidden className="size-3.5 text-info" />}
          text={label}
          label={label}
          below={<Command command={notice.command} />}
          onCancel={() => cancelTask(notice.agentId)}
          cancelLabel={t('agentNotice.stop')}
        />
      )
    case 'failed': {
      const retry = () => void runUpdate(notice.agentId, notice.retry)
      return (
        <NoticeCard
          icon={<CircleAlertIcon className="size-3.5 text-danger" />}
          text={label}
          label={label}
          detail={notice.error}
          below={
            <span className="line-clamp-2 text-meta leading-4 break-words text-tertiary">
              {notice.error}
            </span>
          }
          onOpen={retry}
          action={
            <Button variant="outline" size="xs" onClick={retry}>
              {t('common:actions.retry')}
            </Button>
          }
          onCancel={() => cancelTask(notice.agentId)}
          cancelLabel={t('common:actions.close')}
        />
      )
    }
  }
}

/** One harness's update: the card opens a confirmation beside it, which runs the update. */
function OfferCard({ offer, label }: { offer: AgentUpdateOffer; label: string }) {
  const { t } = useTranslation(['updates', 'common', 'settings'])
  const [open, setOpen] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const update = () => {
    setOpen(false)
    void runUpdate(offer.agentId, offerRoute(offer))
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <NoticeCard
        ref={card}
        icon={<AgentMark agent={offer.agentId} size={14} />}
        text={t('agentNotice.one', { name: offer.name })}
        label={label}
        below={
          <span className="text-meta leading-4 text-tertiary">
            <Versions offer={offer} />
          </span>
        }
        opener={<PopoverTrigger />}
        action={
          <PopoverTrigger render={<Button size="xs" />}>{t('agentNotice.update')}</PopoverTrigger>
        }
        onDismiss={() => skip([offer])}
      />
      {/* As wide as its widest item; contain-inline-size lets the sentences wrap to it. */}
      <PopoverContent
        anchor={card}
        side="right"
        align="end"
        sideOffset={BESIDE_SIDEBAR}
        className="w-max max-w-100 min-w-85 gap-3 p-4"
      >
        <div className="flex items-center gap-2">
          <AgentMark agent={offer.agentId} size={15} />
          <PopoverTitle className="min-w-0 flex-1 font-semibold">
            {t('agentNotice.confirmTitle', { name: offer.name })}
          </PopoverTitle>
          <span className="text-meta text-tertiary">
            <Versions offer={offer} emphasis />
          </span>
        </div>
        {offer.command ? (
          <div className="flex flex-col gap-2">
            <PopoverDescription className="text-ui leading-5 contain-inline-size">
              {offer.method
                ? t('agentNotice.runsAs', {
                    method: t(`settings:harnesses.methods.${offer.method}`),
                  })
                : t('agentNotice.runs')}
            </PopoverDescription>
            <CommandLine command={offer.command} />
          </div>
        ) : (
          <PopoverDescription className="text-ui leading-5 contain-inline-size">
            {t('agentNotice.package', { package: offer.package?.name ?? '' })}
          </PopoverDescription>
        )}
        <p className="text-meta leading-4.5 text-tertiary contain-inline-size">
          {t('agentNotice.sessions')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t('common:actions.cancel')}
          </Button>
          <Button size="sm" onClick={update}>
            {t('agentNotice.update')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Several harnesses' updates: the card opens a list beside it, each row updated on its own. */
function OffersCard({ offers, label }: { offers: AgentUpdateOffer[]; label: string }) {
  const { t } = useTranslation('updates')
  const [open, setOpen] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const run = (picked: AgentUpdateOffer[]) => {
    setOpen(false)
    void updateAll(picked)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <NoticeCard
        ref={card}
        icon={<BotIcon className="size-3.5 text-icon" />}
        text={
          <>
            {t('agentNotice.many')} <NoticeVersion>{offers.length}</NoticeVersion>
          </>
        }
        label={label}
        opener={<PopoverTrigger />}
        action={
          <PopoverTrigger render={<Button size="xs" />}>{t('agentNotice.view')}</PopoverTrigger>
        }
        onDismiss={() => skip(offers)}
      />
      <PopoverContent
        anchor={card}
        side="right"
        align="end"
        sideOffset={BESIDE_SIDEBAR}
        className="w-max max-w-120 min-w-85 gap-1 p-2"
      >
        <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-2.5">
          <PopoverTitle className="min-w-0 flex-1 font-semibold">
            {t('agentNotice.many')}
          </PopoverTitle>
          <Button size="xs" onClick={() => run(offers)}>
            {t('agentNotice.updateAll')}
          </Button>
        </div>
        <ul className="flex flex-col">
          {offers.map((offer) => (
            <li key={offer.agentId} className="flex items-center gap-2.5 py-2 pr-2 pl-2.5">
              <span className="mt-0.5 grid w-4 shrink-0 place-items-center self-start">
                <AgentMark agent={offer.agentId} size={15} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0 font-medium">{offer.name}</span>
                  <span className="min-w-0 truncate text-meta text-tertiary">
                    <Versions offer={offer} emphasis />
                  </span>
                </span>
                {offer.command ? (
                  <Command command={offer.command} />
                ) : (
                  <span className="text-meta leading-4 text-tertiary">
                    {t('agentNotice.packageRow', { package: offer.package?.name ?? '' })}
                  </span>
                )}
              </span>
              <Button variant="outline" size="xs" onClick={() => run([offer])}>
                {t('agentNotice.update')}
              </Button>
            </li>
          ))}
        </ul>
        <p className="px-2.5 py-1.5 text-meta leading-4.5 text-tertiary shadow-[inset_0_var(--hairline)_0_var(--border-subtle)] contain-inline-size">
          {t('agentNotice.listNote')}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** "2.1.314 -> 2.1.316", the package's name first when the versions are its own. */
function Versions({ offer, emphasis }: { offer: AgentUpdateOffer; emphasis?: boolean }) {
  const { t } = useTranslation('updates')
  const to = <span className={cn('tabular', emphasis && 'text-primary')}>{offer.to}</span>
  if (!offer.from) return to
  const from = offer.package?.versions ? `${offer.package.name} ${offer.from}` : offer.from
  return (
    <>
      <span className="sr-only">{t('agentNotice.versions', { from, to: offer.to })}</span>
      <span aria-hidden>
        <span className="tabular">{from}</span>{' '}
        <ArrowRightIcon className="inline size-3 align-[-0.125em]" /> {to}
      </span>
    </>
  )
}

/** A command as it runs, on one line under a card's or a row's words. */
function Command({ command }: { command: string }) {
  return (
    <code className="truncate font-mono text-code leading-4 text-tertiary" title={command}>
      <span aria-hidden>$ </span>
      {command}
    </code>
  )
}
