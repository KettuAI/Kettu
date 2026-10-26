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
import { disclosureKeys, kidKeys } from './popover-keys'
import { projectRelative } from './sync'
import {
  changesOpenFirst,
  segmentBelow,
  timelineItems,
  type Segment,
  type TimelineItem,
} from './timeline-model'
import { loadCommit, useChanges, useCommit, useIncoming } from './use-git-data'

/**
 * A row of the popover: menu-family height, padding and radius. The highlight is focus, which
 * follows the pointer too, so the pointer and the arrow keys share one.
 */
export const ROW =
  'flex h-row w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-small outline-none transition-colors duration-(--duration-fast) focus:bg-hover data-[popup-open]:bg-hover in-data-[popup-open]:bg-hover'

/** A row inside an expanded one: shorter, quieter, its lane continuing past it. */
export const KID =
  'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-small text-secondary outline-none transition-colors duration-(--duration-fast) focus:bg-hover'

const KID_STATIC = 'flex h-7 min-w-0 items-center gap-2 px-2 text-small text-secondary'

/** A part of the popover, under a hairline; a part with nothing to show is left out whole. */
export function Part({ children }: { children: ReactNode }) {
  return (
    <>
      <Separator className="bg-border-soft" />
      {children}
    </>
  )
}

type Node = 'pushed' | 'unpushed' | 'work' | 'base' | 'incoming' | null

const LINE = 'absolute inset-x-0 mx-auto w-[1.5px]'
const SOLID = 'bg-border-strong'
const DASHED =
  'bg-[repeating-linear-gradient(to_bottom,var(--border-strong)_0_2px,transparent_2px_4.5px)]'

/** One row's piece of the branch's lane: the line above and below, and the row's node. */
function Lane({
  top,
  bottom,
  node,
  className,
}: {
  top: Segment
  bottom: Segment
  node: Node
  className?: string
}) {
  // The line stops short of a node, so a ring never has the lane running through it.
  const gap = node !== null
  return (
    <span aria-hidden className={cn('relative w-4 shrink-0 self-stretch', className)}>
      {top && (
        <span
          className={cn(
            LINE,
            'top-0',
            gap ? 'bottom-[calc(50%+6.5px)]' : 'bottom-1/2',
            top === 'dashed' ? DASHED : SOLID,
          )}
        />
      )}
      {bottom && (
        <span
          className={cn(
            LINE,
            'bottom-0',
            gap ? 'top-[calc(50%+6.5px)]' : 'top-1/2',
            bottom === 'dashed' ? DASHED : SOLID,
          )}
        />
      )}
      {node && (
        <svg
          viewBox="0 0 10 10"
          className={cn(
            'absolute top-1/2 left-0.75 size-2.5 -translate-y-1/2 overflow-visible',
            NODE_COLOR[node],
          )}
        >
          {node === 'pushed' ? (
            <circle cx={5} cy={5} r={3} className="fill-current" />
          ) : (
            <circle
              cx={5}
              cy={5}
              r={3.6}
              strokeWidth={1.5}
              strokeDasharray={node === 'work' ? '2.1 1.67' : undefined}
              className="fill-none stroke-current"
            />
          )}
          {node === 'base' && <circle cx={5} cy={5} r={1.3} className="fill-current" />}
        </svg>
      )}
    </span>
  )
}

const NODE_COLOR = {
  unpushed: 'text-primary',
  pushed: 'text-tertiary',
  work: 'text-secondary',
  incoming: 'text-tertiary',
  base: 'text-tertiary',
} as const

/** A remote or branch name, as a ref on the lane. */
export function RefPill({ name }: { name: string }) {
  return (
    <span className="inline-flex h-4.5 shrink-0 items-center rounded-md bg-subtle px-1.5 font-mono text-meta font-medium whitespace-nowrap text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
      {name}
    </span>
  )
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        'size-3.5 shrink-0 text-tertiary transition-transform duration-(--duration-fast) motion-reduce:transition-none',
        open && 'rotate-90',
      )}
    />
  )
}

