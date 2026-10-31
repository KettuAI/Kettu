import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
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
  TrashIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  PendingPermission,
  PermissionKind,
  ToolContent,
  ToolEntry,
  ToolKind,
} from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
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
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename, dirname, relativePath } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { Clamp } from '../clamp'
import { Diff, Markdown } from '../markdown'
import { CarriedImage } from '../media/carried-image'
import { CarriedMedia } from '../media/carried-media'
import { EntryIdContext, SessionIdContext } from '../media/grants'
import { LocalMedia } from '../media/local-media'
import { toolMedia } from '../media/named'
import { useEntry, useEntryAnimation } from '../use-thread'
import { commandOutput, primaryOption, PANEL, respondToPermission, toolLabel } from './helpers'
import { useDiffStats } from './use-diff-stats'

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: FileTextIcon,
  edit: FilePenIcon,
  delete: TrashIcon,
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

type PermissionOption = PendingPermission['options'][number]

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
  const media = useMemo(() => (entry ? toolMedia(entry) : []), [entry])

  useEffect(() => {
    if (permission) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [permission])

  if (!entry) return null
  const label = toolLabel(entry, projectPath)
  const command = label.kind === 'command' ? label.target : null
  // A command's output shows under it, in the same block, as a terminal prints it.
  const output = command ? commandOutput(entry.content) : null
  const content = output === null ? entry.content : entry.content.slice(1)
  const hasBody =
    entry.content.length > 0 ||
    media.length > 0 ||
    !!permission ||
    (!!command && (command.length > 60 || command.includes('\n')))
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
            role="group"
            aria-label={t('permission.label')}
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
              framed ? 'border-t border-border-soft p-3' : 'gap-1.5 pt-1.5 pb-0.5 pl-5.5',
            )}
          >
            <div className={cn('flex flex-col', framed && 'gap-2')}>
              {command && <CommandBlock command={command} output={output} />}
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
              {media.length > 0 && (
                <SessionIdContext value={sessionId}>
                  <EntryIdContext value={entryId}>
                    <div className="flex flex-col items-start gap-3 empty:hidden">
                      {media.map((path) => (
                        <LocalMedia key={path} path={path} imageHeight={MEDIA_IMAGE_HEIGHT} />
                      ))}
                    </div>
                  </EntryIdContext>
                </SessionIdContext>
              )}
            </div>
            {permission && (
              <PermissionPrompt sessionId={sessionId} entry={entry} agentName={agentName} />
            )}
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
        {label.verb && <span className="shrink-0 font-medium text-secondary">{label.verb}</span>}
        {label.target && <Target label={label} />}
      </span>
      {stats && (stats.insertions > 0 || stats.deletions > 0) && (
        <span className="flex shrink-0 animate-in gap-2 tabular animation-duration-(--duration-base) fade-in">
          <span className="text-success">+{stats.insertions}</span>
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
    ? 'group/tool flex h-card-header w-full min-w-0 items-center gap-2 px-3 text-left text-tertiary outline-none'
    : 'group/tool -mx-1.5 flex h-6.5 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-small text-muted-foreground outline-none'
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
      <span className="flex min-w-0 font-mono text-xs text-secondary">
        {/* An empty truncating span would put the row's baseline at its bottom edge. */}
        {folder && <span className="truncate">{folder}</span>}
        <span className="shrink-0">{basename(target)}</span>
      </span>
    ) : label.kind === 'command' ? (
      <span className="min-w-0 truncate font-mono text-xs text-secondary">
        {target.split('\n')[0]}
      </span>
    ) : (
      <span className="min-w-0 truncate">{target}</span>
    )
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex min-w-0" />}>{text}</TooltipTrigger>
      <TooltipContent className="max-w-[480px] font-mono text-meta break-all whitespace-pre-wrap">
        {target}
      </TooltipContent>
    </Tooltip>
  )
}

