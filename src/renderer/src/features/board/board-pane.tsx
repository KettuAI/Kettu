import { useEffect, useMemo, type ReactNode } from 'react'
import {
  Cancel01Icon,
  ComputerTerminal01Icon,
  DashboardSquare02Icon,
  UserMultiple02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { BackgroundTaskView } from '@shared/thread'
import { subagentRunning, useSubagentDigests } from '@renderer/features/session/subagent/progress'
import { PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import { artifactListShown, artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { toggleBoard } from '@renderer/stores/view'
import { ArtifactRow } from './artifact-row'
import {
  backgroundOrder,
  boardSubagents,
  subagentFailed,
  summaryParts,
  threadArtifacts,
  type BoardArtifact,
} from './board-model'
import { EndedAgent, EndedGroup, EndedTask } from './earlier'
import { AgentLive, TaskLive } from './live-rows'
import { useBoardActivity } from './use-board-activity'
import './board.css'

const NO_ARTIFACTS: BoardArtifact[] = []
const NO_TASKS: BackgroundTaskView[] = []
// Past this many live rows, those that do not wait for the user keep one line.
const ROOMY = 6

/**
 * The session's board, at the right of its thread and composer on the same sheet. It answers
 * what the session has going: Now is one card of what is live, those waiting for the user first,
 * then sub-agents, then commands; Earlier counts what ended, a line a kind; Artifacts is what
 * the session wrote.
 */
export default function BoardRail({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('board')
  const tasks = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.background ?? NO_TASKS)
  const children = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (child) => child.parentId === sessionId && child.origin === 'subagent',
      ),
    ),
  )
  const written = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    return state ? threadArtifacts(state) : NO_ARTIFACTS
  })
  const artifacts = useArtifactsStore(
    useShallow((s) => written.filter((a) => artifactStanding(s, a.artifactId) === 'live')),
  )
  const activity = useBoardActivity(sessionId)

  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])

  const subagents = boardSubagents(children)
  const idKey = subagents.map((child) => child.id).join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key stands for the ids
  const ids = useMemo(() => subagents.map((child) => child.id), [idKey])
  const digests = useSubagentDigests(ids)

  const liveAgents = subagents.filter(subagentRunning)
  const endedAgents = subagents.filter((child) => !subagentRunning(child))
  const ordered = backgroundOrder(tasks)
  const liveTasks = ordered.filter((task) => task.status === 'running')
  const endedTasks = ordered.filter((task) => task.status !== 'running')
  const live = liveAgents.length + liveTasks.length
  const compact = live > ROOMY
  const empty = subagents.length === 0 && tasks.length === 0 && artifacts.length === 0
  const parts = summaryParts(t, activity)
  const failedFirst = <T,>(items: T[], failed: (item: T) => boolean) => [
    ...items.filter(failed),
    ...items.filter((item) => !failed(item)),
  ]

  let body: ReactNode
  if (empty) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={DashboardSquare02Icon} size={20} />}
        title={t('empty.title')}
        text={t('empty.text')}
      />
    )
  } else {
    body = (
      <div className="kb-scroll">
        {live > 0 && (
          <section aria-label={t('sections.now')}>
            <h3 className="kb-label">{t('sections.now')}</h3>
            <div className="kb-now">
              {liveAgents.map((child) => (
                <AgentLive
                  key={child.id}
                  child={child}
                  digest={digests[child.id]?.digest ?? null}
                  compact={compact}
                />
              ))}
              {liveTasks.map((task) => (
                <TaskLive key={task.id} sessionId={sessionId} task={task} compact={compact} />
              ))}
            </div>
          </section>
        )}
        {(endedAgents.length > 0 || endedTasks.length > 0) && (
          <section aria-label={t('sections.earlier')}>
            <h3 className="kb-label">{t('sections.earlier')}</h3>
            {endedAgents.length > 0 && (
              <EndedGroup
                // Opened by itself once nothing is live, when it is all there is to read.
                key={live === 0 ? 'idle' : 'busy'}
                icon={UserMultiple02Icon}
                name={t('earlier.subagents')}
                count={endedAgents.length}
                failed={endedAgents.filter(subagentFailed).length}
                open={live === 0}
              >
                {failedFirst(endedAgents, subagentFailed).map((child) => (
                  <EndedAgent
                    key={child.id}
                    child={child}
                    digest={digests[child.id]?.digest ?? null}
                  />
                ))}
              </EndedGroup>
            )}
            {endedTasks.length > 0 && (
              <EndedGroup
                icon={ComputerTerminal01Icon}
                name={t('earlier.commands')}
                count={endedTasks.length}
                failed={endedTasks.filter((task) => task.status === 'failed').length}
              >
                {failedFirst(endedTasks, (task) => task.status === 'failed').map((task) => (
                  <EndedTask key={task.id} sessionId={sessionId} task={task} />
                ))}
              </EndedGroup>
            )}
          </section>
        )}
        {artifacts.length > 0 && (
          <section aria-label={t('sections.artifacts')}>
            <h3 className="kb-label">{t('sections.artifacts')}</h3>
            {artifacts.map((artifact) => (
              <ArtifactRow
                key={artifact.artifactId}
                sessionId={sessionId}
                entryId={artifact.entryId}
                artifactId={artifact.artifactId}
              />
            ))}
          </section>
        )}
      </div>
    )
  }

  return (
    <aside className="kb-rail animate-in fade-in" aria-label={t('title')}>
      <div className="kb-head">
        <PaneIcon icon={DashboardSquare02Icon} size={15} />
        <span className="kb-head__title">{t('title')}</span>
        <span className="kb-head__sum" aria-live="polite">
          {parts.running === null && parts.needs === null ? (
            t('summary.idle')
          ) : (
            <>
              {parts.running}
              {parts.running !== null && parts.needs !== null && ' · '}
              {parts.needs !== null && <b className="kb-head__needs">{parts.needs}</b>}
            </>
          )}
        </span>
        <button
          type="button"
          className="kp-tool kb-head__close"
          aria-label={t('actions.close')}
          onClick={() => toggleBoard(sessionId, false)}
        >
          <PaneIcon icon={Cancel01Icon} size={15} />
        </button>
      </div>
      <div className="kb-body">{body}</div>
    </aside>
  )
}