/** What an expanded row holds, under it on the lane. */
export function Kids({ children }: { children: ReactNode }) {
  return (
    <div role="group" data-git-kids="" className="flex flex-col pb-0.5">
      {children}
    </div>
  )
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

export function LineCounts({
  insertions,
  deletions,
}: {
  insertions: number | null
  deletions: number | null
}) {
  if (insertions === null || deletions === null) return null
  return (
    <span className="inline-flex shrink-0 gap-1.5 text-xs tabular">
      {insertions > 0 && <span className="text-success">+{insertions}</span>}
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
  const folder = slash < 0 ? '' : file.path.slice(0, slash + 1)
  const { letter, className } = STATUS_LETTER[file.status]
  return (
    <button
      type="button"
      tabIndex={-1}
      data-git-row=""
      className={KID}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      aria-label={t('timeline.openDiff', { name })}
      onKeyDown={kidKeys}
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
      <Lane top={lane} bottom={lane} node={null} className="mr-3" />
      <span className={cn('w-3 shrink-0 text-center font-mono text-meta font-medium', className)}>
        {letter}
      </span>
      <span className="min-w-0 truncate text-primary">{name}</span>
      <span className="min-w-0 flex-1 truncate text-tertiary">{folder}</span>
      <LineCounts insertions={file.insertions} deletions={file.deletions} />
    </button>
  )
}

function LoadingRows({ lane, count = 2 }: { lane: Segment; count?: number }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className={KID_STATIC}>
      <Lane top={lane} bottom={lane} node={null} className="mr-3" />
      <Skeleton className="h-3 w-3" />
      <Skeleton className="h-3 flex-1" style={{ maxWidth: `${70 - i * 18}%` }} />
    </div>
  ))
}

function ErrorRow({ lane, message }: { lane: Segment; message: string }) {
  return (
    <div className={cn(KID_STATIC, 'text-xs text-danger')} title={message}>
      <Lane top={lane} bottom={lane} node={null} className="mr-3" />
      <span className="min-w-0 truncate">{message.split('\n')[0]}</span>
    </div>
  )
}

/** Commits from a log, such as the ones to pull, with their author. */
function LogRows({ commits, lane }: { commits: LogCommit[]; lane: Segment }) {
  const now = useNow()
  return commits.map((c) => (
    <div key={c.oid} className={KID_STATIC}>
      <Lane top={lane} bottom={lane} node={null} className="mr-3" />
      <span className="shrink-0 font-mono text-meta text-tertiary">{c.oid.slice(0, 7)}</span>
      <span className="min-w-0 flex-1 truncate text-primary" title={c.subject}>
        {c.subject}
      </span>
      <span className="flex max-w-32 shrink-0 gap-1 text-xs text-tertiary tabular">
        <span className="min-w-0 truncate">{c.authorName}</span>
        <span className="shrink-0">· {shortAgo(c.authoredAt, now)}</span>
      </span>
    </div>
  ))
}

/** The branch's history as one lane of rows: to pull, uncommitted, commits, then the base. */
export function Timeline({ status, onOpened }: { status: GitStatus; onOpened: () => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() =>
    changesOpenFirst(status) ? new Set(['changes']) : new Set(),
  )
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

  const items = timelineItems(status, all)
  if (items.length === 0) return null

  return (
    <Part>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
        {items.map((item, i) => {
          const top = segmentBelow(items, i - 1)
          const bottom = segmentBelow(items, i)
          const key = itemKey(item)
          const lane = { top, bottom }
          switch (item.kind) {
            case 'incoming':
              return (
                <IncomingPart
                  key={key}
                  status={status}
                  count={item.count}
                  open={open.has(key)}
                  toggle={toggle(key)}
                  {...lane}
                />
              )
            case 'changes':
              return (
                <ChangesPart
                  key={key}
                  status={status}
                  files={item.files}
                  open={open.has(key)}
                  toggle={toggle(key)}
                  onOpened={onOpened}
                  {...lane}
                />
              )
            case 'commit':
              return (
                <CommitPart
                  key={key}
                  status={status}
                  commit={item.commit}
                  upstreamTip={item.upstreamTip}
                  open={open.has(key)}
                  toggle={toggle(key)}
                  warm={warm}
                  onCard={onCard}
                  onOpened={onOpened}
                  {...lane}
                />
              )
            case 'more':
              return <MoreRow key={key} count={item.count} onShow={() => setAll(true)} {...lane} />
            case 'base':
              return (
                <BasePart
                  key={key}
                  status={status}
                  count={item.count}
                  open={open.has(key)}
                  toggle={toggle(key)}
                  top={top}
                />
              )
          }
        })}
      </div>
    </Part>
  )
}

