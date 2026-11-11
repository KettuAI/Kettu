import { useEffect, useState, type ReactNode } from 'react'
import { Cancel01Icon, DashboardSquare02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { ToolCallCard } from '@renderer/components/affect/tool-call-card'
import { PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import { agentName } from '@renderer/stores/agents'
import { artifactListShown, artifactStanding, useArtifactsStore } from '@renderer/stores/artifacts'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { toggleBoard } from '@renderer/stores/view'
import { ArtifactRow } from './artifact-row'
import { BackgroundRow } from './background-row'
import {
  backgroundOrder,
  boardSubagents,
  subagentWaiting,
  summaryParts,
  threadArtifacts,
  type BoardArtifact,
} from './board-model'
import { Group } from './row-parts'
import { NeedsStrip, SubagentRow } from './subagent-rows'
import { useBoardActivity } from './use-board-activity'
import './board.css'

type GroupKey = 'background' | 'subagents' | 'artifacts'

const NO_ARTIFACTS: BoardArtifact[] = []

/**
 * The session's board: what it runs and makes beside its thread, at the right of the thread and
 * the composer on the same sheet. The commands and monitors its agent left running, the
 * sub-agents it started and the artifacts it wrote, in three groups that fold, with the
 * sub-agents waiting for the user's answer above them.
 */
export default function BoardRail({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('board')
  const summary = useSessionsStore((s) => s.byId[sessionId])
  const loaded = useThreadsStore((s) => !!s.replicas[sessionId]?.state)
  const tasks = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.background)
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
  const [folded, setFolded] = useState<Partial<Record<GroupKey, true>>>({})

  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])

  const toggle = (key: GroupKey) =>
    setFolded((prev) => {
      const next = { ...prev }
      if (next[key]) delete next[key]
      else next[key] = true
      return next
    })

  const subagents = boardSubagents(children)
  const waiting = subagents.filter(subagentWaiting)
  const ordered = tasks ? backgroundOrder(tasks) : []
  const empty = ordered.length === 0 && subagents.length === 0 && artifacts.length === 0
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
        {waiting.map((child) => (
          <NeedsStrip key={child.id} child={child} />
        ))}
        {loaded && (
          <Group
            title={t('groups.background')}
            count={tasks ? ordered.length : undefined}
            folded={!!folded.background}
            onToggle={() => toggle('background')}
          >
            {!tasks ? (
              <p className="kb-note">{t('unsupported', { agent })}</p>
            ) : ordered.length === 0 ? (
              <p className="kb-note">{t('none.background')}</p>
            ) : (
              ordered.map((task) => (
                <BackgroundRow
                  key={task.id}
                  sessionId={sessionId}
                  task={task}
                  shown={!folded.background}
                />
              ))
            )}
          </Group>
        )}
        <Group
          title={t('groups.subagents')}
          count={subagents.length}
          folded={!!folded.subagents}
          onToggle={() => toggle('subagents')}
        >
          {subagents.length === 0 ? (
            <p className="kb-note">{t('none.subagents')}</p>
          ) : (
            subagents.map((child) => <SubagentRow key={child.id} child={child} />)
          )}
        </Group>
        <Group
          title={t('groups.artifacts')}
          count={artifacts.length}
          folded={!!folded.artifacts}
          onToggle={() => toggle('artifacts')}
        >
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
        </Group>
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
      <CardStyles />
    </aside>
  )
}

/**
 * The Tool Call Card adds its styles to the page when the first one renders, and a task's card
 * here uses them before the thread may have drawn one.
 */
function CardStyles() {
  return (
    <div hidden>
      <ToolCallCard name="" status="success" time={false}>
        {false}
      </ToolCallCard>
    </div>
  )
}
