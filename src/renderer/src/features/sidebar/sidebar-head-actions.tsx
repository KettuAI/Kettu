import { Activity01Icon, Search01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { TITLE_BUTTON } from '@renderer/features/shell/title-button'
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { showSearch, toggleSidebarActivity, useViewStore } from '@renderer/stores/view'
import { activityButtonTone, activitySummaryText, searchButtonLabel } from './activity-sessions'
import { useActivitySessions } from './use-activity-sessions'

/**
 * Compact search and Activity view buttons placed at the top of the sidebar, replacing the
 * full-width search bar so the project and session lists gain an extra row.
 */
export function SidebarHeadActions() {
  const { t } = useTranslation('sidebar')
  const searchOpen = useViewStore((s) => s.searchOpen)
  const activityOpen = useViewStore((s) => s.sidebarView === 'activity')
  const { counts } = useActivitySessions()

  const shortcut = formatShortcut('Mod+K')
  const searchName = t('nav.search')
  const searchAriaLabel = searchButtonLabel(searchName, shortcut)
  const activityName = t('nav.activity')
  const summary = activitySummaryText(t, counts)
  const tone = activityButtonTone(counts)
  const activityDescription = activityOpen
    ? summary
      ? `${summary}${t('activity.separator')}${t('nav.activityBack')}`
      : t('nav.activityBack')
    : (summary ?? undefined)

  return (
    <div className="kettu-side-head-actions">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-sidebar-search=""
              aria-label={searchAriaLabel}
              aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
              aria-haspopup="dialog"
              aria-expanded={searchOpen}
              onClick={() => showSearch(true)}
              className={TITLE_BUTTON}
            />
          }
        >
          <Icon icon={Search01Icon} size={16} />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="px-2.25 py-1.5">
          <span>
            {searchName} <span className="opacity-60">{shortcut}</span>
          </span>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-sidebar-activity=""
              data-active={activityOpen ? '' : undefined}
              aria-label={activityName}
              aria-pressed={activityOpen}
              aria-description={activityDescription}
              onClick={toggleSidebarActivity}
              className={TITLE_BUTTON}
            />
          }
        >
          <Icon icon={Activity01Icon} size={16} />
          {tone && (
            <span
              aria-hidden
              data-activity-dot={tone}
              className={cn(
                'pointer-events-none absolute top-1.25 right-1.25 size-1.5 rounded-full shadow-[0_0_0_1.5px_var(--bg-sidebar)]',
                tone === 'waiting' && 'bg-attention-dot',
                tone === 'running' && 'bg-(--thread-fox) motion-safe:animate-pulse',
                tone === 'background' && 'bg-(--muted)',
              )}
            />
          )}
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className={cn(
            'px-2.25 py-1.5',
            (summary || activityOpen) && 'flex-col items-start gap-0.5',
          )}
        >
          <span>{activityName}</span>
          {summary && <span className="opacity-60">{summary}</span>}
          {activityOpen && <span className="opacity-60">{t('nav.activityBack')}</span>}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
