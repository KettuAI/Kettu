import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowDownIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, CommitSummary, GitStatus, LogCommit } from '@shared/git'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card'
import { Separator } from '@renderer/components/ui/separator'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { fullTime, shortAgo } from '@renderer/lib/format'
import { isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { openDiff } from '@renderer/stores/files'
import { CopyButton } from './copy-button'
import { projectRelative } from './sync'
import { loadCommit, useChanges, useCommit, useIncoming } from './use-git-data'

/** A row of the popover: menu-family height, padding and highlight, one for pointer and keys. */
export const ROW =
  'flex h-row w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-visible:bg-hover data-[popup-open]:bg-hover'

/** A part of the popover, under a separator; a part with nothing to show is left out whole. */
export function Part({ children }: { children: ReactNode }) {
  return (
    <>
      <Separator className="bg-border-soft" />
      {children}
    </>
  )
}

/** Commits shown before "N more". */
const FIRST_COMMITS = 10

type Segment = 'solid' | 'dashed' | null
type Node = 'pushed' | 'unpushed' | 'work' | 'base' | 'incoming' | null

/** One row's piece of the branch's lane: the line above and below, and the row's node. */
function Lane({ top, bottom, node }: { top: Segment; bottom: Segment; node: Node }) {
  const line = (segment: Segment, y1: number, y2: number) =>
    segment && (
      <line
        x1={8}
        x2={8}
        y1={y1}
        y2={y2}
        className="stroke-border-strong"
        strokeWidth={1.25}
        strokeDasharray={segment === 'dashed' ? '2 2.5' : undefined}
      />
    )
  const gap = node === null ? 0 : node === 'work' ? 5 : 4.5
  return (
    <svg aria-hidden width={16} height={28} viewBox="0 0 16 28" className="-my-px shrink-0">
      {line(top, 0, 14 - gap)}
      {line(bottom, 14 + gap, 28)}
      {node === 'pushed' && <circle cx={8} cy={14} r={3.5} className="fill-muted-foreground" />}
      {node === 'unpushed' && (
        <circle
          cx={8}
          cy={14}
          r={3.5}
          strokeWidth={1.5}
          className="fill-popover stroke-foreground"
        />
      )}
      {node === 'work' && (
        <circle
          cx={8}
          cy={14}
          r={4}
          strokeWidth={1.25}
          strokeDasharray="2 2"
          className="fill-popover stroke-muted-foreground"
        />
      )}
      {node === 'base' && <circle cx={8} cy={14} r={3} className="fill-border-strong" />}
      {node === 'incoming' && (
        <circle
          cx={8}
          cy={14}
          r={3}
          strokeWidth={1.25}
          className="fill-popover stroke-border-strong"
        />
      )}
    </svg>
  )
}

function RefPill({ name, strong }: { name: string; strong?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-4.5 shrink-0 items-center rounded-md px-1.5 font-mono text-meta whitespace-nowrap',
        strong
          ? 'bg-subtle text-primary'
          : 'text-tertiary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
      )}
    >
      {name}
    </span>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        'size-3 shrink-0 text-icon transition-transform duration-(--duration-fast) motion-reduce:transition-none',
        open && 'rotate-90',
      )}
    />
  )
}

/** Arrow keys fold and unfold a row that opens in place. */
function disclosureKeys(open: boolean, toggle: () => void) {
  return (event: KeyboardEvent) => {
    if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) {
      event.preventDefault()
      toggle()
    }
  }
}

const STATUS_LETTER: Record<ChangedFile['status'], { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-tertiary' },
  untracked: { letter: 'U', className: 'text-tertiary' },
  modified: { letter: 'M', className: 'text-tertiary' },
  renamed: { letter: 'R', className: 'text-tertiary' },
  copied: { letter: 'C', className: 'text-tertiary' },
  typechange: { letter: 'T', className: 'text-tertiary' },
  deleted: { letter: 'D', className: 'text-danger' },
  conflicted: { letter: '!', className: 'text-danger' },
}

