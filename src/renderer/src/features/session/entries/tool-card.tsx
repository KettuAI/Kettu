import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowRightLeftIcon,
  BanIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  CopyIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  RepeatIcon,
  SearchIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PermissionKind, ToolContent, ToolEntry, ToolKind } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename, dirname, relativePath } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { Clamp } from '../clamp'
import { Diff, Markdown } from '../markdown'
import { useEntry, useEntryAnimation } from '../use-thread'
import { PANEL, respondToPermission, toolLabel } from './helpers'
import { useDiffStats } from './use-diff-stats'

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: FileTextIcon,
  edit: FilePenIcon,
  delete: Trash2Icon,
  move: ArrowRightLeftIcon,
  search: SearchIcon,
  execute: SquareTerminalIcon,
  think: BrainIcon,
  fetch: GlobeIcon,
  switch_mode: RepeatIcon,
  other: WrenchIcon,
}

const ASK_KEY = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'execute',
  think: 'other',
  fetch: 'fetch',
  switch_mode: 'switchMode',
  other: 'other',
} as const satisfies Record<ToolKind, string>

const ANSWER_KEY = {
  allow_once: 'allowOnce',
  allow_always: 'allowAlways',
  reject_once: 'rejectOnce',
  reject_always: 'rejectAlways',
} as const satisfies Record<PermissionKind, string>

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

  useEffect(() => {
    if (permission) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [permission])

  if (!entry) return null
  const label = toolLabel(entry, projectPath)
  const hasBody =
    entry.content.length > 0 ||
    !!permission ||
    (label.kind === 'command' &&
      !!label.target &&
      (label.target.length > 60 || label.target.includes('\n')))
  const autoOpen =
    hasBody &&
    (!!permission ||
      entry.status === 'pending' ||
      entry.status === 'in_progress' ||
      entry.status === 'failed')
  const open = hasBody && (permission ? true : (userOpen ?? autoOpen))
  const framed = !!permission

  const card = (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      render={
        framed ? (
          <Card
            ref={ref}
            variant="tool"
            data-entry-id={entryId}
            className={cn('animate-attention shadow-attention', animation)}
          />
        ) : (
          <div ref={ref} data-entry-id={entryId} className={cn('min-w-0', animation)} />
        )
      }
    >
      <ToolHeader
        entry={entry}
        label={label}
        toggle={hasBody && !permission}
        open={open}
        framed={framed}
      />
      {hasBody && (
        <CollapsibleContent className={PANEL} keepMounted={false}>
          <div
            className={cn(
              'flex flex-col',
              framed ? 'border-t border-border-soft' : 'gap-1.5 pt-1 pb-2 pl-[22px]',
            )}
          >
            {label.kind === 'command' && label.target && (
              <CommandBlock command={label.target} framed={framed} />
            )}
            {entry.content.map((c, i) => (
              <ContentBlock key={i} content={c} projectPath={projectPath} framed={framed} />
            ))}
            {permission && (
              <PermissionPrompt sessionId={sessionId} entry={entry} agentName={agentName} />
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )

  if (entry.toolKind !== 'execute' || !label.target) return card
  const command = label.target
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => emitAppEvent({ kind: 'run-in-terminal', projectPath, command })}
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
  entry,
  label,
  toggle,
  open,
  framed,
}: {
  entry: ToolEntry
  label: ReturnType<typeof toolLabel>
  toggle: boolean
  open: boolean
  framed: boolean
}) {
  const Icon = KIND_ICON[entry.toolKind]
  const stats = useDiffStats(entry.content)
  const content = (
    <>
      <span className="relative flex size-3.5 shrink-0 items-center justify-center text-icon">
        <Icon
          className={cn(
            'size-3.5 transition-opacity duration-(--duration-fast)',
            toggle && 'group-hover/tool:opacity-0',
          )}
        />
        {toggle && (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'absolute size-3.5 opacity-0 transition-[opacity,rotate] duration-(--duration-fast) group-hover/tool:opacity-100',
              open && 'rotate-90',
            )}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {label.verb && <span className="shrink-0 font-medium">{label.verb}</span>}
        {label.target && <Target label={label} />}
      </span>
      {stats && (stats.insertions > 0 || stats.deletions > 0) && (
        <span className="shrink-0 animate-in font-mono text-[11.5px] tabular animation-duration-(--duration-base) fade-in">
          <span className="text-success">+{stats.insertions}</span>{' '}
          <span className="text-danger">−{stats.deletions}</span>
        </span>
      )}
      {!entry.permission && entry.permissionResult && (
        <PermissionAnswer result={entry.permissionResult} />
      )}
      <ToolStatus entry={entry} />
    </>
  )
  // A flat row reaches past the column by its padding, so its icon lines up with the prose.
  const row = framed
    ? 'group/tool flex h-card-header w-full min-w-0 items-center gap-2 px-3 text-left outline-none'
    : 'group/tool -mx-1.5 flex h-6 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] leading-[1.6] text-muted-foreground outline-none'
  if (!toggle) return <div className={row}>{content}</div>
  return (
    <CollapsibleTrigger
      className={cn(
        row,
        'cursor-default transition-colors duration-(--duration-fast) focus-ring',
        framed ? 'rounded-[inherit] hover:bg-hover' : 'hover:bg-hover',
      )}
    >
      {content}
    </CollapsibleTrigger>
  )
}

/** Paths keep their file name visible: only the folder part truncates. */
function Target({ label }: { label: ReturnType<typeof toolLabel> }) {
  const target = label.target ?? ''
  const folder = label.kind === 'path' ? dirname(target) : ''
  const text =
    label.kind === 'path' ? (
      <span className="flex min-w-0 font-mono text-xs text-muted-foreground">
        {/* An empty truncating span would put the row's baseline at its bottom edge. */}
        {folder && <span className="truncate">{folder}</span>}
        <span className="shrink-0">{basename(target)}</span>
      </span>
    ) : label.kind === 'command' ? (
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
        {target.split('\n')[0]}
      </span>
    ) : (
      <span className="min-w-0 truncate">{target}</span>
    )
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0" />}>{text}</TooltipTrigger>
      <TooltipContent className="max-w-[480px] font-mono text-[11.5px] break-all whitespace-pre-wrap">
        {target}
      </TooltipContent>
    </Tooltip>
  )
}

function ToolStatus({ entry }: { entry: ToolEntry }) {
  const { t } = useTranslation('session')
  if (entry.permission) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-attention">
        <span aria-hidden className="size-1.5 rounded-full bg-attention-dot" />
        {t('status.needsApproval')}
      </span>
    )
  }
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
        <Spinner key="running" aria-label={t('status.running')} className={cn(icon, 'text-icon')} />
      )
    case 'completed':
      return (
        <CheckIcon
          key="done"
          role="img"
          aria-label={t('status.done')}
          className={cn(icon, 'zoom-in-75 text-icon')}
        />
      )
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

