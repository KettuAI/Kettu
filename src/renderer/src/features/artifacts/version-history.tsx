import { useTranslation } from 'react-i18next'
import type { VersionSummary } from '@shared/artifacts'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { SettingsStyles } from '@renderer/features/routines/kit'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useAuthor } from './use-versions'

/**
 * The column at the viewer's right: every version, newest first, by its note or else its author,
 * with the author's agent and when it was made, in one card; the one shown is picked.
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
    <aside aria-label={t('history.title')} className="k-av-side">
      <SettingsStyles />
      {header ?? (
        <div className="k-av-side__head">
          <h2 className="k-av-side__title">{t('history.title')}</h2>
        </div>
      )}
      <div className="k-av-side__body">
        {error && !versions && <p className="k-av-error">{error}</p>}
        {!versions && !error && (
          <div aria-busy className="k-av-side__wait">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
        )}
        {versions && versions.length > 0 && (
          <div className="ui-sg-card ui-sg-card--pad k-av-versions">
            {versions.map((v) => {
              const on = v.version === (shown ?? head)
              const agent = v.author === null ? null : (sessions[v.author]?.agentId ?? null)
              return (
                <button
                  key={v.version}
                  type="button"
                  aria-pressed={on}
                  title={author(v.author)}
                  onClick={() => onPick(v.version)}
                  className="k-av-ver"
                >
                  <span className="k-av-ver__num">
                    {t('viewer.version', { version: v.version })}
                  </span>
                  <span className="k-av-ver__text">
                    <b>{v.note ?? author(v.author)}</b>
                    <small>
                      {agent && <AgentMark agent={agent} size={12} />}
                      <span>{longAgo(v.createdAt, now)}</span>
                    </small>
                  </span>
                  {v.version === head && (
                    <span className="k-av-ver__tag">{t('history.latest')}</span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