function LineCounts({
  insertions,
  deletions,
}: {
  insertions: number | null
  deletions: number | null
}) {
  if (insertions === null || deletions === null) return null
  return (
    <span className="shrink-0 font-mono text-meta tabular">
      {insertions > 0 && <span className="text-success">+{insertions}</span>}
      {insertions > 0 && deletions > 0 && ' '}
      {deletions > 0 && <span className="text-danger">−{deletions}</span>}
    </span>
  )
}

/** A changed file; it opens its diff in the Files pane. */
function FileRow({
  status,
  file,
  ref,
  lane,
  onOpened,
}: {
  status: GitStatus
  file: ChangedFile
  ref: string | null
  lane: Segment
  onOpened: () => void
}) {
  const { t } = useTranslation('git')
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const folder = slash < 0 ? '' : file.path.slice(0, slash)
  const { letter, className } = STATUS_LETTER[file.status]
  return (
    <button
      type="button"
      data-git-row=""
      className={ROW}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      aria-label={t('timeline.openDiff', { name })}
      onClick={() => {
        const root = status.repo?.root ?? status.projectPath
        openDiff(status.projectPath, {
          path: file.path,
          oldPath: file.oldPath,
          ref,
          projectFile:
            file.status === 'deleted' ? null : projectRelative(root, status.projectPath, file.path),
        })
        onOpened()
      }}
    >
      <Lane top={lane} bottom={lane} node={null} />
      <span className={cn('w-3 shrink-0 text-center font-mono text-meta', className)}>
        {letter}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 truncate">{name}</span>
        {folder && <span className="min-w-0 truncate text-xs text-tertiary">{folder}</span>}
      </span>
      <LineCounts insertions={file.insertions} deletions={file.deletions} />
    </button>
  )
}

function LoadingRows({ lane, count = 2 }: { lane: Segment; count?: number }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="flex h-row items-center gap-2 px-2">
      <Lane top={lane} bottom={lane} node={null} />
      <Skeleton className="h-3 w-3" />
      <Skeleton className="h-3 flex-1" style={{ maxWidth: `${70 - i * 18}%` }} />
    </div>
  ))
}

function ErrorRow({ lane, message }: { lane: Segment; message: string }) {
  return (
    <div className="flex h-row items-center gap-2 px-2 text-xs text-danger" title={message}>
      <Lane top={lane} bottom={lane} node={null} />
      <span className="min-w-0 truncate">{message.split('\n')[0]}</span>
    </div>
  )
}

function LogRows({ commits, lane }: { commits: LogCommit[]; lane: Segment }) {
  const now = useNow()
  return commits.map((c) => (
    <div key={c.oid} className="flex h-row items-center gap-2 px-2 text-tertiary">
      <Lane top={lane} bottom={lane} node={null} />
      <span className="w-13 shrink-0 font-mono text-meta">{c.oid.slice(0, 7)}</span>
      <span className="min-w-0 flex-1 truncate" title={c.subject}>
        {c.subject}
      </span>
      <span className="max-w-24 shrink-0 truncate text-xs">{c.authorName}</span>
      <span className="w-6 shrink-0 text-right text-xs tabular">{shortAgo(c.authoredAt, now)}</span>
    </div>
  ))
}

type Item =
  | { kind: 'up' }
  | { kind: 'work' }
  | { kind: 'commit'; commit: CommitSummary; upstreamTip: boolean }
  | { kind: 'more'; count: number }
  | { kind: 'base' }

