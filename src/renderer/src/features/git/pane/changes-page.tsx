import { useEffect, useId, useMemo, useState, type RefObject } from 'react'
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  File01Icon,
  LinkSquare02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, GitStatus } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ChangeBadge } from '@renderer/features/files/change-badge'
import { Diff } from '@renderer/features/session/markdown'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import {
  openGitDialog,
  setLeftOut,
  takeCommitAsk,
  updateCommitBox,
  useGitStore,
} from '@renderer/stores/git'
import { diffId, openFile } from '@renderer/stores/files'
import { useViewStore } from '@renderer/stores/view'
import { openChangeDiff } from '../open-change-diff'
import { ErrorRow, LineBar, LineCounts, PartHead, Count } from '../rows'
import { projectRelative } from '../sync'
import { type Loaded, useFileDiff } from '../use-git-data'
import { committable, leftOutExcept, tickState, toggled } from './commit-selection'
import { prepareInlineDiff, pruneExpandedPaths, toggleExpandedPath } from './inline-diff-model'

const NO_PATHS: readonly string[] = []
const EMPTY_OPEN: ReadonlySet<string> = new Set()

// Opening a full diff or file from a row keeps a dedicated tab right after the Git tab.
const KEPT = { fromPanel: true }

/** The working tree's changed files, ticked for the next commit; each row expands its diff inline. */
export function ChangesPage({
  panel,
  status,
  changes,
  textarea,
}: {
  /** The side panel the pane shows in, whose row the diffs open in. */
  panel: string
  status: GitStatus
  changes: Loaded<ChangedFile[]>
  /** The commit box's field, which an opener's wish for the box focuses. */
  textarea: RefObject<HTMLTextAreaElement | null>
}) {
  const { t } = useTranslation('git')
  const { projectPath } = status
  const { data, error } = changes
  const leftOut = useGitStore((s) => s.leftOut[projectPath] ?? NO_PATHS)
  const ask = useGitStore((s) => s.commitAsk[projectPath])
  // The change the panel's diff tab shows or showed last, whose row is marked.
  const shown = useViewStore((s) => s.sideDoc[panel])
  const blocked = !!status.operation || status.changes.conflicted > 0
  const [expandedState, setExpandedState] = useState<{
    projectPath: string
    paths: ReadonlySet<string>
  }>(() => ({ projectPath, paths: EMPTY_OPEN }))

  // An opener, such as the popover's Commit…, picks the files and takes the box's focus.
  useEffect(() => {
    if (!data || !ask) return
    const taken = takeCommitAsk(projectPath)
    if (!taken) return
    setLeftOut(projectPath, leftOutExcept(data, taken.only))
    updateCommitBox(projectPath, { andPush: taken.andPush })
    requestAnimationFrame(() => textarea.current?.focus())
  }, [data, ask, projectPath, textarea])

  const files = useMemo(
    () =>
      (data ?? []).toSorted((a, b) => +(b.status === 'conflicted') - +(a.status === 'conflicted')),
    [data],
  )
  const expandedPaths = useMemo(() => {
    const current = expandedState.projectPath === projectPath ? expandedState.paths : EMPTY_OPEN
    return pruneExpandedPaths(current, files)
  }, [expandedState, projectPath, files])

  if (!data) {
    return error ? (
      <div className="px-1">
        <ErrorRow message={error} />
      </div>
    ) : (
      <Loading />
    )
  }
  if (files.length === 0) {
    return (
      <div className="grid flex-1 place-items-center content-center gap-1.5 px-6 py-10 text-center">
        <span className="grid size-10 place-items-center rounded-xl bg-subtle text-icon">
          <Glyph icon={CheckmarkCircle02Icon} size={18} />
        </span>
        <b className="text-row font-semibold">{t('pane.changes.emptyTitle')}</b>
        <p className="max-w-72 text-small text-tertiary">{t('pane.changes.emptyText')}</p>
      </div>
    )
  }

  const conflicted = files.filter((file) => file.status === 'conflicted')
  const clean = committable(files)
  const state = tickState(files, leftOut)
  const insertions = clean.reduce((n, file) => n + (file.insertions ?? 0), 0)
  const deletions = clean.reduce((n, file) => n + (file.deletions ?? 0), 0)
  const ticked = clean.filter((file) => !leftOut.includes(file.path))
  const toggleOpen = (path: string): void => {
    setExpandedState((prev) => {
      const base =
        prev.projectPath === projectPath ? pruneExpandedPaths(prev.paths, files) : EMPTY_OPEN
      return { projectPath, paths: toggleExpandedPath(base, path) }
    })
  }

  return (
    <div className="flex flex-col gap-0.5">
      {conflicted.length > 0 && (
        <>
          <PartHead>
            <span className="text-danger">{t('pane.changes.conflicts')}</span>
            <Count>{conflicted.length}</Count>
          </PartHead>
          {conflicted.map((file) => (
            <FileEntry
              key={file.path}
              status={status}
              file={file}
              ticked={false}
              expanded={expandedPaths.has(file.path)}
              shown={shown === `diff:${diffId({ path: file.path, ref: null })}`}
              onTick={() => {}}
              onToggle={() => toggleOpen(file.path)}
              blocked={blocked}
            />
          ))}
        </>
      )}
      {clean.length > 0 && (
        <>
          <div className="mt-1 mb-0.5 flex h-7 items-center gap-2 px-2 text-small text-tertiary">
            <Checkbox
              checked={state === 'all'}
              indeterminate={state === 'some'}
              aria-label={t('pane.changes.tickAll')}
              onCheckedChange={() =>
                setLeftOut(projectPath, state === 'all' ? clean.map((f) => f.path) : [])
              }
            />
            <span className="font-medium text-primary">
              {t('timeline.files', { count: clean.length })}
            </span>
            <LineCounts insertions={insertions} deletions={deletions} />
            <span className="flex-1" />
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button
                  variant="quiet"
                  size="xs"
                  disabled={ticked.length === 0 || blocked}
                  onClick={() =>
                    openGitDialog(projectPath, {
                      kind: 'discard',
                      paths: ticked.map((f) => f.path),
                    })
                  }
                  className="text-danger hover:text-danger"
                >
                  {t('pane.changes.discard')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {blocked ? t('pane.changes.discardBlocked') : t('pane.changes.discardTicked')}
              </TooltipContent>
            </Tooltip>
          </div>
          {clean.map((file) => (
            <FileEntry
              key={file.path}
              status={status}
              file={file}
              ticked={!leftOut.includes(file.path)}
              expanded={expandedPaths.has(file.path)}
              shown={shown === `diff:${diffId({ path: file.path, ref: null })}`}
              onTick={(on) => setLeftOut(projectPath, toggled(leftOut, file.path, on))}
              onToggle={() => toggleOpen(file.path)}
              blocked={blocked}
            />
          ))}
        </>
      )}
    </div>
  )
}

function Loading() {
  return (
    <div className="flex flex-col gap-1.5 px-2" aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-2.5">
          <Skeleton className="size-4" />
          <Skeleton className="h-3 flex-1" style={{ maxWidth: `${72 - i * 9}%` }} />
        </div>
      ))}
    </div>
  )
}

