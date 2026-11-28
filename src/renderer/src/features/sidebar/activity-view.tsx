import { useMemo } from 'react'
import { Activity01Icon } from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Glyph } from '@renderer/features/shell/glyph'
import { setSidebarView, useViewStore } from '@renderer/stores/view'
import { activityContextText, type ActivitySession } from './activity-sessions'
import { useHostLabel } from './host-label'
import { GroupRenameHints } from './rename-hints'
import { RenameScope } from './rename-scope'
import { SessionRow } from './session-row'
import { useActivitySessions } from './use-activity-sessions'

const ACTIVITY_WAITING_GROUP = 'activity:waiting'
const ACTIVITY_RUNNING_GROUP = 'activity:running'

/**
 * Focused sidebar list showing non-archived sessions that need attention or are actively running,
 * ordered with waiting approvals/replies pinned above running and background sessions.
 */
export function ActivityView() {
  const { t } = useTranslation('sidebar')
  const { items, showHost } = useActivitySessions()
  const shownId = useViewStore((s) =>
    s.main.kind === 'session' && !s.settings.open ? s.main.sessionId : null,
  )

  const waiting = useMemo(() => items.filter((item) => item.bucket === 'waiting'), [items])
  const running = useMemo(() => items.filter((item) => item.bucket !== 'waiting'), [items])

  const tabStopId = useMemo(() => {
    if (items.length === 0) return null
    if (shownId && items.some((item) => item.node.summary.id === shownId)) return shownId
    return items[0]!.node.summary.id
  }, [items, shownId])

  return (
    <section
      aria-label={t('activity.title')}
      data-sidebar-activity-view=""
      className="ui-as-side__group kettu-activity-view"
    >
      <div className="ui-as-side__label kettu-activity-head">
        <span className="kettu-activity-head__title">
          <span>{t('activity.title')}</span>
          {items.length > 0 && <span className="tabular-nums">{items.length}</span>}
        </span>
        <button
          type="button"
          onClick={() => setSidebarView('projects')}
          className="kettu-activity-head__back"
        >
          {t('nav.projects')}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="kettu-activity-empty" data-activity-empty="">
          <span className="kettu-activity-empty__icon" aria-hidden>
            <Glyph icon={Activity01Icon} size={18} />
          </span>
          <p className="kettu-activity-empty__title">{t('activity.emptyTitle')}</p>
          <p className="kettu-activity-empty__body">{t('activity.emptyBody')}</p>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setSidebarView('projects')}
            className="mt-1"
          >
            {t('activity.backToProjects')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {waiting.length > 0 && (
            <ActivitySection
              scope={ACTIVITY_WAITING_GROUP}
              label={t('activity.waiting')}
              items={waiting}
              tabStopId={tabStopId}
              showHost={showHost}
            />
          )}
          {running.length > 0 && (
            <ActivitySection
              scope={ACTIVITY_RUNNING_GROUP}
              label={t('activity.running')}
              items={running}
              tabStopId={tabStopId}
              showHost={showHost}
            />
          )}
        </div>
      )}
    </section>
  )
}

function ActivitySection({
  scope,
  label,
  items,
  tabStopId,
  showHost,
}: {
  scope: string
  label: string
  items: readonly ActivitySession[]
  tabStopId: string | null
  showHost: boolean
}) {
  return (
    <div role="group" aria-label={label} className="kettu-activity-section">
      <div className="kettu-activity-section__label">
        <span>{label}</span>
        <span className="tabular-nums">{items.length}</span>
      </div>
      <ul className="flex flex-col">
        <RenameScope value={scope}>
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <ActivitySessionItem
                key={item.node.summary.id}
                item={item}
                tabStopId={tabStopId}
                showHost={showHost}
              />
            ))}
          </AnimatePresence>
        </RenameScope>
        <GroupRenameHints scope={scope} />
      </ul>
    </div>
  )
}

function ActivitySessionItem({
  item,
  tabStopId,
  showHost,
}: {
  item: ActivitySession
  tabStopId: string | null
  showHost: boolean
}) {
  const { t } = useTranslation('sidebar')
  const hostName = useHostLabel(item.hostId)
  const context = activityContextText(item, {
    noProjectLabel: t('project.noProject'),
    hostName,
    showHost,
    separator: t('activity.separator'),
  })
  return <SessionRow node={item.node} tabStopId={tabStopId} context={context} />
}
