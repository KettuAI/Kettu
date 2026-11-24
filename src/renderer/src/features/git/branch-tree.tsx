import { useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  CloudUploadIcon,
  Copy01Icon,
  LinkSquare02Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { CommitSummary, GitStatus } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
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
import { Spinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { fullTime, longAgo } from '@renderer/lib/format'
import { isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useGitStore } from '@renderer/stores/git'
import { CopyButton } from './copy-button'
import { disclosureKeys } from './popover-keys'
import { ChangeRow, Count, ErrorRow, LineCounts, LoadingRows, PartHead, ROW } from './rows'
import { pushFromPopover } from './steps'
import { useCommitCards, type Cards } from './commit-cards'
import { planSync, pushTargetOf, PUSH_LABEL, PUSHING, type OperationKind } from './sync'
import { loadCommit, useCommit } from './use-git-data'

/** Commits shown before "N more": the newest local ones, and the nearest pushed one. */
const LOCAL_SHOWN = 3
const PUSHED_SHOWN = 1

/** The grid every row of the tree shares: the rail's column, then the text. */
export const TREE_GRID = 'grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2'

type DotKind = 'local' | 'pushed' | 'pull' | 'gap' | 'base'

const DOT: Record<DotKind, string> = {
  local: 'bg-(--composer-card) shadow-[0_0_0_1.5px_var(--primary-foreground)]',
  pushed: 'bg-(--text-tertiary) shadow-[0_0_0_1.5px_var(--text-tertiary)]',
  pull: 'bg-(--composer-card) shadow-[0_0_0_1.5px_var(--warning)]',
  gap: 'top-[calc(50%-1.5px)] left-1.5 size-1 bg-(--text-placeholder)',
  base: 'rounded-[3px] bg-(--composer-card) shadow-[0_0_0_1.5px_var(--text-placeholder)]',
}

/** A mark on the rail, in the column left of a row's text; `high` keeps it by a row's first line. */
export function Dot({ kind, high = false }: { kind: DotKind; high?: boolean }) {
  return (
    <span aria-hidden className="relative self-stretch">
      <i
        className={cn(
          'absolute left-[3px] size-2.75 rounded-full',
          high ? 'top-3' : 'top-[calc(50%-5.5px)]',
          DOT[kind],
        )}
      />
    </span>
  )
}

/** A line of the tree that is not a commit. */
export function TreeLine({
  kind,
  children,
  end,
  onClick,
}: {
  kind: DotKind
  children: ReactNode
  end?: ReactNode
  onClick?: () => void
}) {
  const body = (
    <>
      <Dot kind={kind} />
      <span className="min-w-0 truncate text-control">{children}</span>
      {end && <span className="shrink-0 text-caption text-placeholder">{end}</span>}
    </>
  )
  const frame = cn(ROW, TREE_GRID, 'min-h-7')
  if (!onClick) return <div className={frame}>{body}</div>
  return (
    <button
      type="button"
      tabIndex={-1}
      data-git-row=""
      className={cn(frame, 'text-placeholder')}
      onClick={onClick}
    >
      {body}
    </button>
  )
}

/**
 * The branch's commits as a short tree, the newest on top: the local ones, a push line that
 * says what only this computer has, the pushed ones, and where the branch left the default one.
 */
export function BranchTree({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation('git')
  const gh = useGitStore((s) => s.tools?.gh.state ?? null)
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const cards = useCommitCards()
  const [all, setAll] = useState(false)
  const behind = status.upstream?.behind ?? 0
  const local = status.commits.filter((commit) => !commit.pushed)
  const pushed = status.commits.filter((commit) => commit.pushed)
  if (status.commits.length === 0 && behind === 0) return null

  const plan = planSync(status, gh)
  const { head, upstream, defaultBranch } = status
  const remote = pushTargetOf(status)?.remote ?? status.remote?.name ?? ''
  const published = upstream !== null
  const showLocal = all ? local : local.slice(0, LOCAL_SHOWN)
  const showPushed = all ? pushed : pushed.slice(0, PUSHED_SHOWN)
  const hiddenLocal = local.length - showLocal.length
  const hiddenPushed = pushed.length - showPushed.length
  const onDefault = head.branch !== null && head.branch === defaultBranch
  // Nothing to push to from a diverged branch, a stopped operation or without a way to push.
  const pushKind = plan.push.kind
  const action =
    plan.push.enabled &&
    behind === 0 &&
    (pushKind === 'push' || pushKind === 'publishBranch' || pushKind === 'publishRepo')
      ? pushKind
      : null
  const attention = (local.length > 0 || !published) && behind === 0

  return (
    <section className="mt-4">
      <PartHead>
        <span>{t('popover.onBranch')}</span>
        <Count>{status.commits.length}</Count>
        <span className="flex-1" />
        <span className="font-normal text-placeholder">{t('tree.newestFirst')}</span>
      </PartHead>
      <div className="relative mt-0.5">
        <span
          aria-hidden
          className="absolute top-3.5 bottom-3.5 left-[8.25px] w-[1.5px] bg-border-strong"
        />
        {behind > 0 && (
          <TreeLine kind="pull" end={t('tree.notPulled')}>
            <span className="text-tertiary">
              {t('tree.newOnRemote', { count: behind, remote })}
            </span>
          </TreeLine>
        )}
        {showLocal.map((commit) => (
          <CommitRow
            key={commit.oid}
            status={status}
            commit={commit}
            cards={cards}
            onOpened={onClose}
          />
        ))}
        {hiddenLocal > 0 && (
          <TreeLine kind="gap" onClick={() => setAll(true)}>
            {t('tree.moreLocal', { count: hiddenLocal })}
          </TreeLine>
        )}
        {!status.operation && (
          <PushLine
            status={status}
            remote={remote}
            localCount={local.length}
            behind={behind}
            published={published}
            attention={attention}
            action={action}
            busy={running !== null && PUSHING.has(running.kind)}
            label={action ? t(PUSH_LABEL[action]) : ''}
            onPush={() => action && pushFromPopover(status, action, onClose)}
          />
        )}
        {showPushed.map((commit) => (
          <CommitRow
            key={commit.oid}
            status={status}
            commit={commit}
            cards={cards}
            onOpened={onClose}
          />
        ))}
        {hiddenPushed > 0 && (
          <TreeLine kind="gap" onClick={() => setAll(true)}>
            {t('tree.morePushed', { count: hiddenPushed })}
          </TreeLine>
        )}
        {defaultBranch && !onDefault && (
          <TreeLine kind="base">
            <span className="text-tertiary">
              {t('tree.from')} <span className="font-mono text-code-sm">{defaultBranch}</span>
            </span>
          </TreeLine>
        )}
      </div>
    </section>
  )
}

/** The dashed line between the local commits and the pushed ones, with its Push or Publish. */
export function PushLine({
  status,
  remote,
  localCount,
  behind,
  published,
  attention,
  action,
  busy,
  label,
  onPush,
}: {
  status: GitStatus
  remote: string
  localCount: number
  behind: number
  published: boolean
  attention: boolean
  action: OperationKind | null
  busy: boolean
  label: string
  onPush: () => void
}) {
  const { t } = useTranslation('git')
  const hasRemote = status.push?.kind !== 'noRemote'
  return (
    <div
      className={cn('-mx-1.5 grid h-8 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2 px-1.5')}
    >
      <span aria-hidden />
      <div className="relative flex h-full items-center before:absolute before:inset-x-0 before:top-1/2 before:border-t-[1.5px] before:border-dashed before:border-strong">
        <span
          className={cn(
            'relative z-1 inline-flex h-5.5 min-w-0 items-center gap-1.5 rounded-full bg-surface px-2.25 text-caption whitespace-nowrap text-secondary shadow-outline',
            attention &&
              'bg-[color-mix(in_srgb,var(--primary-foreground)_9%,var(--bg-surface))] text-(--primary-foreground) shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary-foreground)_22%,transparent)]',
          )}
        >
          {!hasRemote ? (
            <>
              <Glyph icon={CloudUploadIcon} size={12} className="shrink-0" />
              <span className="truncate">{t('tree.noRemote')}</span>
            </>
          ) : !published ? (
            <>
              <Glyph icon={CloudUploadIcon} size={12} className="shrink-0" />
              <span className="truncate">{t('tree.notPublished', { remote })}</span>
            </>
          ) : localCount > 0 ? (
            <>
              <Glyph icon={CloudUploadIcon} size={12} className="shrink-0" />
              <span className="font-mono">{remote}</span>
              <span className="truncate">· {t('tree.onlyHere', { count: localCount })}</span>
            </>
          ) : behind > 0 ? (
            <>
              <Glyph icon={CloudUploadIcon} size={12} className="shrink-0" />
              <span className="font-mono">{remote}</span>
              <span className="truncate">· {t('tree.behind', { count: behind })}</span>
            </>
          ) : (
            <>
              <Glyph icon={Tick02Icon} size={12} className="shrink-0 text-success" />
              <span className="font-mono">{remote}</span>
              <span>· {t('tree.inSync')}</span>
            </>
          )}
        </span>
        {action && (
          <span className="relative z-1 ml-auto rounded-md bg-(--composer-card)">
            <Button
              variant="ghost"
              size="xs"
              data-git-row=""
              tabIndex={-1}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={onPush}
              className="px-2 text-(--primary-foreground) hover:text-(--primary-foreground) disabled:opacity-100"
            >
              {busy ? <Spinner className="size-3" /> : <Glyph icon={CloudUploadIcon} size={12} />}
              {label}
            </Button>
          </span>
        )}
      </div>
    </div>
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

export function CommitRow({
  status,
  commit,
  cards,
  onOpened,
  pane = false,
}: {
  status: GitStatus
  commit: CommitSummary
  cards: Cards
  onOpened: () => void
  /** The Git pane's row: a second line with the commit's author, id and files, and its lines. */
  pane?: boolean
}) {
  const { t } = useTranslation('git')
  const now = useNow()
  const [copied, setCopied] = useState(false)
  const open = cards.open.has(commit.oid)
  const toggle = cards.toggle(commit.oid)
  const details = useCommit(status.projectPath, commit.oid, open || pane)
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
          <HoverCard onOpenChange={cards.onCard}>
            <HoverCardTrigger
              delay={cards.warm ? 0 : 500}
              closeDelay={150}
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  data-git-row=""
                  className={cn(ROW, TREE_GRID, pane ? 'items-start py-1.25' : 'min-h-7')}
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
              <Dot kind={commit.pushed ? 'pushed' : 'local'} high={pane} />
              {pane ? (
                <>
                  <span className="min-w-0">
                    <span className="block truncate text-control text-primary">
                      {commit.subject}
                    </span>
                    <span className="mt-0.5 flex min-w-0 gap-2 text-caption text-placeholder">
                      <span className="shrink-0 font-mono text-code-sm text-tertiary">
                        {commit.oid.slice(0, 7)}
                      </span>
                      {details.data && (
                        <span className="min-w-0 truncate">{details.data.authorName}</span>
                      )}
                      <span className="shrink-0">
                        {copied ? t('timeline.copied') : longAgo(commit.authoredAt, now)}
                      </span>
                      {details.data && (
                        <span className="shrink-0">
                          {t('timeline.files', { count: details.data.files.length })}
                        </span>
                      )}
                    </span>
                  </span>
                  {details.data && (
                    <LineCounts
                      insertions={details.data.files.reduce((n, f) => n + (f.insertions ?? 0), 0)}
                      deletions={details.data.files.reduce((n, f) => n + (f.deletions ?? 0), 0)}
                    />
                  )}
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate text-control text-primary">
                    {commit.subject}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-caption text-placeholder tabular',
                      copied && 'text-secondary',
                    )}
                  >
                    {copied ? t('timeline.copied') : longAgo(commit.authoredAt, now)}
                  </span>
                </>
              )}
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
            <Glyph icon={Copy01Icon} />
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
            <Glyph icon={Copy01Icon} />
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
                <Glyph icon={LinkSquare02Icon} />
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
                fromPanel={pane}
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
