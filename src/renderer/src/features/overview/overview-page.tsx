// The Overview page: the tasks and sessions that are ready to take, need an answer, run or
// stopped, over one set of rows in three views to switch between.

import type { ReactNode } from 'react'
import { useState } from 'react'
import { Calendar03Icon, InboxIcon, WorkflowSquare03Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { EmptyState, Icon } from '@renderer/components/affect/app-shell'
import { SegmentedControl } from '@renderer/components/segmented-control'
import { SettingsStyles } from '@renderer/features/routines/kit'
import { basename } from '@renderer/lib/format'
import { hostPath } from '@renderer/lib/host-paths'
import { useSessionsStore } from '@renderer/stores/sessions'
import { FlowRow, FlowTable } from './flow-view'
import { InboxView } from './inbox-view'
import { countByState, STATES, type OverviewRow, type OverviewState } from './model'
import { TimelineRow, TimelineTable } from './timeline-view'
import {
  useOverviewPrefs,
  useOverviewRows,
  useTaskViews,
  type GroupBy,
  type OverviewView,
  type StateFilter,
} from './use-overview'
import './overview.css'

const VIEW_ICON = { inbox: InboxIcon, flow: WorkflowSquare03Icon, timeline: Calendar03Icon }
const VIEWS: readonly OverviewView[] = ['inbox', 'flow', 'timeline']

export default function OverviewPage() {
  const { t } = useTranslation('overview')
  const loaded = useSessionsStore((s) => s.loaded)
  const rows = useOverviewRows()
  const [prefs, setPrefs] = useOverviewPrefs()
  const [filter, setFilter] = useState<StateFilter>('all')
  useTaskViews(rows)
  const counts = countByState(rows)
  const shown = filter === 'all' ? rows : rows.filter((row) => row.state === filter)
  const table = prefs.view !== 'inbox'

  return (
    <div className="k-scroll">
      <SettingsStyles />
      <div aria-hidden className="k-drag app-region-drag" />
      <div className="ui-as-page k-ov" data-view={prefs.view}>
        <header className="k-ov__head">
          <span>
            <h1 className="ui-as-page-title">{t('title')}</h1>
            <p className="ui-as-page-sub">{t('description', { count: rows.length })}</p>
          </span>
          <span className="k-ov__tools app-region-no-drag">
            {prefs.view === 'flow' && (
              <SegmentedControl<GroupBy>
                aria-label={t('groupBy.label')}
                value={prefs.groupBy}
                onChange={(groupBy) => setPrefs({ groupBy })}
                segments={[
                  { value: 'state', label: t('groupBy.state') },
                  { value: 'project', label: t('groupBy.project') },
                ]}
              />
            )}
            <SegmentedControl<OverviewView>
              aria-label={t('views.label')}
              value={prefs.view}
              onChange={(view) => setPrefs({ view })}
              segments={VIEWS.map((view) => ({
                value: view,
                label: (
                  <span className="k-ov-view">
                    <Icon icon={VIEW_ICON[view]} size={14} />
                    {t(`views.${view}`)}
                  </span>
                ),
              }))}
            />
          </span>
        </header>

        {!loaded ? null : rows.length === 0 ? (
          <div className="k-ov-empty">
            <EmptyState bare tall title={t('empty.title')} text={t('empty.text')} />
          </div>
        ) : (
          <>
            {table && (
              <div className="k-ov-counts" role="tablist" aria-label={t('filter.label')}>
                {STATES.map((state) => (
                  <button
                    key={state}
                    type="button"
                    role="tab"
                    aria-selected={filter === state}
                    data-state={state}
                    onClick={() => setFilter(filter === state ? 'all' : state)}
                  >
                    <b>{counts[state]}</b>
                    <span>{t(`states.${state}`)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'all'}
                  data-state="all"
                  onClick={() => setFilter('all')}
                >
                  <b>{rows.length}</b>
                  <span>{t('filter.all')}</span>
                </button>
              </div>
            )}
            {prefs.view === 'inbox' ? (
              <InboxView rows={rows} />
            ) : prefs.view === 'flow' ? (
              <FlowTable>
                <Groups rows={shown} by={prefs.groupBy}>
                  {(row, project) => <FlowRow key={row.key} row={row} project={project} />}
                </Groups>
              </FlowTable>
            ) : (
              <TimelineTable>
                <Groups rows={shown} by="state">
                  {(row, project) => <TimelineRow key={row.key} row={row} project={project} />}
                </Groups>
              </TimelineTable>
            )}
            {table && shown.length === 0 && <p className="k-ov-clear">{t('filter.none')}</p>}
          </>
        )}
      </div>
    </div>
  )
}

/** The rows under their state's head, or under their project's with its states counted. */
function Groups({
  rows,
  by,
  children,
}: {
  rows: OverviewRow[]
  by: GroupBy
  children: (row: OverviewRow, project: boolean) => ReactNode
}) {
  const { t } = useTranslation('overview')
  const { t: ts } = useTranslation('sidebar')
  if (by === 'state') {
    return STATES.map((state) => {
      const list = rows.filter((row) => row.state === state)
      if (list.length === 0) return null
      return (
        <section key={state} aria-label={t(`states.${state}`)}>
          <h2 className="k-ov-gh" data-state={state}>
            <i />
            <b>{t(`states.${state}`)}</b>
            <span>{list.length}</span>
            <small>{t(`stateNotes.${state}`)}</small>
          </h2>
          {list.map((row) => children(row, true))}
        </section>
      )
    })
  }
  const projects = new Map<string, OverviewRow[]>()
  for (const row of rows) {
    const scratch = row.kind === 'session' && row.node.summary.scratch
    const key = scratch ? '' : row.projectPath
    projects.set(key, [...(projects.get(key) ?? []), row])
  }
  return [...projects].map(([path, list]) => {
    const name = path === '' ? ts('project.noProject') : basename(hostPath(path))
    const counts = countByState(list)
    return (
      <section key={path} aria-label={name}>
        <h2 className="k-ov-gh">
          <b>{name}</b>
          <span className="k-ov-roll">
            {STATES.filter((state) => counts[state] > 0).map((state: OverviewState) => (
              <span key={state} data-state={state}>
                <i />
                {counts[state]} {t(`states.${state}`).toLowerCase()}
              </span>
            ))}
          </span>
        </h2>
        {list.map((row) => children(row, false))}
      </section>
    )
  })
}
