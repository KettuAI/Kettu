import { useTranslation } from 'react-i18next'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { PlanPart } from '@renderer/features/session/composer/usage'
import { ringStroke } from '@renderer/features/usage/plan-cards'
import { LIMIT_TEXT } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'
import { useHostName, useWindowHost } from '@renderer/stores/window-host'
import type { PlanCard } from './model'

/**
 * An account's plan windows: its rings and, from the outer ring in, each window's figure. It
 * opens the Usage page; hovered or focused, it shows every window beside it.
 */
export function PlanLimitCard({ card, onOpen }: { card: PlanCard; onOpen: () => void }) {
  const hostName = useHostName()
  // With every host shown, which of them the account is on.
  const hosts = useWindowHost().kind === 'all' ? card.hostIds.map(hostName).join(' · ') : null
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={100}
        closeDelay={100}
        render={
          <button
            type="button"
            onClick={onOpen}
            className="kettu-plan-card min-w-0 rounded-tile outline-none select-none"
          />
        }
      >
        <CardFace card={card} />
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={6} className="w-68">
        <div className="mb-2.5 flex min-w-0 items-center gap-1.5">
          <AgentTile agent={card.agentId} hostId={card.hostId} size={18} />
          <span className="min-w-0 truncate text-small font-semibold text-primary">
            {card.agentName}
          </span>
          {hosts && (
            <span className="ml-auto min-w-0 shrink truncate text-hint text-tertiary">{hosts}</span>
          )}
        </div>
        <PlanPart limits={card.limits} account={card.account} />
      </HoverCardContent>
    </HoverCard>
  )
}

function CardFace({ card }: { card: PlanCard }) {
  const { t } = useTranslation(['sidebar', 'composer', 'common'])
  const count = card.windows.length
  return (
    <>
      <span className="flex h-4 min-w-0 items-center gap-1.25">
        <AgentMark agent={card.agentId} hostId={card.hostId} size={14} />
        <span className="min-w-0 truncate text-small font-medium text-primary">{card.name}</span>
        {card.tier && (
          <span className="ml-auto shrink-0 text-badge leading-3.75 font-medium text-tertiary">
            {card.tier}
          </span>
        )}
      </span>
      <span className="mt-1.75 flex items-center gap-2.25">
        <PlanRings
          rings={card.windows.map((w) => ({ id: w.id, percent: w.percent, level: w.level }))}
          size={36}
          {...(count > 3
            ? ringStroke(count, 36)
            : { stroke: count > 2 ? 3.5 : count > 1 ? 4 : 4.5, gap: count > 2 ? 1.5 : 2 })}
          track="neutral"
          className="size-9"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          {[...card.windows].reverse().map((w) => {
            const name = w.model
              ? t('common:planWindow.weeklyOf', { model: w.model })
              : t(`common:planWindow.${w.window}`)
            // A model's name beside "100%" is too wide for the card; its details name it.
            const short = w.model
              ? w.model.charAt(0).toUpperCase()
              : t(`composer:usage.shortWindow.${w.window}`)
            return (
              <span
                key={w.id}
                className="flex justify-between gap-1 text-caption leading-3.25 whitespace-nowrap"
              >
                <span aria-hidden className="text-tertiary">
                  {short}
                </span>
                <span
                  aria-hidden
                  className={cn('tabular', w.level === 'ok' ? 'text-primary' : LIMIT_TEXT[w.level])}
                >
                  {w.percent}%
                </span>
                <span className="sr-only">
                  {t('sidebar:account.limitUsed', { window: name, percent: w.percent })}
                </span>
              </span>
            )
          })}
        </span>
      </span>
    </>
  )
}
