import { useState, type ReactNode } from 'react'
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { agentName } from '@renderer/stores/agents'
import { sessionTitle, type SessionNode } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { rowSubParts, rowTooltip, type OverviewRow } from './model'
import { Outputs, RowMark, RowSub, RowTime, StepTags } from './parts'
import { useRowFacts } from './use-row-facts'

/** Every row with its steps by name, the one in front filled, then what it does and what it made. */
export function FlowTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation('overview')
  return (
    <div className="ui-sg-card k-ov-table">
      <div aria-hidden className="k-ov-tr k-ov-th">
        <span />
        <span />
        <span>{t('columns.name')}</span>
        <span>{t('columns.steps')}</span>
        <span>{t('columns.now')}</span>
        <span>{t('columns.output')}</span>
        <span />
      </div>
      {children}
    </div>
  )
}

export function FlowRow({ row, project }: { row: OverviewRow; project: boolean }) {
  const { t } = useTranslation('overview')
  const facts = useRowFacts(row)
  const [open, setOpen] = useState(false)
  const kids = row.kind === 'session' ? row.node.children : []
  const extra = kids.length > 0 ? t('subSessions', { count: kids.length }) : null
  const { fullText } = rowSubParts(facts, { project, extra, separator: t('separator') })
  return (
    <>
      <div className="k-ov-tr" data-state={row.state}>
        <button
          type="button"
          className="k-ov-open"
          aria-label={facts.title}
          title={rowTooltip(facts.title, fullText)}
          onClick={facts.open}
        />
        <span className="k-ov-chev">
          {kids.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={t(open ? 'collapse' : 'expand')}
              onClick={() => setOpen(!open)}
            >
              <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
            </button>
          )}
        </span>
        <span className="k-ov-mark">
          <RowMark row={row} />
        </span>
        <span className="k-ov-name">
          <b>{facts.title}</b>
          <small>
            <RowSub facts={facts} project={project} extra={extra} />
          </small>
        </span>
        <StepTags steps={facts.steps} />
        <span className="k-ov-now" data-state={row.state}>
          {facts.now}
        </span>
        <Outputs outputs={facts.outputs} />
        <span className="k-ov-end">
          <RowTime row={row} facts={facts} />
        </span>
      </div>
      {open &&
        kids.map((kid, i) => (
          <KidRow
            key={kid.summary.id}
            node={kid}
            hostId={row.hostId}
            last={i === kids.length - 1}
          />
        ))}
    </>
  )
}

/** A sub-session under its session: its agent, its title and its state in a word. */
function KidRow({
  node,
  hostId,
  last,
}: {
  node: SessionNode
  hostId: string | null
  last: boolean
}) {
  const { t } = useTranslation('overview')
  const { summary } = node
  const state =
    node.permissionCount > 0
      ? 'you'
      : summary.attention === 'error' || summary.status === 'failed'
        ? 'stopped'
        : node.running
          ? 'running'
          : null
  return (
    <div className="k-ov-tr k-ov-kid" data-last={last || undefined}>
      <button
        type="button"
        className="k-ov-open"
        aria-label={sessionTitle(summary)}
        onClick={() => openSession(summary.id, summary.projectPath)}
      />
      <span />
      <span aria-hidden className="k-ov-branch" />
      <span className="k-ov-name">
        <b>
          <AgentMark agent={summary.agentId} size={13} hostId={hostId} />
          <span>{sessionTitle(summary)}</span>
        </b>
        <small>{agentName(summary.agentId, hostId)}</small>
      </span>
      <span className="k-ov-kidnow" data-state={state ?? undefined}>
        {state === 'running' && <TurnDots phase="working" />}
        {state ? t(`states.${state}`) : t('idle')}
      </span>
    </div>
  )
}
