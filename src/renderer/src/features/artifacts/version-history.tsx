import { useTranslation } from 'react-i18next'
import type { VersionSummary } from '@shared/artifacts'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useAuthor } from './use-versions'

/**
 * The 280 px column at the viewer's right: every version, newest first, by its note or else its
 * author, with the author's agent and when it was made; the one shown is raised.
 */
export function VersionHistory({
  versions,
  error,
  shown,
  onPick,
  header,
}: {
  versions: VersionSummary[] | null
  error: string | null
  shown: number | null
  onPick: (version: number) => void
  /** In place of the title, such as the tabs of the viewer's column. */
  header?: React.ReactNode
}) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  const author = useAuthor()
  const sessions = useSessionsStore((s) => s.byId)
  const head = versions?.[0]?.version ?? null
  return (
    <aside
      aria-label={t('history.title')}
      className="flex w-70 shrink-0 animate-in flex-col bg-app shadow-[inset_1px_0_0_var(--border-subtle)] fade-in duration-(--duration-fast)"
    >
      {header ?? (
        <h2 className="flex h-11 shrink-0 items-center px-4 text-lede font-semibold">
          {t('history.title')}
        </h2>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4">
        {error && !versions && <p className="px-2.5 py-2 text-xs text-danger">{error}</p>}
        {!versions && !error && (
          <div aria-busy className="flex flex-col gap-3 px-2.5 py-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
        )}
        {versions?.map((v) => {
          const on = v.version === (shown ?? head)
          const agent = v.author === null ? null : (sessions[v.author]?.agentId ?? null)
          return (
            <button
              key={v.version}
              type="button"
              aria-pressed={on}
              title={author(v.author)}
              onClick={() => onPick(v.version)}
              className={cn(
                'flex w-full min-w-0 gap-2.5 rounded-xl p-2.5 text-left outline-none transition-colors duration-(--duration-fast) focus-ring',
                on ? 'bg-segment-thumb shadow-segment' : 'hover:bg-hover',
              )}
            >
              <span className="w-6.5 shrink-0 pt-px text-small font-semibold text-tertiary tabular-nums">
                {t('viewer.version', { version: v.version })}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.75">
                <span
                  className={cn(
                    'text-menu leading-[normal] text-primary',
                    on ? 'font-medium' : 'font-normal',
                  )}
                >
                  {v.note ?? author(v.author)}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-small leading-[normal] text-tertiary">
                  {agent && <AgentMark agent={agent} size={12} className="shrink-0" />}
                  <span className="truncate">{longAgo(v.createdAt, now)}</span>
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
