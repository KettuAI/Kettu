import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { KnownExpiry } from '@shared/prompt-cache'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { useCacheLeft } from '@renderer/features/prompt-cache/cache-phase'
import { countdown, longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { hostOfSession } from '@renderer/stores/sessions'
import type { SessionCache } from './session-cache'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** What a row's hover card says about its session: the agent, model, branch, cache, last turn. */
export function SessionCard({ summary, cache }: { summary: SessionSummary; cache: SessionCache }) {
  const { t } = useTranslation('sidebar')
  const model = useModelName(summary)
  const now = useNow()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <AgentMark agent={summary.agentId} size={16} />
        <span className="truncate text-[13.5px] font-semibold text-primary">
          {agentName(summary.agentId, hostOfSession(summary))}
        </span>
      </div>
      <dl className="flex flex-col gap-[5px] text-hint text-secondary">
        {model && <Line label={t('card.model')}>{model}</Line>}
        {summary.branch && (
          <Line label={t('card.branch')}>
            <span className="truncate font-mono text-code">{summary.branch}</span>
          </Line>
        )}
        {cache && (
          <Line label={t('card.cache')}>
            {cache.state === 'none' ? (
              t('card.cacheNone')
            ) : cache.state === 'expired' ? (
              t(cache.cache.estimate ? 'card.cacheLikelyExpired' : 'card.cacheExpired')
            ) : (
              <CacheLeft cache={cache.cache} ending={cache.state === 'ending'} />
            )}
          </Line>
        )}
        <Line label={t('card.lastTurn')}>{longAgo(summary.updatedAt, now)}</Line>
      </dl>
    </div>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <dt className="shrink-0 text-tertiary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 tabular-nums">{children}</dd>
    </div>
  )
}

function CacheLeft({ cache, ending }: { cache: KnownExpiry; ending: boolean }) {
  const { t } = useTranslation('sidebar')
  const left = useCacheLeft(cache.expiresAt, (ms) =>
    ms < HOUR ? Math.max(1, Math.ceil(ms / MINUTE)) * MINUTE : Math.floor(ms / MINUTE) * MINUTE,
  )
  if (left === null) return null
  const text =
    left < HOUR
      ? t(cache.estimate ? 'card.minutesLeftAbout' : 'card.minutesLeft', { count: left / MINUTE })
      : t(cache.estimate ? 'card.timeLeftAbout' : 'card.timeLeft', { time: countdown(left) })
  return (
    <>
      {ending && <span aria-hidden className="size-2 rounded-full border-[1.5px] border-warning" />}
      {text}
    </>
  )
}

/** The session's model by the name its agent gives it, or as the agent names it when not known. */
function useModelName(summary: SessionSummary): string | null {
  return useAgentOptionsStore((s) => {
    if (!summary.model) return null
    const options = optionsOn(s, hostOfSession(summary))[summary.agentId]
    const option = options?.config.find((o) => o.category === 'model')
    const choice = option?.choices?.find((c) => c.value === summary.model)
    return choice?.name ?? summary.model
  })
}
