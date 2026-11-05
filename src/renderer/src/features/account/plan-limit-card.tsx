import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { useTranslation } from 'react-i18next'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { PlanRings } from '@renderer/components/plan-rings'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { PlanPart } from '@renderer/features/session/composer/usage'
import { LIMIT_TEXT } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'
import { openUsage } from '@renderer/stores/view'
import type { PlanCard } from './model'

/**
 * An account's plan windows: its rings and, from the outer ring in, each window's figure. It
 * opens the Usage page; hovered or reached by the keyboard, it shows every window beside it.
 */
export function PlanLimitCard({ card }: { card: PlanCard }) {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={100}
        closeDelay={100}
        render={
          <MenuPrimitive.Item
            onClick={openUsage}
            className="min-w-0 cursor-default rounded-tile bg-subtle px-2 pt-2 pb-2.25 outline-none select-none data-highlighted:bg-selected"
          />
        }
      >
        <CardFace card={card} />
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={6} className="w-68">
        <div className="mb-2.5 flex min-w-0 items-center gap-1.5">
          <AgentTile agent={card.agentId} size={18} />
          <span className="min-w-0 truncate text-small font-semibold text-primary">
            {card.agentName}
          </span>
        </div>
        <PlanPart limits={card.limits} account={card.account} />
      </HoverCardContent>
    </HoverCard>
  )
}

function CardFace({ card }: { card: PlanCard }) {
  const { t } = useTranslation(['sidebar', 'composer', 'common'])
  return (
    <>
      <div className="flex h-4.5 min-w-0 items-center gap-1.5">
        <AgentTile agent={card.agentId} size={18} />
        <span className="min-w-0 truncate text-small font-semibold text-primary">{card.name}</span>
        {card.tier && (
          <span className="ml-auto shrink-0 rounded-sm bg-popover px-1.25 text-badge leading-3.75 text-secondary shadow-[0_0_0_var(--hairline)_var(--border-subtle)]">
            {card.tier}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <PlanRings
          rings={card.windows.map((w) => ({ id: w.window, percent: w.percent, level: w.level }))}
          size={40}
          stroke={card.windows.length > 2 ? 4 : 5}
          gap={1.5}
          className="size-10"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          {[...card.windows].reverse().map((w) => {
            const name = t(`common:planWindow.${w.window}`)
            return (
              <div
                key={w.window}
                className="flex justify-between gap-1 text-caption leading-3.25 whitespace-nowrap"
              >
                <span aria-hidden className="text-tertiary">
                  {t(`composer:usage.shortWindow.${w.window}`)}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'tabular',
                    w.level === null
                      ? 'text-tertiary'
                      : w.level === 'ok'
                        ? 'text-primary'
                        : LIMIT_TEXT[w.level],
                  )}
                >
                  {w.percent === null ? '—' : `${w.percent}%`}
                </span>
                <span className="sr-only">
                  {w.percent === null
                    ? t('sidebar:account.limitStale', { window: name })
                    : t('sidebar:account.limitUsed', { window: name, percent: w.percent })}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
