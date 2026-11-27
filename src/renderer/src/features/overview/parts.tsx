// What every view of the Overview page shares: a row's mark, its steps as tags and what it made
// as chips.

import { Fragment, type ReactNode } from 'react'
import {
  Cancel01Icon,
  ComputerIcon,
  File01Icon,
  GitPullRequestIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { sessionLinkProps } from '@renderer/features/session/open-link'
import { TurnDots } from '@renderer/features/session/turn-dots'
import { TaskRing } from '@renderer/features/tasks/task-ring'
import { runningFor, shortAgo } from '@renderer/lib/format'
import { useNow, useSeconds } from '@renderer/lib/use-now'
import { openArtifact } from '@renderer/stores/view'
import { rowSubParts, type OverviewRow, type OverviewStep, type StepLook } from './model'
import type { RowFacts, RowOutput } from './use-row-facts'

/** A task's ring or a session's agent. */
export function RowMark({ row, size = 16 }: { row: OverviewRow; size?: number }) {
  return row.kind === 'task' ? (
    <TaskRing task={row.task} size={size} />
  ) : (
    <AgentMark agent={row.node.summary.agentId} size={size} hostId={row.hostId} />
  )
}

/**
 * "habit-tracker · Feature development" + host pill ("dev-box").
 * Truncates the project folder first so the agent/workflow and host stay visible in narrow rows.
 */
export function RowSub({
  facts,
  project = true,
  extra = null,
  inline = false,
}: {
  facts: RowFacts
  project?: boolean
  extra?: string | null
  /** Renders as plain flowing text (e.g. Inbox detail pane) instead of single-line priority truncation. */
  inline?: boolean
}) {
  const { t } = useTranslation('overview')
  const separator = t('separator')
  const parts = rowSubParts(facts, { project, extra, separator })
  if (inline) return <>{parts.fullText}</>

  const lead: { kind: 'project' | 'by'; text: string }[] = []
  if (parts.project) lead.push({ kind: 'project', text: parts.project })
  if (parts.by) lead.push({ kind: 'by', text: parts.by })

  return (
    <span className="k-ov-sub" title={parts.fullText}>
      {(lead.length > 0 || parts.extra) && (
        <span className="k-ov-sub__meta">
          {lead.map((item, i) => (
            <Fragment key={item.kind}>
              {i > 0 && (
                <span aria-hidden className="k-ov-sub__sep">
                  {separator}
                </span>
              )}
              <span className={`k-ov-sub__${item.kind}`} title={item.text}>
                {item.text}
              </span>
            </Fragment>
          ))}
          {parts.extra && (
            <span className="k-ov-sub__extra" title={parts.extra}>
              {lead.length > 0 && <span aria-hidden>{separator}</span>}
              {parts.extra}
            </span>
          )}
        </span>
      )}
      {parts.host && (
        <span className="k-ov-sub__host" title={parts.host}>
          <Icon icon={ComputerIcon} size={11} />
          <span>{parts.host}</span>
        </span>
      )}
    </span>
  )
}

/** How long a running row has been at what it does, or how long ago the others changed. */
export function RowTime({ row, facts }: { row: OverviewRow; facts: RowFacts }) {
  return (
    <small className="k-ov-time">
      {row.state === 'running' ? <Running since={facts.since} /> : <Ago at={row.updatedAt} />}
    </small>
  )
}

// On the seconds clock, since the shared one is up to 30 s behind a turn that just started.
function Running({ since }: { since: number }) {
  return <>{runningFor(useSeconds() - since)}</>
}

function Ago({ at }: { at: number }) {
  return <>{shortAgo(at, useNow())}</>
}

export function StepMark({ look }: { look: StepLook }) {
  return (
    <i aria-hidden className="k-ov-sm" data-look={look}>
      {look === 'done' ? (
        <Icon icon={Tick02Icon} size={9} stroke={3.2} />
      ) : look === 'error' ? (
        <Icon icon={Cancel01Icon} size={8} stroke={3.2} />
      ) : look === 'running' ? (
        <TurnDots phase="working" className="size-2.5" />
      ) : null}
    </i>
  )
}

/** Every step as a tag on one line; only the step in front is filled and never cut. */
export function StepTags({ steps }: { steps: OverviewStep[] | null }) {
  const { t } = useTranslation('overview')
  if (!steps) return <span className="k-ov-noplan">{t('noPlan')}</span>
  return (
    <span className="k-ov-tags">
      {steps.map((step) => (
        <span key={step.id} data-look={step.look} title={step.name}>
          <StepMark look={step.look} />
          <em>{step.name}</em>
        </span>
      ))}
    </span>
  )
}

/** What a row made, as chips that open: its pull requests and its artifacts. */
export function Outputs({ outputs, max = 2 }: { outputs: RowOutput[]; max?: number }) {
  const { t } = useTranslation('overview')
  if (outputs.length === 0) return <span className="k-ov-outs k-ov-none">{t('nothingYet')}</span>
  const more = outputs.length - max
  return (
    <span className="k-ov-outs">
      {outputs.slice(0, max).map((output) => (
        <OutputChip key={output.kind === 'pr' ? output.url : output.id} output={output} />
      ))}
      {more > 0 && <span className="k-ov-more">{t('more', { count: more })}</span>}
    </span>
  )
}

export function OutputChip({ output, children }: { output: RowOutput; children?: ReactNode }) {
  if (output.kind === 'pr') {
    return (
      <a className="k-ov-out" data-kind="pr" {...sessionLinkProps(output.url, output.sessionId)}>
        <Icon icon={GitPullRequestIcon} size={12} />
        <b>#{output.number}</b>
        {children}
      </a>
    )
  }
  return (
    <button
      type="button"
      className="k-ov-out"
      data-kind="artifact"
      title={output.title}
      onClick={() => openArtifact(output.id)}
    >
      <Icon icon={File01Icon} size={12} />
      <b>{output.title}</b>
      {children}
    </button>
  )
}
