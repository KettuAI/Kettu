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
      className="flex w-75 shrink-0 animate-in flex-col bg-app shadow-[inset_var(--hairline)_0_0_var(--border-subtle)] fade-in duration-(--duration-fast)"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4.5">
        <h2 className="flex-1 font-heading text-subheading font-medium">{t('history.title')}</h2>
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pt-0.5 pb-4">
        {error && !versions && <p className="px-2.5 py-2 text-xs text-danger">{error}</p>}
        {!versions && !error && (
          <div aria-busy className="flex flex-col gap-3 py-2 pl-8 pr-2.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-44" />
            <Skeleton className="h-3 w-20" />
          </div>
        )}
        {versions?.map((v, i) => {
          const on = v.version === (shown ?? head)
          return (
            <button
              key={v.version}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(v.version)}
              className={cn(
                // A timeline down the left, a dot on it for each version, the one shown filled.
                'relative flex w-full min-w-0 flex-col items-stretch gap-0.5 rounded-lg pt-2.25 pr-2.5 pb-2.75 pl-8 text-left outline-none transition-colors duration-(--duration-fast) focus-ring',
                'before:absolute before:left-3.75 before:w-(--hairline) before:bg-border',
                versions.length === 1
                  ? 'before:hidden'
                  : i === 0
                    ? 'before:top-4.25 before:bottom-0'
                    : i === versions.length - 1
                      ? 'before:top-0 before:h-4.25'
                      : 'before:inset-y-0',
                'after:absolute after:top-3.25 after:left-2.75 after:size-2.25 after:rounded-full',
                on
                  ? 'bg-selected after:bg-primary after:shadow-[0_0_0_3px_var(--bg-selected)]'
                  : 'after:bg-app after:shadow-[inset_0_0_0_1.5px_var(--border-strong)] hover:bg-hover',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-ui font-medium whitespace-nowrap">
                  {t('history.version', { version: v.version })}
                </span>
                {v.version === head && (
                  <span className="flex h-4.5 items-center rounded-full bg-subtle px-1.5 text-meta font-medium whitespace-nowrap text-secondary">
                    {t('history.latest')}
                  </span>
                )}
                <span className="ml-auto text-xs whitespace-nowrap text-tertiary tabular-nums">
                  {longAgo(v.createdAt, now)}
                </span>
              </span>
              {v.note && <span className="text-small leading-4.5 text-secondary">{v.note}</span>}
              <span className="truncate text-xs text-tertiary">{author(v.author)}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
