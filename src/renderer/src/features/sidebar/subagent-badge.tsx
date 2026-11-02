import { BotIcon, CheckIcon, CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { revealSubagent } from '@renderer/features/session/reveal-subagent'
import { subagentRunning, useSubagentProgress } from '@renderer/features/session/subagent/progress'
import { duration } from '@renderer/lib/format'
import { sessionTitle } from '@renderer/stores/sessions'
import { setShowFinishedSubagents, useViewStore } from '@renderer/stores/view'
import { SessionMenuItems } from './session-menu'
import { runSessionMenuAccelerator } from './session-menu-model'
import { listedSubagents } from './subagents'

const nothing = () => {}

/**
 * A session's sub-agents on its row: a count with a spinner while any runs, and on hover the list,
 * each jumping to its block in the session's thread. Finished ones show only when chosen.
 */
export function SubagentBadge({
  parent,
  subagents,
  onEnter,
}: {
  parent: SessionSummary
  subagents: SessionSummary[]
  /** The pointer came onto the badge, whose list takes the place of the row's own card. */
  onEnter: () => void
}) {
  const { t } = useTranslation('sidebar')
  const showFinished = useViewStore((s) => s.showFinishedSubagents)
  const listed = listedSubagents(subagents, showFinished)
  if (listed.length === 0) return null
  const running = listed.filter(subagentRunning).length
  const count = running || listed.length
  const label = running
    ? t('subagents.running', { count: running })
    : t('subagents.count', { count: listed.length })

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={300}
        closeDelay={200}
        aria-label={label}
        onPointerEnter={onEnter}
        render={
          // As an image, its label goes into the name of the row's button around it.
          <span
            role="img"
            data-subagent-badge=""
            className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-subtle pr-[5px] pl-1 text-[11px] font-medium text-secondary tabular-nums shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] hover:bg-selected data-popup-open:bg-selected"
          />
        }
      >
        <BotIcon aria-hidden strokeWidth={1.4} className="size-[11px]! text-tertiary" />
        {count}
        {running > 0 && <RingSpinner aria-hidden className="size-[9px] border-[1.25px]" />}
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="center" sideOffset={12} className="w-[300px] p-[5px]">
        <div className="flex items-center px-2 pt-1.5 pb-1">
          <span className="flex-1 text-small font-medium text-tertiary">
            {t('subagents.title')}
          </span>
          {running > 0 && (
            <span className="text-caption text-tertiary tabular-nums">
              {t('subagents.runningShort', { count: running })}
            </span>
          )}
        </div>
        <ul className="flex flex-col">
          {listed.map((child) => (
            <li key={child.id}>
              <SubagentItem parent={parent} child={child} />
            </li>
          ))}
        </ul>
        <div role="separator" className="mx-[3px] my-[5px] h-px bg-(--border-subtle)" />
        <label className="flex h-[30px] items-center gap-[9px] rounded-tile px-2 text-[13.5px] text-primary">
          <span className="min-w-0 flex-1 truncate">{t('subagents.showFinished')}</span>
          <Switch size="sm" checked={showFinished} onCheckedChange={setShowFinishedSubagents} />
        </label>
      </HoverCardContent>
    </HoverCard>
  )
}

function SubagentItem({ parent, child }: { parent: SessionSummary; child: SessionSummary }) {
  const { t } = useTranslation('sidebar')
  const progress = useSubagentProgress(child)
  const running = subagentRunning(child)
  const waiting = child.permissionCount > 0
  const failed = child.attention === 'error' || child.status === 'failed'
  const elapsed = progress.elapsedMs === null ? null : duration(progress.elapsedMs)
  const meta = running
    ? [progress.tools === null ? null : t('subagents.tools', { count: progress.tools }), elapsed]
    : [t(failed ? 'subagents.failed' : 'subagents.done'), elapsed]

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={() => revealSubagent(parent.id, child.id)}
            className="flex min-h-10 w-full items-center gap-[9px] rounded-lg px-2 py-[5px] text-left outline-none hover:bg-selected focus-ring data-popup-open:bg-selected"
          />
        }
      >
        <span className="grid size-[22px] shrink-0 place-items-center rounded-tile bg-subtle text-secondary">
          <BotIcon aria-hidden strokeWidth={1.4} className="size-[13px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
          <span className="truncate text-[13px] text-primary">
            {sessionTitle(child)}
            {child.description && <span className="text-tertiary"> · {child.description}</span>}
          </span>
          <span className="truncate text-caption text-tertiary tabular-nums">
            {meta.filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="grid w-4 shrink-0 place-items-center">
          {waiting ? (
            <span
              role="img"
              aria-label={t('indicator.waiting', { count: child.permissionCount })}
              className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
            />
          ) : failed ? (
            <CircleAlertIcon
              role="img"
              aria-label={t('indicator.error')}
              className="size-3.5 text-danger"
            />
          ) : running ? (
            <RingSpinner
              aria-label={t('indicator.running')}
              className="size-[11.5px] border-[1.6px]"
            />
          ) : (
            <CheckIcon
              role="img"
              aria-label={t('subagents.done')}
              strokeWidth={1.9}
              className="size-3 text-success"
            />
          )}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent onKeyDown={runSessionMenuAccelerator}>
        <SessionMenuItems
          summary={child}
          onRename={nothing}
          onNewSubSession={nothing}
          onDelete={nothing}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}
