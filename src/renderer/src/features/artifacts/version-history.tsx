import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { VersionSummary } from '@shared/artifacts'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAuthor } from './use-versions'

/** The 300 px column at the viewer's right: every version, the one shown picked. */
export function VersionHistory({
  versions,
  error,
  shown,
  onPick,
  onClose,
}: {
  versions: VersionSummary[] | null
  error: string | null
  shown: number | null
  onPick: (version: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  const author = useAuthor()
  const head = versions?.[0]?.version ?? null
  return (
    <aside
      aria-label={t('history.title')}
      className="flex w-75 shrink-0 flex-col bg-sidebar shadow-[inset_var(--hairline)_0_0_var(--border-subtle)]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4">
        <h2 className="flex-1 text-ui font-medium">{t('history.title')}</h2>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label={t('history.close')}
                onClick={onClose}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipContent>{t('history.close')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {error && !versions && <p className="px-2.5 py-2 text-xs text-danger">{error}</p>}
        {!versions && !error && (
          <div aria-busy className="flex flex-col gap-3 px-2.5 py-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-3 w-20" />
          </div>
        )}
        {versions?.map((v) => {
          const on = v.version === (shown ?? head)
          return (
            <button
              key={v.version}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(v.version)}
              className={cn(
                'flex w-full min-w-0 flex-col items-stretch gap-0.5 rounded-lg px-2.5 py-2 text-left outline-none focus-ring',
                on ? 'bg-selected' : 'hover:bg-hover',
              )}
            >
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-ui font-medium whitespace-nowrap">
                  {t('history.version', { version: v.version })}
                </span>
                {v.version === head && (
                  <span className="text-xs whitespace-nowrap text-tertiary">
                    {t('history.latest')}
                  </span>
                )}
                <span className="flex-1" />
                <span className="text-meta whitespace-nowrap text-tertiary">
                  {longAgo(v.createdAt, now)}
                </span>
              </span>
              {v.note && <span className="truncate text-ui text-secondary">{v.note}</span>}
              <span className="truncate text-xs text-tertiary">{author(v.author)}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