/** One changed file: its tick, name and line counts, with an inline diff below while expanded. */
function FileEntry({
  status,
  file,
  ticked,
  expanded,
  shown,
  onTick,
  onToggle,
  blocked,
}: {
  status: GitStatus
  file: ChangedFile
  ticked: boolean
  expanded: boolean
  /** The panel's diff tab shows this file's change. */
  shown: boolean
  onTick: (on: boolean) => void
  onToggle: () => void
  blocked: boolean
}) {
  const { t } = useTranslation('git')
  const panelId = useId()
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  // The two folders nearest the file say enough; the tooltip has the whole path.
  const folder = slash < 0 ? '' : file.path.slice(0, slash).split('/').slice(-2).join('/')
  const conflicted = file.status === 'conflicted'
  const inProject =
    file.status === 'deleted'
      ? null
      : projectRelative(status.repo?.root ?? status.projectPath, status.projectPath, file.path)
  const openDiffTab = (): void => openChangeDiff(status, file, null, KEPT)
  const openProjectFile = (): void => {
    if (inProject !== null) openFile(status.projectPath, inProject, null, KEPT)
  }
  const discardFile = (): void => {
    openGitDialog(status.projectPath, { kind: 'discard', paths: [file.path] })
  }

  return (
    <div
      data-file-entry={file.path}
      data-expanded={expanded || undefined}
      aria-current={shown || undefined}
      className={cn(
        'group/file rounded-xl transition-colors',
        expanded && 'my-1 bg-card shadow-card',
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className={cn(
                'flex h-8 items-center gap-2 rounded-xl px-2 transition-colors',
                !expanded && 'focus-within:bg-hover hover:bg-hover',
                shown && !expanded && 'bg-selected',
              )}
            />
          }
        >
          <Checkbox
            checked={ticked}
            disabled={conflicted}
            aria-label={t('pane.changes.tick', { name })}
            onCheckedChange={onTick}
          />
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={t(expanded ? 'pane.changes.collapseDiff' : 'pane.changes.expandDiff', {
              name,
            })}
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            onClick={onToggle}
            className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:focus-ring"
          >
            <Glyph
              icon={ArrowRight01Icon}
              size={12}
              className={cn(
                'shrink-0 text-placeholder transition-transform duration-(--duration-fast) motion-reduce:transition-none',
                expanded && 'rotate-90 text-secondary',
              )}
            />
            <ChangeBadge status={file.status} />
            <span className="min-w-0 shrink truncate text-ui text-primary">{name}</span>
            <span className="min-w-0 flex-1 truncate text-small text-tertiary">{folder}</span>
          </button>
          <span
            className={cn(
              'hidden shrink-0 items-center group-focus-within/file:flex group-hover/file:flex',
              expanded && 'flex',
            )}
          >
            <RowAction
              label={t('pane.changes.openDiffTab')}
              icon={LinkSquare02Icon}
              onClick={openDiffTab}
            />
            {inProject !== null && (
              <RowAction
                label={t('pane.changes.openInFiles')}
                icon={File01Icon}
                onClick={openProjectFile}
              />
            )}
            {!conflicted && (
              <RowAction
                label={t('pane.changes.discardFile')}
                icon={Delete02Icon}
                disabled={blocked}
                onClick={discardFile}
              />
            )}
          </span>
          {conflicted ? (
            <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-danger/11 px-1.75 text-caption font-medium text-danger">
              {t('popover.conflict')}
            </span>
          ) : (
            <>
              <LineCounts insertions={file.insertions} deletions={file.deletions} />
              {!expanded && file.insertions !== null && file.deletions !== null && (
                <span className="group-focus-within/file:hidden group-hover/file:hidden">
                  <LineBar insertions={file.insertions} deletions={file.deletions} />
                </span>
              )}
            </>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onToggle}>
            <Glyph icon={ArrowRight01Icon} size={14} className={cn(expanded && 'rotate-90')} />
            {t(expanded ? 'pane.changes.collapseInline' : 'pane.changes.expandInline')}
          </ContextMenuItem>
          <ContextMenuItem onClick={openDiffTab}>
            <Glyph icon={LinkSquare02Icon} size={14} />
            {t('pane.changes.openDiffTab')}
          </ContextMenuItem>
          {inProject !== null && (
            <ContextMenuItem onClick={openProjectFile}>
              <Glyph icon={File01Icon} size={14} />
              {t('pane.changes.openInFiles')}
            </ContextMenuItem>
          )}
          {!conflicted && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" disabled={blocked} onClick={discardFile}>
                <Glyph icon={Delete02Icon} size={14} />
                {t('pane.changes.discardFile')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <InlineDiff id={panelId} name={name} status={status} file={file} onOpenTab={openDiffTab} />
      )}
    </div>
  )
}

function RowAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string
  icon: typeof Delete02Icon
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation()
              onClick()
            }}
            className="text-tertiary"
          />
        }
      >
        <Glyph icon={icon} size={13} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Lazily loaded, height-capped scrollable inline diff preview shown directly below a file row. */