/** The branch's history as one lane of rows: to pull, uncommitted, commits, then the base. */
export function Timeline({ status, onOpened }: { status: GitStatus; onOpened: () => void }) {
  const { upstream, changes, commits, base } = status
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [all, setAll] = useState(false)
  // Once one commit's card shows, the next opens at once, as VS Code's hover groups do.
  const [warm, setWarm] = useState(false)
  const cooling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCard = (shown: boolean): void => {
    if (cooling.current) clearTimeout(cooling.current)
    if (shown) setWarm(true)
    else cooling.current = setTimeout(() => setWarm(false), 300)
  }
  const toggle = (key: string) => () =>
    setOpen((now) => {
      const next = new Set(now)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const files = changes.staged + changes.unstaged + changes.untracked + changes.conflicted
  const shown = all ? commits : commits.slice(0, FIRST_COMMITS)
  const tip = commits.findIndex((c) => c.pushed)
  const items: Item[] = []
  if (upstream && upstream.behind > 0) items.push({ kind: 'up' })
  if (files > 0) items.push({ kind: 'work' })
  shown.forEach((commit, i) => items.push({ kind: 'commit', commit, upstreamTip: i === tip }))
  if (shown.length < commits.length)
    items.push({ kind: 'more', count: commits.length - shown.length })
  if (base && status.head.branch !== status.defaultBranch) items.push({ kind: 'base' })
  if (items.length === 0) return null

  // The lane is dashed next to what is not on the branch yet: commits to pull, uncommitted work.
  const segment = (i: number): Segment => {
    const a = items[i]
    const b = items[i + 1]
    if (!a || !b) return null
    return a.kind === 'up' || a.kind === 'work' || b.kind === 'up' || b.kind === 'work'
      ? 'dashed'
      : 'solid'
  }

  return (
    <Part>
      <div className="flex flex-col p-1.5">
        {items.map((item, i) => {
          const top = segment(i - 1)
          const bottom = segment(i)
          switch (item.kind) {
            case 'up':
              return (
                <IncomingPart
                  key="up"
                  status={status}
                  open={open.has('up')}
                  toggle={toggle('up')}
                  top={top}
                  bottom={bottom}
                />
              )
            case 'work':
              return (
                <ChangesPart
                  key="work"
                  status={status}
                  files={files}
                  open={open.has('work')}
                  toggle={toggle('work')}
                  top={top}
                  bottom={bottom}
                  onOpened={onOpened}
                />
              )
            case 'commit':
              return (
                <CommitPart
                  key={item.commit.oid}
                  status={status}
                  commit={item.commit}
                  upstreamTip={item.upstreamTip}
                  open={open.has(item.commit.oid)}
                  toggle={toggle(item.commit.oid)}
                  top={top}
                  bottom={bottom}
                  warm={warm}
                  onCard={onCard}
                  onOpened={onOpened}
                />
              )
            case 'more':
              return (
                <MoreRow
                  key="more"
                  count={item.count}
                  top={top}
                  bottom={bottom}
                  onShow={() => setAll(true)}
                />
              )
            case 'base':
              return (
                <BasePart
                  key="base"
                  status={status}
                  open={open.has('base')}
                  toggle={toggle('base')}
                  top={top}
                />
              )
          }
        })}
      </div>
    </Part>
  )
}

function IncomingPart({
  status,
  open,
  toggle,
  top,
  bottom,
}: {
  status: GitStatus
  open: boolean
  toggle: () => void
  top: Segment
  bottom: Segment
}) {
  const { t } = useTranslation('git')
  const behind = status.upstream?.behind ?? 0
  const incoming = useIncoming(status.projectPath, 'upstream', open)
  return (
    <>
      <button
        type="button"
        data-git-row=""
        className={ROW}
        aria-expanded={open}
        title={t('timeline.incomingTitle', { upstream: status.upstream?.name })}
        onClick={toggle}
        onKeyDown={disclosureKeys(open, toggle)}
      >
        <Lane top={top} bottom={bottom} node="incoming" />
        <RefPill name={status.remote?.name ?? 'origin'} />
        <span className="min-w-0 flex-1 truncate">{t('timeline.incoming', { count: behind })}</span>
        <span className="inline-flex shrink-0 items-center gap-px text-xs text-secondary tabular">
          <ArrowDownIcon className="size-3" />
          {behind}
        </span>
        <Chevron open={open} />
      </button>
      {open &&
        (incoming.data ? (
          <LogRows commits={incoming.data} lane={bottom} />
        ) : incoming.error ? (
          <ErrorRow lane={bottom} message={incoming.error} />
        ) : (
          <LoadingRows lane={bottom} count={Math.min(behind, 3)} />
        ))}
    </>
  )
}

function ChangesPart({
  status,
  files,
  open,
  toggle,
  top,
  bottom,
  onOpened,
}: {
  status: GitStatus
  files: number
  open: boolean
  toggle: () => void
  top: Segment
  bottom: Segment
  onOpened: () => void
}) {
  const { t } = useTranslation('git')
  const list = useChanges(status.projectPath, open)
  const { insertions, deletions } = status.changes
  return (
    <>
      <button
        type="button"
        data-git-row=""
        className={ROW}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={disclosureKeys(open, toggle)}
      >
        <Lane top={top} bottom={bottom} node="work" />
        <span className="min-w-0 flex-1 truncate">{t('timeline.uncommitted')}</span>
        <span className="shrink-0 text-xs text-tertiary tabular">
          {t('timeline.files', { count: files })}
        </span>
        <LineCounts insertions={insertions} deletions={deletions} />
        <Chevron open={open} />
      </button>
      {open &&
        (list.data ? (
          list.data.map((file) => (
            <FileRow
              key={file.path}
              status={status}
              file={file}
              ref={null}
              lane={bottom}
              onOpened={onOpened}
            />
          ))
        ) : list.error ? (
          <ErrorRow lane={bottom} message={list.error} />
        ) : (
          <LoadingRows lane={bottom} count={Math.min(files, 3)} />
        ))}
    </>
  )
}

function CommitPart({
  status,
  commit,
  upstreamTip,
  open,
  toggle,
  top,
  bottom,
  warm,
  onCard,
  onOpened,
}: {
  status: GitStatus
  commit: CommitSummary
  upstreamTip: boolean
  open: boolean
  toggle: () => void
  top: Segment
  bottom: Segment
  warm: boolean
  onCard: (shown: boolean) => void
  onOpened: () => void
}) {
  const { t } = useTranslation('git')
  const now = useNow()
  const [copied, setCopied] = useState(false)
  const details = useCommit(status.projectPath, commit.oid, open)
  const github = status.remote?.github
  const short = commit.oid.slice(0, 7)
  const copy = (text: string) => void navigator.clipboard.writeText(text)
  const copyId = (): void => {
    copy(commit.oid)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <HoverCard onOpenChange={onCard}>
            <HoverCardTrigger
              delay={warm ? 0 : 500}
              closeDelay={150}
              render={
                <button
                  type="button"
                  data-git-row=""
                  className={ROW}
                  aria-expanded={open}
                  onClick={toggle}
                  onKeyDown={(event) => {
                    if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'c') {
                      event.preventDefault()
                      copyId()
                      return
                    }
                    disclosureKeys(open, toggle)(event)
                  }}
                />
              }
            >
              <Lane top={top} bottom={bottom} node={commit.pushed ? 'pushed' : 'unpushed'} />
              <span
                className={cn(
                  'w-13 shrink-0 font-mono text-meta text-tertiary',
                  copied && 'text-secondary',
                )}
              >
                {copied ? t('timeline.copied') : short}
              </span>
              <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
              {upstreamTip && status.remote && <RefPill name={status.remote.name} />}
              <span className="w-6 shrink-0 text-right text-xs text-tertiary tabular">
                {shortAgo(commit.authoredAt, now)}
              </span>
            </HoverCardTrigger>
            <HoverCardContent side="left" align="start" sideOffset={14} className="w-xs p-3">
              <CommitCard status={status} commit={commit} />
            </HoverCardContent>
          </HoverCard>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={copyId}>
            <CopyIcon />
            {t('timeline.copyId')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              void loadCommit(status.projectPath, commit.oid).then(
                (c) => copy(c.body ? `${c.subject}\n\n${c.body}` : c.subject),
                () => copy(commit.subject),
              )
            }
          >
            <CopyIcon />
            {t('timeline.copyMessage')}
          </ContextMenuItem>
          {github && commit.pushed && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                render={
                  <a
                    href={`https://github.com/${github.owner}/${github.repo}/commit/${commit.oid}`}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                <ExternalLinkIcon />
                {t('timeline.openOnGitHub')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {open &&
        (details.data ? (
          details.data.files.map((file) => (
            <FileRow
              key={file.path}
              status={status}
              file={file}
              ref={commit.oid}
              lane={bottom}
              onOpened={onOpened}
            />
          ))
        ) : details.error ? (
          <ErrorRow lane={bottom} message={details.error} />
        ) : (
          <LoadingRows lane={bottom} />
        ))}
    </>
  )
}

/** A commit's whole message, author, date, files and id, beside the popover. */
function CommitCard({ status, commit }: { status: GitStatus; commit: CommitSummary }) {
  const { t } = useTranslation('git')
  const { data, error } = useCommit(status.projectPath, commit.oid, true)
  const insertions = data?.files.reduce((sum, f) => sum + (f.insertions ?? 0), 0) ?? 0
  const deletions = data?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0
  const where = commit.pushed
    ? t('timeline.onRemote', { upstream: status.upstream?.name ?? status.remote?.name })
    : status.upstream
      ? t('timeline.notPushed')
      : t('timeline.notPublished')
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-col gap-1">
        <span className="text-ui leading-5 font-medium">{commit.subject}</span>
        {data?.body && (
          <p
            data-selectable=""
            className="max-h-40 overflow-y-auto leading-5 whitespace-pre-wrap text-secondary [overflow-wrap:anywhere]"
          >
            {data.body}
          </p>
        )}
        {!data && !error && <Skeleton className="h-3 w-40" />}
        <span className="text-tertiary">
          {data ? `${data.authorName} · ` : ''}
          {fullTime(commit.authoredAt)} · {where}
        </span>
      </div>
      <div className="h-px bg-border-soft" />
      <div className="flex items-center gap-2 text-tertiary tabular">
        <span className="flex-1">
          {data ? t('timeline.files', { count: data.files.length }) : error ? error : ' '}
        </span>
        {data && <LineCounts insertions={insertions} deletions={deletions} />}
      </div>
      <div className="-mr-1.5 -mb-1 flex items-center gap-1">
        <span data-selectable="" className="flex-1 font-mono text-meta text-tertiary">
          {commit.oid.slice(0, 12)}
        </span>
        <CopyButton text={commit.oid} label={t('timeline.copyId')} />
      </div>
    </div>
  )
}

function MoreRow({
  count,
  top,
  bottom,
  onShow,
}: {
  count: number
  top: Segment
  bottom: Segment
  onShow: () => void
}) {
  const { t } = useTranslation('git')
  return (
    <button type="button" data-git-row="" className={cn(ROW, 'text-tertiary')} onClick={onShow}>
      <Lane top={top} bottom={bottom} node={null} />
      <span className="text-xs">{t('timeline.more', { count })}</span>
    </button>
  )
}

function BasePart({
  status,
  open,
  toggle,
  top,
}: {
  status: GitStatus
  open: boolean
  toggle: () => void
  top: Segment
}) {
  const { t } = useTranslation('git')
  const behind = status.base?.behind ?? 0
  const name = status.defaultBranch ?? status.base?.name ?? ''
  const incoming = useIncoming(status.projectPath, 'base', open && behind > 0)
  const label = (
    <>
      <Lane top={top} bottom={null} node="base" />
      <RefPill name={name} strong />
      <span className="min-w-0 flex-1 truncate text-tertiary">
        {behind > 0 ? t('timeline.baseAhead', { count: behind }) : t('timeline.baseEven')}
      </span>
    </>
  )
  if (behind === 0) return <Static>{label}</Static>
  return (
    <>
      <button
        type="button"
        data-git-row=""
        className={ROW}
        aria-expanded={open}
        title={status.base?.name}
        onClick={toggle}
        onKeyDown={disclosureKeys(open, toggle)}
      >
        {label}
        <span className="inline-flex shrink-0 items-center gap-px text-xs text-tertiary tabular">
          <ArrowDownIcon className="size-3" />
          {behind}
        </span>
        <Chevron open={open} />
      </button>
      {open &&
        (incoming.data ? (
          <LogRows commits={incoming.data} lane={null} />
        ) : incoming.error ? (
          <ErrorRow lane={null} message={incoming.error} />
        ) : (
          <LoadingRows lane={null} count={Math.min(behind, 3)} />
        ))}
    </>
  )
}

function Static({ children }: { children: ReactNode }) {
  return <div className="flex h-row min-w-0 items-center gap-2 px-2 text-ui">{children}</div>
}
