import { memo, useEffect, useMemo, useRef, useState, type Ref } from 'react'
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
  HandIcon,
  PencilIcon,
  RepeatIcon,
  SearchIcon,
  SquareTerminalIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  previewsCommand,
  type PermissionKind,
  type ToolContent,
  type ToolEntry,
  type ToolKind,
} from '@shared/thread'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { basename, dirname, relativePath } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { cn } from '@renderer/lib/utils'
import { toast } from '@renderer/components/ui/toast'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useWebHostStore } from '@renderer/stores/web-host'
import { Clamp } from '../clamp'
import { Diff, Markdown } from '../markdown'
import { CarriedImage } from '../media/carried-image'
import { CarriedMedia } from '../media/carried-media'
import { EntryIdContext, SessionIdContext } from '../media/grants'
import { LocalMedia } from '../media/local-media'
import { toolMedia } from '../media/named'
import { useEntry, useEntryAnimation } from '../use-thread'
import { AnswerList, OptionName, WaitingCard, WaitingHeader, WaitingStatus } from './answer-list'
import {
  answeredBy,
  commandOutput,
  primaryOption,
  PANEL,
  respondToPermission,
  toolLabel,
} from './helpers'
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
  if (permission) {
    // Each request gets a card of its own, so an agent's next question in the same entry starts
    // unanswered rather than inheriting the last one's pending answer.
    return (
      <PermissionCard
        key={permission.requestId}
        ref={ref}
        sessionId={sessionId}
        entry={entry}
        projectPath={projectPath}
        agentName={agentName}
        media={media}
        className={animation}
      />
    )
  }
  const label = toolLabel(entry, projectPath)
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
      <ToolHeader entry={entry} label={label} toggle={hasBody} open={open} />
      {hasBody && (
        <CollapsibleContent className={PANEL} keepMounted={false}>
          <div className="flex flex-col gap-1.5 pt-1.5 pb-0.5 pl-5.5">
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
}: {
  entry: ToolEntry
  label: ReturnType<typeof toolLabel>
  toggle: boolean
  open: boolean
}) {
  const Icon = entry.question !== undefined ? HandIcon : KIND_ICON[entry.toolKind]
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
      {entry.permissionResult && (
        <PermissionAnswer result={entry.permissionResult} question={entry.question !== undefined} />
      )}
      <ToolStatus entry={entry} />
    </>
  )
  // A flat row reaches past the column by its padding, so its icon lines up with the prose.
  const row =
    'group/tool -mx-1.5 flex h-6.5 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-small text-muted-foreground outline-none'
  if (!toggle) return <div className={row}>{content}</div>
  return (
    <CollapsibleTrigger
      className={cn(
        row,
        'cursor-default transition-colors duration-(--duration-fast) hover:bg-hover focus-ring',
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
  bleed = false,
}: {
  sessionId: string
  entryId: string
  /** Its place among the call's content, by which the viewer knows a picture. */
  index: number
  content: ToolContent
  projectPath: string
  /** In a request's card: a diff spans the card's width. */
  bleed?: boolean
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
      // Framed like a code block in a row's details; in a request's card it runs edge to edge.
      return (
        <div
          className={cn(
            'flex flex-col overflow-hidden',
            bleed
              ? 'border-b border-border-soft bg-code-block'
              : 'rounded-code border border-subtle',
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

/** Pictures a tool call made or read, under its details. */
function ToolMedia({
  sessionId,
  entryId,
  media,
}: {
  sessionId: string
  entryId: string
  media: string[]
}) {
  if (media.length === 0) return null
  return (
    <SessionIdContext value={sessionId}>
      <EntryIdContext value={entryId}>
        <div className="flex flex-col items-start gap-3 empty:hidden">
          {media.map((path) => (
            <LocalMedia key={path} path={path} imageHeight={MEDIA_IMAGE_HEIGHT} />
          ))}
        </div>
      </EntryIdContext>
    </SessionIdContext>
  )
}

/**
 * A request waiting for the user: what the call would do, then its options, one per line in the
 * agent's order, each with its number. A question shows the agent's words and its answers, the
 * last of which lets the user answer in the composer instead.
 */
function PermissionCard({
  ref,
  sessionId,
  entry,
  projectPath,
  agentName,
  media,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  projectPath: string
  agentName: string
  media: string[]
  className?: string
}) {
  const { t } = useTranslation(['session', 'routines'])
  const routine = useSessionsStore((s) => s.byId[sessionId]?.routine ?? null)
  const level = useRoutinesStore((s) =>
    routine ? (s.byId[routine.routineId]?.scope.level ?? null) : null,
  )
  // An answer cannot reach a host that is not connected; the card waits for it to come back.
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const other = useOtherHost(hostId)
  const away = isAway(other?.connection ?? null)
  const served = useWebHostStore((s) => s.host?.name ?? null)
  const [answering, setAnswering] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const permission = entry.permission!
  const question = entry.question
  const label = toolLabel(entry, projectPath)
  const command = label.kind === 'command' ? label.target : null
  const Icon =
    question !== undefined
      ? HandIcon
      : entry.toolKind === 'edit'
        ? PencilIcon
        : KIND_ICON[entry.toolKind]

  const respond = async (index: number) => {
    const option = permission.options[index]
    if (!option) return
    // An answer from the card's own rows would leave the focus on nothing once the card goes;
    // a denial or Something else goes on in the composer, where the user says what instead.
    const focused = !!list.current?.contains(document.activeElement)
    setAnswering(option.id)
    setError(null)
    try {
      await respondToPermission(sessionId, permission.requestId, option.id)
      if (focused || option.kind === 'reject_once' || option.kind === 'reject_always') {
        emitAppEvent({ kind: 'focus-composer' })
      }
    } catch (e) {
      const by = answeredBy(e)
      if (by !== undefined) {
        // The card turns into the first answer as its patch lands, so the note goes in a toast.
        const host = hostId !== null ? (other?.name ?? null) : served
        toast(
          by
            ? t('permission.answeredOn', { device: by.name })
            : host
              ? t('permission.answeredOn', { device: host })
              : t('permission.answeredInWindow'),
        )
      } else {
        setError(errorMessage(e))
      }
      setAnswering(null)
    }
  }

  return (
    <WaitingCard
      ref={ref}
      entryId={entry.id}
      label={question !== undefined ? t('question.label') : t('permission.label')}
      description={
        question !== undefined
          ? t('question.ask', { agent: agentName })
          : t(`permission.ask.${ASK_KEY[entry.toolKind]}`, { agent: agentName })
      }
      className={className}
    >
      <WaitingHeader>
        <Icon aria-hidden className="size-3.75 shrink-0" />
        {question !== undefined ? (
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-secondary">
            {t('question.label')}
          </span>
        ) : label.verb ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 text-ui font-medium text-secondary">{label.verb}</span>
            {label.target && <Target label={label} />}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-ui font-medium text-secondary">
            {label.target}
          </span>
        )}
        <WaitingStatus>
          {question !== undefined ? t('question.asksYou') : t('permission.needsYou')}
        </WaitingStatus>
      </WaitingHeader>
      {question !== undefined && (
        <p data-selectable="" className="px-3.5 pt-3 pb-1 text-row leading-normal text-foreground">
          {question}
        </p>
      )}
      {command && previewsCommand(command) && (
        <pre
          data-selectable=""
          className="border-b border-border-soft bg-code-block px-3.5 py-2.5 font-mono text-command leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
        >
          {command}
        </pre>
      )}
      {entry.content.map((content, i) =>
        content.type === 'diff' ? (
          <ContentBlock
            key={i}
            sessionId={sessionId}
            entryId={entry.id}
            index={i}
            content={content}
            projectPath={projectPath}
            bleed
          />
        ) : (
          <div key={i} className="border-b border-border-soft px-3.5 py-2.5">
            <ContentBlock
              sessionId={sessionId}
              entryId={entry.id}
              index={i}
              content={content}
              projectPath={projectPath}
            />
          </div>
        ),
      )}
      {media.length > 0 && (
        <div className="border-b border-border-soft px-3.5 py-2.5">
          <ToolMedia sessionId={sessionId} entryId={entry.id} media={media} />
        </div>
      )}
      {level && (
        <p className="px-3.5 pt-2.5 text-xs text-tertiary">
          {t('permission.outsideScope', {
            level: t(`routines:permission.level.${level}.name`),
          })}
        </p>
      )}
      <AnswerList
        ref={list}
        label={t('permission.answerGroup')}
        answers={permission.options.map((option) => ({
          key: option.id,
          label: <OptionName name={option.name} />,
          ...(option.description ? { description: option.description } : {}),
        }))}
        primary={primaryOption(permission.options)}
        answering={answering}
        disabled={away}
        onAnswer={(index) => void respond(index)}
      />
      {error && <p className="mx-3.5 mb-2.5 text-xs text-danger">{error}</p>}
    </WaitingCard>
  )
}

function PermissionAnswer({
  result,
  question,
}: {
  result: NonNullable<ToolEntry['permissionResult']>
  question: boolean
}) {
  const { t } = useTranslation('session')
  const answer =
    result === 'cancelled'
      ? t('permission.answer.cancelled')
      : result === 'withdrawn'
        ? t('permission.answer.withdrawn')
        : result.name
          ? result.name
          : question && result.kind === 'reject_once'
            ? t('question.answeredOther')
            : result.by === 'routine'
              ? t('permission.answer.allowedByRoutine')
              : t(`permission.answer.${ANSWER_KEY[result.kind]}`)
  const device = typeof result === 'object' ? result.device : undefined
  const text = device ? t('permission.answer.onDevice', { answer, device: device.name }) : answer
  return (
    <span className="min-w-0 shrink animate-in truncate text-xs text-tertiary animation-duration-(--duration-base) fade-in">
      {text}
    </span>
  )
}
