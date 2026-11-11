import { useEffect, type ReactNode } from 'react'
import { Cancel01Icon, DashboardSquare02Icon, ShapesIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { harnessOf } from '@shared/agents'
import type { BackgroundTaskView } from '@shared/thread'
import { PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import { agentName } from '@renderer/stores/agents'
import { artifactListShown, artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { toggleBoard } from '@renderer/stores/view'
import { ArtifactRow } from './artifact-row'
import { BackgroundSection } from './background-section'
import { boardSubagents, summaryParts, threadArtifacts, type BoardArtifact } from './board-model'
import { Section } from './row-parts'
import { SubagentSection } from './subagent-section'
import { useBoardActivity } from './use-board-activity'
import './board.css'

const NO_ARTIFACTS: BoardArtifact[] = []
const NO_TASKS: BackgroundTaskView[] = []

/**
 * The session's board: what it runs and makes beside its thread, at the right of the thread and
 * the composer on the same sheet. The sub-agents it started, the commands and monitors its agent
 * left running and the artifacts it wrote, each in a section of its own.
 */
export default function BoardRail({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('board')
  const summary = useSessionsStore((s) => s.byId[sessionId])
  const loaded = useThreadsStore((s) => !!s.replicas[sessionId]?.state)
  const listed = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.background)
  // The host keeps the list only while the agent's process runs; a Claude Code session waiting
  // for its process has none yet, yet its agent does report them.
  const tasks =
    listed ?? (summary && harnessOf(summary.agentId) === 'claude-code' ? NO_TASKS : undefined)
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
  const empty = (tasks?.length ?? 0) === 0 && subagents.length === 0 && artifacts.length === 0
  const parts = summaryParts(t, activity)
  const agent = summary ? agentName(summary.agentId, hostOfSession(summary)) : ''

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
        {summary && <SubagentSection session={summary} subagents={subagents} />}
        {loaded && <BackgroundSection sessionId={sessionId} tasks={tasks} agent={agent} />}
        <Section icon={ShapesIcon} title={t('sections.artifacts')} count={artifacts.length}>
          {artifacts.length === 0 ? (
            <p className="kb-note">{t('none.artifacts')}</p>
          ) : (
            artifacts.map((artifact) => (
              <ArtifactRow
                key={artifact.artifactId}
                sessionId={sessionId}
                entryId={artifact.entryId}
                artifactId={artifact.artifactId}
              />
            ))
          )}
        </Section>
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