function InlineDiff({
  id,
  name,
  status,
  file,
  onOpenTab,
}: {
  id: string
  name: string
  status: GitStatus
  file: ChangedFile
  onOpenTab: () => void
}) {
  const { t } = useTranslation('git')
  const { data, error, retry } = useFileDiff(status.projectPath, file, true)
  const view = useMemo(() => prepareInlineDiff(file, data, error), [file, data, error])

  let body
  if (view.kind === 'loading') {
    body = (
      <div className="flex flex-col gap-1.5 px-3 py-3" aria-busy="true">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    )
  } else if (view.kind === 'error') {
    body = (
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <ErrorRow message={view.error} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="xs" onClick={retry}>
            {t('pane.changes.retry')}
          </Button>
          <Button variant="quiet" size="xs" onClick={onOpenTab}>
            {t('pane.changes.openFullDiff')}
          </Button>
        </div>
      </div>
    )
  } else if (view.kind !== 'diff') {
    const message =
      view.kind === 'binary'
        ? t('pane.changes.binary')
        : view.kind === 'too-large'
          ? t('pane.changes.tooLarge')
          : view.kind === 'renamed-only'
            ? t('pane.changes.renamedOnly', { oldPath: view.oldPath })
            : view.kind === 'empty-added'
              ? t('pane.changes.emptyAdded')
              : view.kind === 'empty-deleted'
                ? t('pane.changes.emptyDeleted')
                : t('pane.changes.same')
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <p className="min-w-0 text-small text-tertiary [overflow-wrap:anywhere]">{message}</p>
        <Button variant="quiet" size="xs" onClick={onOpenTab} className="shrink-0">
          {t('pane.changes.openFullDiff')}
        </Button>
      </div>
    )
  } else {
    body = (
      <>
        {file.oldPath && file.oldPath !== file.path && (
          <div
            className="truncate border-b border-subtle bg-subtle/60 px-3 py-1 font-mono text-code-sm text-tertiary"
            title={`${file.oldPath} → ${file.path}`}
          >
            {file.oldPath} → {file.path}
          </div>
        )}
        {error && (
          <div className="flex items-center justify-between gap-2 border-b border-subtle bg-danger/8 px-3 py-1">
            <span className="min-w-0 truncate text-small text-danger" title={error}>
              {error.split('\n')[0]}
            </span>
            <Button variant="quiet" size="xs" onClick={retry} className="shrink-0">
              {t('pane.changes.retry')}
            </Button>
          </div>
        )}
        <div data-inline-diff-scroll="" className="max-h-88 overflow-auto overscroll-contain">
          <Diff
            path={file.path}
            oldText={view.oldText}
            newText={view.newText}
            overflow="scroll"
            layout="unified"
            className="git-inline-diff"
          />
        </div>
        {view.truncated && (
          <div className="flex items-center justify-between gap-2 border-t border-subtle bg-subtle/60 px-3 py-1.5 text-small text-tertiary">
            <span className="min-w-0 truncate">
              {view.totalLines !== null
                ? t('pane.changes.truncated', {
                    shown: view.shownLines,
                    total: view.totalLines,
                  })
                : t('pane.changes.truncatedGeneric')}
            </span>
            <Button variant="quiet" size="xs" onClick={onOpenTab} className="shrink-0">
              {t('pane.changes.openFullDiff')}
            </Button>
          </div>
        )}
      </>
    )
  }

  return (
    <div
      id={id}
      role="region"
      aria-label={t('pane.changes.inlineDiffRegion', { name })}
      data-inline-diff={file.path}
      className="overflow-hidden rounded-b-xl border-t border-subtle"
    >
      {body}
    </div>
  )
}
