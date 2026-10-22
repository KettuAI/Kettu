import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowRightLeftIcon,
  BanIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
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

const ASK: Record<ToolKind, string> = {
  read: 'read this file',
  edit: 'make this change',
  delete: 'delete this file',
  move: 'move this file',
  search: 'search the project',
  execute: 'run this command',
  think: 'use this tool',
  fetch: 'fetch this page',
  switch_mode: 'switch modes',
  other: 'use this tool',
}

const ANSWER: Record<PermissionKind, string> = {
  allow_once: 'Allowed once',
  allow_always: 'Always allowed',
  reject_once: 'Rejected',
  reject_always: 'Always rejected',
}

export interface ToolCardProps {
  sessionId: string
  entryId: string
  projectPath: string
  agentName: string
  /** Inside a group the card is a row of the group, without its own ring. */
  nested?: boolean
}

export const ToolCard = memo(function ToolCard({
  sessionId,
  entryId,
  projectPath,
  agentName,
  nested = false,
}: ToolCardProps) {
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

  const card = (
    <Collapsible
      open={open}
      onOpenChange={(next) => setUserOpen(next)}
      render={
        <Card
          ref={ref}
          variant="tool"
          data-entry-id={entryId}
          className={cn(
            nested && 'rounded-none bg-transparent shadow-none',
            permission && !nested && 'animate-attention shadow-attention',
            animation,
          )}
        />
      }
    >
      <ToolHeader entry={entry} label={label} toggle={hasBody && !permission} open={open} />
      {hasBody && (
        <CollapsibleContent className={PANEL} keepMounted={false}>
          <div className={cn('flex flex-col', !nested && 'border-t border-border-soft')}>
            {label.kind === 'command' && label.target && <CommandBlock command={label.target} />}
            {entry.content.map((c, i) => (
              <ContentBlock key={i} content={c} projectPath={projectPath} />
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
          Run in terminal
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(command)}>
          Copy command
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
}: {
  entry: ToolEntry
  label: ReturnType<typeof toolLabel>
  toggle: boolean
  open: boolean
}) {
  const Icon = KIND_ICON[entry.toolKind]
  const stats = useDiffStats(entry.content)
  const content = (
    <>
      <span className="relative flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
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
          <span className="text-success-text">+{stats.insertions}</span>{' '}
          <span className="text-destructive">−{stats.deletions}</span>
        </span>
      )}
      {!entry.permission && entry.permissionResult && (
        <PermissionAnswer result={entry.permissionResult} />
      )}
      <ToolStatus entry={entry} />
    </>
  )
  const row =
    'group/tool flex h-card-header w-full min-w-0 items-center gap-2 px-3 text-left outline-none'
  if (!toggle) return <div className={row}>{content}</div>
  return (
    <CollapsibleTrigger
      className={cn(
        row,
        'cursor-default rounded-[inherit] transition-colors duration-(--duration-fast) hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
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
  if (entry.permission) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-attention-text">
        <span aria-hidden className="size-1.5 rounded-full bg-attention" />
        Needs approval
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
          aria-label="Pending"
          className={cn(icon, 'text-muted-foreground/70')}
        />
      )
    case 'in_progress':
      return (
        <Spinner key="running" aria-label="Running" className={cn(icon, 'text-muted-foreground')} />
      )
    case 'completed':
      return (
        <CheckIcon
          key="done"
          role="img"
          aria-label="Done"
          className={cn(icon, 'zoom-in-75 text-muted-foreground')}
        />
      )
    case 'failed':
      return (
        <XIcon
          key="failed"
          role="img"
          aria-label="Failed"
          className={cn(icon, 'text-destructive')}
        />
      )
    case 'cancelled':
      return (
        <BanIcon
          key="cancelled"
          role="img"
          aria-label="Cancelled"
          className={cn(icon, 'text-muted-foreground/70')}
        />
      )
  }
}

function CommandBlock({ command }: { command: string }) {
  return (
    <pre
      data-selectable=""
      className="mx-3 mt-2.5 mb-0.5 overflow-x-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      <span className="text-muted-foreground select-none">$ </span>
      {command}
    </pre>
  )
}

function ContentBlock({ content, projectPath }: { content: ToolContent; projectPath: string }) {
  switch (content.type) {
    case 'markdown':
      return (
        <div className="px-3 py-2.5" data-selectable="">
          <Clamp maxHeight={320} more="Show all">
            <Markdown markdown={content.markdown} className="markdown-compact" />
          </Clamp>
        </div>
      )
    case 'diff':
      // Inset by the hairline so the diff's opaque lines leave the card's inset ring visible.
      return (
        <div className="mx-(--hairline) flex flex-col last:mb-(--hairline)">
          <Clamp maxHeight={480} more="Show full diff" buttonClassName="mx-2 my-1">
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
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {content.ref.kind === 'link'
            ? content.ref.name || content.ref.uri
            : content.ref.kind === 'unsupported'
              ? content.ref.label
              : 'Image'}
        </div>
      )
  }
}

const OPTION_VARIANT: Record<PermissionKind, 'default' | 'outline' | 'destructive'> = {
  allow_once: 'default',
  allow_always: 'outline',
  reject_once: 'destructive',
  reject_always: 'destructive',
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
        {agentName} wants to {ASK[entry.toolKind]}.
      </p>
      <div
        role="group"
        aria-label="Answer"
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
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function PermissionAnswer({ result }: { result: NonNullable<ToolEntry['permissionResult']> }) {
  const text =
    result === 'cancelled'
      ? 'Cancelled'
      : result === 'withdrawn'
        ? 'No longer needed'
        : ANSWER[result.kind]
  const rejected =
    result !== 'cancelled' && result !== 'withdrawn' && result.kind.startsWith('reject')
  return (
    <span
      className={cn(
        'shrink-0 animate-in text-xs text-muted-foreground animation-duration-(--duration-base) fade-in',
        rejected && 'text-destructive',
      )}
    >
      {text}
    </span>
  )
}