function CommandBlock({ command, framed }: { command: string; framed: boolean }) {
  return (
    <pre
      data-selectable=""
      className={cn(
        'overflow-x-auto rounded-lg bg-code-block shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]',
        framed && 'mx-3 mt-2.5 mb-0.5',
      )}
    >
      <span className="text-muted-foreground select-none">$ </span>
      {command}
    </pre>
  )
}

function ContentBlock({
  content,
  projectPath,
  framed,
}: {
  content: ToolContent
  projectPath: string
  framed: boolean
}) {
  const { t } = useTranslation('session')
  switch (content.type) {
    case 'markdown':
      return (
        <div className={cn(framed && 'px-3 py-2.5')} data-selectable="">
          <Clamp maxHeight={320} more={t('tool.showAll')}>
            <Markdown markdown={content.markdown} className="markdown-compact" />
          </Clamp>
        </div>
      )
    case 'diff':
      // Inset by the hairline so the diff's opaque lines leave the card's inset ring visible; a
      // flat row frames its diff like a code block.
      return (
        <div
          className={cn(
            'flex flex-col',
            framed
              ? 'mx-(--hairline) last:mb-(--hairline)'
              : 'overflow-hidden rounded-lg border border-subtle',
          )}
        >
          <Clamp maxHeight={480} more={t('tool.showFullDiff')} buttonClassName="mx-2 my-1">
            <Diff
              path={relativePath(content.path, projectPath)}
              oldText={content.oldText}
              newText={content.newText}
            />
          </Clamp>
        </div>
      )
    case 'ref':
      return (
        <div className={cn('text-xs text-muted-foreground', framed && 'px-3 py-2')}>
          {content.ref.kind === 'link'
            ? content.ref.name || content.ref.uri
            : content.ref.kind === 'unsupported'
              ? content.ref.label
              : t('tool.image')}
        </div>
      )
  }
}

// Rejecting is neither a failure nor a deletion, so it stays neutral beside the attention ring.
const OPTION_VARIANT: Record<PermissionKind, 'default' | 'outline'> = {
  allow_once: 'default',
  allow_always: 'outline',
  reject_once: 'outline',
  reject_always: 'outline',
}

function PermissionPrompt({
  sessionId,
  entry,
  agentName,
}: {
  sessionId: string
  entry: ToolEntry
  agentName: string
}) {
  const { t } = useTranslation('session')
  const [answering, setAnswering] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const permission = entry.permission!

  const respond = async (optionId: string) => {
    setAnswering(optionId)
    setError(null)
    try {
      await respondToPermission(sessionId, permission.requestId, optionId)
    } catch (e) {
      setError(errorMessage(e))
      setAnswering(null)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div className="flex flex-col gap-2.5 px-3 pt-2.5 pb-3">
      <p className="text-ui text-muted-foreground">
        {t(`permission.ask.${ASK_KEY[entry.toolKind]}`, { agent: agentName })}
      </p>
      <div
        role="group"
        aria-label={t('permission.answerGroup')}
        className="flex flex-wrap gap-1.5"
        onKeyDown={onKeyDown}
      >
        {permission.options.map((option, i) => (
          <Button
            key={option.id}
            variant={OPTION_VARIANT[option.kind]}
            size="compact"
            disabled={answering !== null}
            data-permission-option={i + 1}
            onClick={() => void respond(option.id)}
          >
            {answering === option.id ? (
              <Spinner data-icon="inline-start" className="size-3" />
            ) : (
              i < 4 && (
                <span aria-hidden className="text-[11px] tabular opacity-55">
                  {i + 1}
                </span>
              )
            )}
            {option.name}
          </Button>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

function PermissionAnswer({ result }: { result: NonNullable<ToolEntry['permissionResult']> }) {
  const { t } = useTranslation('session')
  const text =
    result === 'cancelled'
      ? t('permission.answer.cancelled')
      : result === 'withdrawn'
        ? t('permission.answer.withdrawn')
        : t(`permission.answer.${ANSWER_KEY[result.kind]}`)
  const rejected =
    result !== 'cancelled' && result !== 'withdrawn' && result.kind.startsWith('reject')
  return (
    <span
      className={cn(
        'shrink-0 animate-in text-xs text-muted-foreground animation-duration-(--duration-base) fade-in',
        rejected && 'text-secondary',
      )}
    >
      {text}
    </span>
  )
}
