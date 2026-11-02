import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CopyIcon, ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, CommitSummary, GitStatus } from '@shared/git'
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
import { ChangeBadge } from '@renderer/features/files/change-badge'
import { fullTime, shortAgo } from '@renderer/lib/format'
import { isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { openDiff } from '@renderer/stores/files'
import { CopyButton } from './copy-button'
import { disclosureKeys, kidKeys } from './popover-keys'
import { projectRelative } from './sync'
import { loadCommit, useCommit } from './use-git-data'

/**
 * A row of the popover, bleeding into its padding. The highlight is focus, which follows the
 * pointer too, so the pointer and the arrow keys share one.
 */
export const ROW =
  '-mx-1.5 flex w-[calc(100%+--spacing(3))] min-w-0 items-center rounded-tile px-1.5 text-left outline-none transition-colors duration-(--duration-fast) focus:bg-hover data-[popup-open]:bg-hover in-data-[popup-open]:bg-hover'

/** A part's label row: its name and count, and an action at the end. */
export function PartHead({ children }: { children: ReactNode }) {
  return <div className="flex h-7 items-center gap-2 text-small text-tertiary">{children}</div>
}

/** The hairline between the popover's parts, edge to edge. */
export function PartRule() {
  return <div aria-hidden className="-mx-3.5 my-2.5 h-px bg-border-soft" />
}

/** "+48 −6", in mono, the parts that are none left out. */
export function LineCounts({
  insertions,
  deletions,
  className,
}: {
  insertions: number | null
  deletions: number | null
  className?: string
}) {
  if (insertions === null || deletions === null) return null
  return (
    <span className={cn('inline-flex shrink-0 gap-1 font-mono text-code-sm tabular', className)}>
      <span className="text-success">+{insertions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  )
}

/** A changed file: its tile, name and folder; it opens its diff in the Files pane. */
export function ChangeRow({
  status,
  file,
  commit,
  nested = false,
  onOpened,
}: {
  status: GitStatus
  file: ChangedFile
  /** The commit it changed in, or null for the working tree. */
  commit: string | null
  nested?: boolean
  onOpened: () => void
}) {
  const { t } = useTranslation('git')
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  const folder = slash < 0 ? '' : file.path.slice(0, slash)
  return (
    <button
      type="button"
      tabIndex={-1}
      data-git-row=""
      className={cn(ROW, 'h-7 gap-2.25', nested && 'pl-5.5')}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      aria-label={t('timeline.openDiff', { name })}
      onKeyDown={nested ? kidKeys : undefined}
      onClick={() => {
        const root = status.repo?.root ?? status.projectPath
        openDiff(status.projectPath, {
          path: file.path,
          oldPath: file.oldPath,
          ref: commit,
          projectFile:
            file.status === 'deleted' ? null : projectRelative(root, status.projectPath, file.path),
        })
        onOpened()
      }}
    >
      <ChangeBadge status={file.status} />
      <span className="min-w-0 shrink truncate text-ui text-primary">{name}</span>
      <span className="min-w-0 flex-1 truncate text-small text-tertiary">{folder}</span>
      {nested && <LineCounts insertions={file.insertions} deletions={file.deletions} />}
    </button>
  )
}

export function LoadingRows({ count = 2 }: { count?: number }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="flex h-7 items-center gap-2.25">
      <Skeleton className="size-3.75" />
      <Skeleton className="h-3 flex-1" style={{ maxWidth: `${70 - i * 18}%` }} />
    </div>
  ))
}

export function ErrorRow({ message }: { message: string }) {
  return (
    <p className="flex h-7 items-center truncate text-small text-danger" title={message}>
      {message.split('\n')[0]}
    </p>
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

/** The branch's commits, newest first; each unfolds to its files, with its card on hover. */
export function CommitRows({
  status,
  commits,
  onOpened,
}: {
  status: GitStatus
  commits: readonly CommitSummary[]
  onOpened: () => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  // Once one commit's card shows, the next opens at once, as VS Code's hover groups do.
  const [warm, setWarm] = useState(false)
  const cooling = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCard = (shown: boolean): void => {
    if (cooling.current) clearTimeout(cooling.current)
    if (shown) setWarm(true)
    else cooling.current = setTimeout(() => setWarm(false), 300)
  }
  const toggle = (oid: string) => () =>
    setOpen((now) => {
      const next = new Set(now)
      if (next.has(oid)) next.delete(oid)
      else next.add(oid)
      return next
    })
  return commits.map((commit) => (
    <CommitRow
      key={commit.oid}
      status={status}
      commit={commit}
      open={open.has(commit.oid)}
      toggle={toggle(commit.oid)}
      warm={warm}
      onCard={onCard}
      onOpened={onOpened}
    />
  ))
}

function CommitRow({
  status,
  commit,
  open,
  toggle,
  warm,
  onCard,
  onOpened,
}: {
  status: GitStatus
  commit: CommitSummary
  open: boolean
  toggle: () => void
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
                  className={cn(ROW, 'h-6.5 gap-2.5')}
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
              <span className="shrink-0 font-mono text-code-sm text-tertiary">
                {commit.oid.slice(0, 7)}
              </span>
              <span className="min-w-0 flex-1 truncate text-hint text-primary">
                {commit.subject}
              </span>
              <span
                className={cn(
                  'shrink-0 text-small text-tertiary tabular',
                  copied && 'text-secondary',
                )}
              >
                {copied ? t('timeline.copied') : shortAgo(commit.authoredAt, now)}
              </span>
            </HoverCardTrigger>
            <HoverCardContent
              side="left"
              align="start"
              sideOffset={20}
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
        <div role="group" data-git-kids="" className="flex flex-col">
          {details.data ? (
            details.data.files.map((file) => (
              <ChangeRow
                key={file.path}
                status={status}
                file={file}
                commit={commit.oid}
                nested
                onOpened={onOpened}
              />
            ))
          ) : details.error ? (
            <ErrorRow message={details.error} />
          ) : (
            <LoadingRows />
          )}
        </div>
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
        <span data-selectable="" className="ml-auto font-mono text-code-sm text-secondary">
          {commit.oid.slice(0, 7)}
        </span>
        <CopyButton text={commit.oid} label={t('timeline.copyId')} />
      </div>
    </>
  )
}
