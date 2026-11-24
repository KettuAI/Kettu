import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, GitStatus } from '@shared/git'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ChangeBadge } from '@renderer/features/files/change-badge'
import { cn } from '@renderer/lib/utils'
import { openChangeDiff } from './open-change-diff'
import { kidKeys } from './popover-keys'

/**
 * A row of the popover, bleeding into its padding. The highlight is focus, which follows the
 * pointer too, so the pointer and the arrow keys share one.
 */
export const ROW =
  '-mx-1.5 flex w-[calc(100%+--spacing(3))] min-w-0 items-center rounded-tile px-1.5 text-left outline-none transition-colors duration-(--duration-fast) focus:bg-hover data-[popup-open]:bg-hover in-data-[popup-open]:bg-hover'

/** A part's label row: its name and count, and an action at the end. */
export function PartHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-1.75 text-small font-medium text-secondary">
      {children}
    </div>
  )
}

/** The number beside a part's name. */
export function Count({ children }: { children: ReactNode }) {
  return (
    <span className="h-4.25 min-w-4.5 rounded-full bg-selected px-1.25 text-center text-caption leading-4.25 font-medium text-tertiary tabular">
      {children}
    </span>
  )
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

/**
 * Five squares in the share of added and removed lines, each side at least one square when it has
 * any lines at all; none for a change with no lines to count.
 */
function barOf(insertions: number, deletions: number): ('added' | 'removed')[] {
  const total = insertions + deletions
  if (total === 0) return []
  let added = Math.round((5 * insertions) / total)
  if (insertions > 0 && added === 0) added = 1
  if (deletions > 0 && added === 5) added = 4
  return Array.from({ length: 5 }, (_, i) => (i < added ? 'added' : 'removed'))
}

export function LineBar({ insertions, deletions }: { insertions: number; deletions: number }) {
  const squares = barOf(insertions, deletions)
  if (squares.length === 0) return null
  return (
    <span aria-hidden className="inline-flex shrink-0 gap-[1.5px]">
      {squares.map((square, i) => (
        <i
          key={i}
          className={cn(
            'h-2.5 w-1 rounded-[1.5px]',
            square === 'added' ? 'bg-success' : 'bg-danger',
          )}
        />
      ))}
    </span>
  )
}

/** A changed file: its tile, name, folder and line counts; it opens its diff in a tab. */
export function ChangeRow({
  status,
  file,
  commit,
  nested = false,
  fromPanel = false,
  onOpened,
}: {
  status: GitStatus
  file: ChangedFile
  /** The commit it changed in, or null for the working tree. */
  commit: string | null
  nested?: boolean
  /** A row of the Git pane, whose diff opens right after the pane's tab. */
  fromPanel?: boolean
  onOpened: () => void
}) {
  const { t } = useTranslation('git')
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  // The two folders nearest the file say enough; the tooltip has the whole path.
  const folder = slash < 0 ? '' : file.path.slice(0, slash).split('/').slice(-2).join('/')
  const conflicted = file.status === 'conflicted'
  return (
    <button
      type="button"
      tabIndex={-1}
      data-git-row=""
      className={cn(ROW, 'h-7.5 gap-2.25', nested && 'pl-8')}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      aria-label={t('timeline.openDiff', { name })}
      onKeyDown={nested ? kidKeys : undefined}
      onClick={() => {
        openChangeDiff(status, file, commit, { preview: true, fromPanel })
        onOpened()
      }}
      onDoubleClick={() => openChangeDiff(status, file, commit, { fromPanel })}
    >
      <ChangeBadge status={file.status} />
      <span className="min-w-0 shrink truncate text-ui text-primary">{name}</span>
      <span className="min-w-0 flex-1 truncate text-small text-tertiary">{folder}</span>
      {conflicted ? (
        <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-danger/11 px-1.75 text-caption font-medium text-danger">
          {t('popover.conflict')}
        </span>
      ) : (
        <>
          <LineCounts insertions={file.insertions} deletions={file.deletions} />
          {!nested && file.insertions !== null && file.deletions !== null && (
            <LineBar insertions={file.insertions} deletions={file.deletions} />
          )}
        </>
      )}
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