function itemKey(item: TimelineItem): string {
  return item.kind === 'commit' ? item.commit.oid : item.kind
}

function Count({ count }: { count: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-px text-xs text-secondary tabular">
      <ArrowDownIcon aria-hidden className="size-3" />
      {count}
    </span>
  )
}

function IncomingPart({
  status,
  count,
  open,
  toggle,
  top,
  bottom,
}: {
  status: GitStatus
  count: number
  open: boolean
  toggle: () => void
  top: Segment
  bottom: Segment
}) {
  const { t } = useTranslation('git')
  const incoming = useIncoming(status.projectPath, 'upstream', open)
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        data-git-row=""
        className={ROW}
        aria-expanded={open}
        title={t('timeline.incomingTitle', { upstream: status.upstream?.name })}
        onClick={toggle}
        onKeyDown={disclosureKeys(open, toggle)}
      >
        <Lane top={top} bottom={bottom} node="incoming" />
        <RefPill name={status.remote?.name ?? 'origin'} />
        <span className="min-w-0 flex-1 truncate">{t('timeline.incoming', { count })}</span>
        <Count count={count} />
        <Chevron open={open} />
      </button>
      {open && (
        <Kids>
          {incoming.data ? (
            <LogRows commits={incoming.data} lane={bottom} />
          ) : incoming.error ? (
            <ErrorRow lane={bottom} message={incoming.error} />
          ) : (
            <LoadingRows lane={bottom} count={Math.min(count, 3)} />
          )}
        </Kids>
      )}
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
        tabIndex={-1}
        data-git-row=""
        className={ROW}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={disclosureKeys(open, toggle)}
      >
        <Lane top={top} bottom={bottom} node="work" />
        <span className="min-w-0 flex-1 truncate">{t('timeline.uncommitted')}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-tertiary tabular">
          {t('timeline.files', { count: files })}
          <LineCounts insertions={insertions} deletions={deletions} />
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <Kids>
          {list.data ? (
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
          )}
        </Kids>
      )}
    </>
  )
}

/** Opens the row's context menu from the keyboard, under the row's start. */
function openMenuFromKeys(event: KeyboardEvent<HTMLElement>): boolean {
  if (!((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu')) return false
  // Prevented, Shift+F10 sends no contextmenu of its own where the platform has one.
  event.preventDefault()
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + 32,
      clientY: box.bottom,
    }),
  )
  return true
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
                  tabIndex={-1}
                  data-git-row=""
                  className={ROW}
                  aria-expanded={open}
                  onClick={toggle}
                  onKeyDown={(event) => {
                    if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'c') {
                      if (window.getSelection()?.toString()) return
                      event.preventDefault()
                      copyId()
                      return
                    }
                    if (openMenuFromKeys(event)) return
                    disclosureKeys(open, toggle)(event)
                  }}
                />
              }
            >
              <Lane top={top} bottom={bottom} node={commit.pushed ? 'pushed' : 'unpushed'} />
              <span className="shrink-0 font-mono text-meta text-tertiary">
                {commit.oid.slice(0, 7)}
              </span>
              <span
                className={cn('min-w-0 flex-1 truncate', commit.pushed && 'text-secondary')}
                title={commit.subject}
              >
                {commit.subject}
              </span>
              {upstreamTip && status.remote && <RefPill name={status.remote.name} />}
              <span
                className={cn(
                  'min-w-5.5 shrink-0 text-right text-xs text-tertiary tabular',
                  copied && 'text-secondary',
                )}
              >
                {copied ? t('timeline.copied') : shortAgo(commit.authoredAt, now)}
              </span>
            </HoverCardTrigger>
            <HoverCardContent
              side="left"
              align="start"
              sideOffset={14}
              alignOffset={-8}
              className="flex w-75 flex-col gap-1.25 pt-3 pr-3 pb-2 pl-3.5"
            >
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
      {open && (
        <Kids>
          {details.data ? (
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
          )}
        </Kids>
      )}
    </>
  )
}

