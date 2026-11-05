import { useTranslation } from 'react-i18next'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { LIMIT_STROKE, LIMIT_TEXT } from '@renderer/lib/plan-limit'
import { cn } from '@renderer/lib/utils'
import type { CardWindow, PlanCard } from './model'

const RINGS_SIZE = 40
const RING_GAP = 1.5

/** One ring per window, the shortest innermost, each filled to how much of it is used. */
function PlanRings({ windows }: { windows: readonly CardWindow[] }) {
  const center = RINGS_SIZE / 2
  const stroke = windows.length > 2 ? 4 : 5
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${RINGS_SIZE} ${RINGS_SIZE}`}
      className="size-10 shrink-0 -rotate-90"
    >
      {windows.map((w, i) => {
        const fromOuter = windows.length - 1 - i
        const r = center - stroke / 2 - fromOuter * (stroke + RING_GAP)
        const length = 2 * Math.PI * r
        const share = w.percent === null ? 0 : Math.min(100, w.percent) / 100
        return (
          <g key={w.window} className={w.level ? LIMIT_STROKE[w.level] : 'text-tertiary'}>
            <circle
              cx={center}
              cy={center}
              r={r}
              fill="none"
              strokeWidth={stroke}
              className="stroke-current opacity-(--ring-tint)"
            />
            {share > 0 && (
              <circle
                cx={center}
                cy={center}
                r={r}
                fill="none"
                strokeWidth={stroke}
                // A full ring has no gap for a round cap to show in.
                strokeLinecap={share < 1 ? 'round' : 'butt'}
                strokeDasharray={`${share * length} ${length}`}
                className="stroke-current"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** An account's plan windows: its rings and, from the outer ring in, each window's figure. */
export function PlanLimitCard({ card }: { card: PlanCard }) {
  const { t } = useTranslation(['sidebar', 'composer', 'common'])
  return (
    <div
      role="group"
      aria-label={
        card.tier ? t('sidebar:account.limitCard', { name: card.name, tier: card.tier }) : card.name
      }
      className="min-w-0 rounded-tile bg-subtle px-2 pt-2 pb-2.25"
    >
      <div className="flex h-4.5 min-w-0 items-center gap-1.5">
        <AgentTile agent={card.agentId} size={18} />
        <span className="min-w-0 truncate text-small font-semibold text-primary">{card.name}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <PlanRings windows={card.windows} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          {/* Beside the rings, where a tier like "Max 20x" fits next to any agent's name. */}
          {card.tier && (
            <span className="mb-0.5 self-end truncate rounded-sm bg-popover px-1.25 text-badge leading-3.75 text-secondary shadow-[0_0_0_var(--hairline)_var(--border-subtle)]">
              {card.tier}
            </span>
          )}
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
    </div>
  )
}
