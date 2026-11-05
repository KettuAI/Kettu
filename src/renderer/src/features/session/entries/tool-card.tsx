import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  CopyIcon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AnsweredQuestion, ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { toolMedia } from '../media/named'
import { useEntry, useEntryAnimation } from '../use-thread'
import { ElicitationCard, ElicitationSettled } from './elicitation-card'
import { commandOutput, PANEL, toolLabel } from './helpers'
import { PermissionAnswer, PermissionCard } from './permission-card'
import { PlanCard, PlanSettled } from './plan-card'
import { AnsweredQuestions, QuestionCard } from './question-card'
import { entryPictures, type RowPicture } from './row-pictures'
import { ThumbRow } from './row-thumbs'
import { ShellBlock } from './shell-block'
import { ContentBlock, Target, ToolMedia } from './tool-parts'
import { useDiffStats } from './use-diff-stats'

export interface ToolCardProps {
  sessionId: string
  entryId: string
  projectPath: string
  agentName: string
}

/**
 * A tool call as a quiet row: its icon, what it did and its status, with its details below when
 * opened. Only a request for permission is framed, since it waits for an answer.
 */
export const ToolCard = memo(function ToolCard({
  sessionId,
  entryId,
  projectPath,
  agentName,
}: ToolCardProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'tool')
  const animation = useEntryAnimation(sessionId, entryId)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const permission = entry?.permission ?? null
  const media = useMemo(() => (entry ? toolMedia(entry) : []), [entry])
  const pictures = useMemo(() => (entry ? entryPictures(entry) : []), [entry])

  useEffect(() => {
    if (permission) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [permission])

  if (!entry) return null
  if (permission) {
    // Each request gets a card of its own, so an agent's next question in the same entry starts
    // unanswered rather than inheriting the last one's pending answer.
    const props = {
      ref,
      sessionId,
      entry,
      agentName,
      className: animation,
    }
    if (permission.plan) return <PlanCard key={permission.requestId} {...props} />
    if (permission.elicitation) return <ElicitationCard key={permission.requestId} {...props} />
    if (permission.questions) return <QuestionCard key={permission.requestId} {...props} />
    return (
      <PermissionCard
        key={permission.requestId}
        {...props}
        projectPath={projectPath}
        media={media}
      />
    )
  }
  if (entry.planVersion !== undefined) {
    return (
      <div ref={ref} className={cn('min-w-0', animation)}>
        <PlanSettled entry={entry} />
      </div>
    )
  }
  if (entry.elicitation) {
    return (
      <div ref={ref} className={cn('min-w-0', animation)}>
        <ElicitationSettled entry={entry} />
      </div>
    )
  }
  const result = entry.permissionResult
  if (typeof result === 'object' && result?.questions) {
    return (
      <div ref={ref} data-entry-id={entryId} className={cn('min-w-0', animation)}>
        <AnsweredAsk questions={result.questions} device={result.device?.name ?? null} />
      </div>
    )
  }
  const label = toolLabel(entry, projectPath, entry.status === 'completed')
  const command = label.kind === 'command' ? label.target : null
  // A command's output shows under it, in the same block, as a terminal prints it.
  const output = command ? commandOutput(entry.content) : null
  const content = output === null ? entry.content : entry.content.slice(1)
  const hasBody =
    entry.content.length > 0 ||
    media.length > 0 ||
    (!!command && (command.length > 60 || command.includes('\n')))
  const autoOpen =
    hasBody &&
    (entry.status === 'pending' || entry.status === 'in_progress' || entry.status === 'failed')
  const open = hasBody && (userOpen ?? autoOpen)

  const card = (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      render={<div ref={ref} data-entry-id={entryId} className={cn('min-w-0', animation)} />}
    >
      <ToolHeader
        sessionId={sessionId}
        entry={entry}
        label={label}
        toggle={hasBody}
        open={open}
        pictures={pictures}
      />
      {hasBody && (
        <CollapsibleContent className={PANEL} keepMounted={false}>
          <div className="flex flex-col gap-1.5 pt-1.5 pb-0.5 pl-5.5">
            {command && (
              <ShellBlock
                sessionId={sessionId}
                projectPath={projectPath}
                command={command}
                output={output}
                status={entry.status}
              />
            )}
            {content.map((c, i) => (
              <ContentBlock
                key={i}
                sessionId={sessionId}
                entryId={entryId}
                index={output === null ? i : i + 1}
                content={c}
                projectPath={projectPath}
              />
            ))}
            <ToolMedia sessionId={sessionId} entryId={entryId} media={media} />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )

  if (entry.toolKind !== 'execute' || !command) return card
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => emitAppEvent({ kind: 'run-in-terminal', panel: sessionId, command })}
        >
          <SquareTerminalIcon />
          {t('tool.runInTerminal')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(command)}>
          <CopyIcon />
          {t('tool.copyCommand')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function ToolHeader({
  sessionId,
  entry,
  label,
  toggle,
  open,
  pictures,
}: {
  sessionId: string
  entry: ToolEntry
  label: ReturnType<typeof toolLabel>
  toggle: boolean
  open: boolean
  pictures: readonly RowPicture[]
}) {
  const stats = useDiffStats(entry.content)
  const content = (
    <>
      {/* A row leads with its disclosure chevron, as the reply's other steps do. */}
      <span className="flex size-3 shrink-0 items-center justify-center text-tertiary">
        {toggle && (
          <ChevronRightIcon
            aria-hidden
            strokeWidth={1.75}
            className={cn(
              'size-3 transition-[rotate] duration-(--duration-fast) motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {label.verb && <span className="shrink-0 font-medium text-secondary">{label.verb}</span>}
        {label.target && <Target label={label} />}
      </span>
      {stats && (stats.insertions > 0 || stats.deletions > 0) && (
        <span className="flex shrink-0 animate-in gap-2 font-mono text-xs tabular animation-duration-(--duration-base) fade-in">
          <span className="text-success">+{stats.insertions}</span>
          <span className="text-danger">−{stats.deletions}</span>
        </span>
      )}
      {entry.permissionResult && (
        <PermissionAnswer result={entry.permissionResult} question={entry.question !== undefined} />
      )}
      <ToolStatus entry={entry} />
    </>
  )
  // A flat row reaches past the column by its padding, so its icon lines up with the prose.
  const row = '-mx-1.5 h-7 w-[calc(100%+0.75rem)] min-w-0'
  const look =
    'group/tool flex items-center gap-2 rounded-tile px-1.5 text-left text-control text-tertiary outline-none'
  if (!toggle) return <div className={cn(row, look)}>{content}</div>
  return (
    <ThumbRow sessionId={sessionId} pictures={pictures} open={open} className={row}>
      <CollapsibleTrigger className={cn(look, 'min-w-0 grow cursor-default focus-ring')}>
        {content}
      </CollapsibleTrigger>
    </ThumbRow>
  )
}

function ToolStatus({ entry }: { entry: ToolEntry }) {
  const { t } = useTranslation('session')
  const icon = 'size-3.5 shrink-0 animate-in fade-in animation-duration-(--duration-fast)'
  switch (entry.status) {
    case 'pending':
      return (
        <CircleIcon
          key="pending"
          role="img"
          aria-label={t('status.pending')}
          className={cn(icon, 'text-disabled')}
        />
      )
    case 'in_progress':
      return (
        <Spinner key="running" aria-label={t('status.running')} className={cn(icon, 'text-info')} />
      )
    // A finished step shows nothing: the past-tense verb says it is done.
    case 'completed':
      return null
    case 'failed':
      return (
        <XIcon
          key="failed"
          role="img"
          aria-label={t('status.failed')}
          className={cn(icon, 'text-danger')}
        />
      )
    case 'cancelled':
      return (
        <BanIcon
          key="cancelled"
          role="img"
          aria-label={t('status.cancelled')}
          className={cn(icon, 'text-disabled')}
        />
      )
  }
}

/** An ask once answered: how many questions got an answer, and each question over its answer. */
function AnsweredAsk({
  questions,
  device,
}: {
  questions: AnsweredQuestion[]
  device: string | null
}) {
  const { t } = useTranslation('session')
  const given = questions.filter((q) => q.answered).length
  return (
    <div className="min-w-0 rounded-card bg-card shadow-card">
      <div className="flex min-h-12 min-w-0 items-center gap-2.5 py-2 pr-4 pl-4">
        <CheckIcon aria-hidden strokeWidth={2} className="size-4 shrink-0 text-secondary" />
        <span className="shrink-0 text-ui font-medium text-foreground">
          {given === 0
            ? t('question.skipped')
            : t('question.answered', { answered: given, total: questions.length })}
        </span>
        {device && <span className="min-w-0 truncate text-control text-tertiary">· {device}</span>}
      </div>
      <div className="px-4 pb-3 pl-11">
        <AnsweredQuestions questions={questions} />
      </div>
    </div>
  )
}