/** A commit's whole message, author, date, files and id, beside the popover. */
function CommitCard({ status, commit }: { status: GitStatus; commit: CommitSummary }) {
  const { t } = useTranslation('git')
  const { data, error } = useCommit(status.projectPath, commit.oid, true)
  const insertions = data?.files.reduce((sum, f) => sum + (f.insertions ?? 0), 0) ?? 0
  const deletions = data?.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0) ?? 0
  return (
    <>
      <span data-selectable="" className="text-small font-semibold">
        {commit.subject}
      </span>
      {data?.body && (
        <p
          data-selectable=""
          className="max-h-40 overflow-y-auto text-xs leading-normal whitespace-pre-wrap text-secondary [overflow-wrap:anywhere]"
        >
          {data.body}
        </p>
      )}
      {!data && !error && <Skeleton className="my-0.5 h-3 w-40" />}
      <span data-selectable="" className="text-xs text-tertiary">
        {data ? `${data.authorName} · ` : ''}
        {fullTime(commit.authoredAt)}
      </span>
      <Separator className="mt-1.25 bg-border-soft" />
      <div className="-mr-1.5 flex items-center gap-1.5 text-xs text-tertiary tabular">
        <span className={cn('min-w-0 truncate', error && 'text-danger')} title={error ?? undefined}>
          {data ? t('timeline.files', { count: data.files.length }) : (error?.split('\n')[0] ?? '')}
        </span>
        {data && <LineCounts insertions={insertions} deletions={deletions} />}
        <span data-selectable="" className="ml-auto font-mono text-meta text-secondary">
          {commit.oid.slice(0, 7)}
        </span>
        <CopyButton text={commit.oid} label={t('timeline.copyId')} />
      </div>
    </>
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
    <button
      type="button"
      tabIndex={-1}
      data-git-row=""
      className={cn(ROW, 'text-tertiary')}
      onClick={onShow}
    >
      <Lane top={top} bottom={bottom} node={null} />
      <span className="text-xs">{t('timeline.more', { count })}</span>
    </button>
  )
}

function BasePart({
  status,
  count,
  open,
  toggle,
  top,
}: {
  status: GitStatus
  count: number
  open: boolean
  toggle: () => void
  top: Segment
}) {
  const { t } = useTranslation('git')
  const name = status.defaultBranch ?? status.base?.name ?? ''
  const incoming = useIncoming(status.projectPath, 'base', open && count > 0)
  const label = (
    <>
      <Lane top={top} bottom={null} node="base" />
      <RefPill name={name} />
      <span className="min-w-0 flex-1 truncate text-secondary">
        {count > 0 ? t('timeline.baseAhead', { count }) : t('timeline.baseEven')}
      </span>
    </>
  )
  if (count === 0) {
    return <div className="flex h-row min-w-0 items-center gap-2 px-2 text-small">{label}</div>
  }
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        data-git-row=""
        className={ROW}
        aria-expanded={open}
        title={status.base?.name}
        onClick={toggle}
        onKeyDown={disclosureKeys(open, toggle)}
      >
        {label}
        <Count count={count} />
        <Chevron open={open} />
      </button>
      {open && (
        <Kids>
          {incoming.data ? (
            <LogRows commits={incoming.data} lane={null} />
          ) : incoming.error ? (
            <ErrorRow lane={null} message={incoming.error} />
          ) : (
            <LoadingRows lane={null} count={Math.min(count, 3)} />
          )}
        </Kids>
      )}
    </>
  )
}
