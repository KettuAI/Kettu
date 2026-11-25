import { Alert02Icon, CheckmarkCircle02Icon, GitBranchIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionOutputs, SessionSummary } from '@shared/agent-host'
import type { KnownExpiry } from '@shared/prompt-cache'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { useCacheLeft } from '@renderer/features/prompt-cache/cache-phase'
import { BackgroundDots, TurnDots } from '@renderer/features/session/turn-dots'
import { Glyph } from '@renderer/features/shell/glyph'
import { countdown, duration, longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { CardOutputs } from './card-outputs'
import { backgroundText, type RowStatus } from './row-status'
import type { SessionCache } from './session-cache'
import { useOutputs } from './use-outputs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * What a row's hover card says about its session: its whole title, which the row may cut short,
 * the agent and model, what the session made, and where it stands. `onOpen` runs when something
 * it made is opened from it.
 */
export function SessionCard({
  summary,
  cache,
  status,
  onOpen,
}: {
  summary: SessionSummary
  cache: SessionCache
  status: RowStatus
  onOpen?: () => void
}) {
  const model = useModelName(summary)
  const outputs = useOutputs(summary)
  const hostId = hostOfSession(summary)
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1 px-3.5 pt-3 pb-3">
        <p className="text-label font-semibold text-pretty wrap-anywhere text-primary">
          {sessionTitle(summary)}
        </p>
        <div className="flex min-w-0 items-center gap-1.5 text-hint text-tertiary">
          <AgentMark agent={summary.agentId} size={14} hostId={hostId} />
          <span className="min-w-0 truncate">
            {agentName(summary.agentId, hostId)}
            {model && <> · {model}</>}
          </span>
          {summary.branch && (
            <span className="flex min-w-0 items-center gap-1">
              <Glyph icon={GitBranchIcon} size={12} className="shrink-0 text-icon" />
              <span className="truncate font-mono text-code">{summary.branch}</span>
            </span>
          )}
        </div>
      </div>
      <CardOutputs summary={summary} outputs={outputs} onOpen={onOpen} />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-subtle px-3.5 py-2 text-hint text-tertiary">
        <State summary={summary} status={status} outputs={outputs} />
        {cache && <Cache cache={cache} />}
      </div>
    </div>
  )
}

/** Where the session stands, with the mark its row shows for it. */
function State({
  summary,
  status,
  outputs,
}: {
  summary: SessionSummary
  status: RowStatus
  outputs: SessionOutputs | null
}) {
  const { t } = useTranslation('sidebar')
  const now = useNow()
  if (status.waiting > 0) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="mx-0.5 size-2 shrink-0 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]" />
        <span className="truncate font-medium text-secondary">
          {t('indicator.waiting', { count: status.waiting })}
        </span>
      </span>
    )
  }
  if (status.background && !status.running) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <BackgroundDots />
        <span className="truncate tabular-nums">
          <span className="font-medium text-secondary">{t('card.background')}</span>{' '}
          {backgroundText(t, status.background)}
        </span>
      </span>
    )
  }
  if (status.running || status.starting) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <TurnDots phase={status.running ? 'working' : 'thinking'} />
        <span className="truncate font-medium text-secondary">
          {t(status.running ? 'indicator.running' : 'indicator.starting')}
        </span>
      </span>
    )
  }
  const failed = status.failed
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Glyph
        icon={failed ? Alert02Icon : CheckmarkCircle02Icon}
        size={13}
        className={failed ? 'shrink-0 text-danger' : 'shrink-0 text-success'}
      />
      <span className="truncate tabular-nums">
        <span className="font-medium text-secondary">
          {t(failed ? 'indicator.error' : 'card.done')}
        </span>{' '}
        {longAgo(summary.updatedAt, now)}
        {!failed && outputs?.turnMs != null && (
          <> · {t('card.took', { time: duration(outputs.turnMs) })}</>
        )}
      </span>
    </span>
  )
}

function Cache({ cache }: { cache: NonNullable<SessionCache> }) {
  const { t } = useTranslation('sidebar')
  return (
    <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
      <span>{t('card.cache')}</span>
      <span className="text-secondary">
        {cache.state === 'none' ? (
          t('card.cacheNone')
        ) : cache.state === 'expired' ? (
          t(cache.cache.estimate ? 'card.cacheLikelyExpired' : 'card.cacheExpired')
        ) : (
          <CacheLeft cache={cache.cache} ending={cache.state === 'ending'} />
        )}
      </span>
    </span>
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
    <span className="inline-flex items-center gap-1.5">
      {ending && <span aria-hidden className="size-2 rounded-full border-[1.5px] border-warning" />}
      {text}
    </span>
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