function ToolStatus({ entry }: { entry: ToolEntry }) {
  const { t } = useTranslation('session')
  if (entry.permission) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.75 text-xs font-medium text-primary">
        <span aria-hidden className="size-2 rounded-full bg-attention-dot" />
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
        <Spinner key="running" aria-label={t('status.running')} className={cn(icon, 'text-info')} />
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

/** The command, and what it printed under it once it has run, as a terminal shows them. */
function CommandBlock({ command, output }: { command: string; output: string | null }) {
  const { t } = useTranslation('session')
  const printed = !!output
  return (
    <div
      data-selectable=""
      className={cn(
        'flex flex-col rounded-code bg-code-block px-3 font-mono shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]',
        printed ? 'py-2.25 text-code' : 'py-2 text-command',
      )}
    >
      <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
        <span className="mr-2 text-tertiary select-none">$</span>
        {command}
      </pre>
      {printed && (
        <Clamp maxHeight={260} more={t('tool.showAll')} buttonClassName="-mx-1.5">
          <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
            {output}
          </pre>
        </Clamp>
      )}
    </div>
  )
}

/** The tallest an image shows in a tool call's details. */
const MEDIA_IMAGE_HEIGHT = 160

function ContentBlock({
  sessionId,
  entryId,
  index,
  content,
  projectPath,
}: {
  sessionId: string
  entryId: string
  /** Its place among the call's content, by which the viewer knows a picture. */
  index: number
  content: ToolContent
  projectPath: string
}) {
  const { t } = useTranslation('session')
  switch (content.type) {
    case 'markdown':
      return (
        <div data-selectable="">
          <Clamp maxHeight={320} more={t('tool.showAll')}>
            <Markdown markdown={content.markdown} className="markdown-compact" />
          </Clamp>
        </div>
      )
    case 'diff':
      // Framed like a code block, in a row's details and in a request's card alike.
      return (
        <div className="flex flex-col overflow-hidden rounded-code border border-subtle">
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
      if (content.ref.kind === 'image') {
        return (
          <CarriedImage
            sessionId={sessionId}
            entryId={entryId}
            index={index}
            mimeType={content.ref.mimeType}
            data={content.ref.data}
            className="max-h-40 max-w-full self-start rounded-lg shadow-card"
          />
        )
      }
      if (content.ref.kind === 'audio' || content.ref.kind === 'video') {
        return (
          <CarriedMedia
            sessionId={sessionId}
            entryId={entryId}
            index={index}
            carried={content.ref}
          />
        )
      }
      return (
        <div className="text-xs text-muted-foreground">
          {content.ref.kind === 'link'
            ? content.ref.name || content.ref.uri
            : content.ref.kind === 'unsupported'
              ? content.ref.label
              : content.ref.attachment.name}
        </div>
      )
  }
}

/**
 * The agent's sentence and its options, one per line in the agent's order, each with its number.
 * The usual answer is drawn as the primary row and starts highlighted; the arrow keys move the
 * highlight and Enter answers it. Outside a field, the number keys and Enter answer too.
 */
function PermissionPrompt({
  sessionId,
  entry,
  agentName,
}: {
  sessionId: string
  entry: ToolEntry
  agentName: string
}) {
  const { t } = useTranslation(['session', 'routines'])
  const routine = useSessionsStore((s) => s.byId[sessionId]?.routine ?? null)
  const level = useRoutinesStore((s) =>
    routine ? (s.byId[routine.routineId]?.scope.level ?? null) : null,
  )
  const permission = entry.permission!
  const primary = primaryOption(permission.options)
  const [highlight, setHighlight] = useState(primary)
  const [answering, setAnswering] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)

  const respond = async (option: PermissionOption) => {
    // An answer from the card's own rows would leave the focus on nothing once the card goes.
    const focused = !!list.current?.contains(document.activeElement)
    setAnswering(option.id)
    setError(null)
    try {
      await respondToPermission(sessionId, permission.requestId, option.id)
      if (focused) emitAppEvent({ kind: 'focus-composer' })
    } catch (e) {
      setError(errorMessage(e))
      setAnswering(null)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const last = buttons.length - 1
    const next =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? at === last
          ? 0
          : at + 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? at === 0
            ? last
            : at - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <div className="flex flex-col">
      <p className="mx-0.5 my-2.5 text-ui text-secondary">
        {t(`permission.ask.${ASK_KEY[entry.toolKind]}`, { agent: agentName })}
      </p>
      {level && (
        <p className="mx-0.5 -mt-1 mb-2.5 text-xs text-tertiary">
          {t('permission.outsideScope', {
            level: t(`routines:permission.level.${level}.name`),
          })}
        </p>
      )}
      <div
        ref={list}
        role="group"
        aria-label={t('permission.answerGroup')}
        className="-mx-1.5 mt-0.5 -mb-1 flex flex-col gap-px"
        onKeyDown={onKeyDown}
      >
        {permission.options.map((option, i) => (
          <button
            key={option.id}
            type="button"
            disabled={answering !== null}
            data-permission-option={i + 1}
            data-highlighted={i === highlight ? '' : undefined}
            aria-keyshortcuts={i < 4 ? String(i + 1) : undefined}
            onPointerEnter={() => setHighlight(i)}
            onFocus={() => setHighlight(i)}
            onClick={() => void respond(option)}
            className="flex h-8.5 w-full min-w-0 cursor-default items-center gap-2.5 rounded-lg pr-2.5 pl-2 text-left text-ui text-foreground outline-none transition-colors duration-(--duration-fast) focus-ring disabled:opacity-60 data-highlighted:bg-selected"
          >
            {answering === option.id ? (
              <span className="flex size-5 shrink-0 items-center justify-center">
                <Spinner className="size-3.5" />
              </span>
            ) : i < 4 ? (
              <Kbd aria-hidden variant={i === primary ? 'primary' : 'default'}>
                {i + 1}
              </Kbd>
            ) : (
              <span aria-hidden className="size-5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{option.name}</span>
            {i === highlight && answering === null && (
              <span aria-hidden className="shrink-0 text-tertiary">
                ↵
              </span>
            )}
          </button>
        ))}
      </div>
      {error && <p className="mx-0.5 mt-2 text-xs text-danger">{error}</p>}
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
        : result.by === 'routine'
          ? t('permission.answer.allowedByRoutine')
          : t(`permission.answer.${ANSWER_KEY[result.kind]}`)
  return (
    <span className="shrink-0 animate-in text-xs text-tertiary animation-duration-(--duration-base) fade-in">
      {text}
    </span>
  )
}
