import { memo, useEffect, useMemo, useState } from 'react'
import {
  ArrowDown01Icon,
  BrowserIcon,
  File01Icon,
  FolderOpenIcon,
  GitPullRequestIcon,
  Link01Icon,
  Undo02Icon,
  ViewIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { isDiffContentItem, toolContentItems, type ToolEntry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import { relativeToRoot } from '@renderer/features/files/file-location'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { isHtmlFile, previewHtml, useHtmlPreview } from '@renderer/features/files/html-preview'
import { OpenInEditorMenu } from '@renderer/features/files/open-in-editor-menu'
import {
  copyFilePathText,
  isLocalProject,
  showFileInManager,
} from '@renderer/features/files/operations'
import { openGitPane } from '@renderer/features/git/pane/open-pane'
import { useDeletedGitPaths } from '@renderer/features/git/use-git-data'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { relativePath } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { fileManagerName } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { openDiff, openFile } from '@renderer/stores/files'
import { useGitStore } from '@renderer/stores/git'
import { loadFullEntry, useThreadsStore } from '@renderer/stores/threads'
import { turnChanges, type TurnChange } from '../turn-work'
import { changeRowMenuModel, isChangeDeleted, type ChangeRowMenuModel } from './change-row-menu'
import { DiffBlock } from './diff-block'
import { PANEL } from './helpers'
import { TurnUndoDialog } from './turn-undo-dialog'
import { cachedStats, diffsSettled, useDiffStats } from './use-diff-stats'

/** Files listed before the rest are folded away. */
const SHOWN = 3

/** The files with the most changed lines first, the turn's order among equals. */
function byChangedLines(changes: TurnChange[]): TurnChange[] {
  const lines = (change: TurnChange): number => {
    const stats = cachedStats(change.diffs)
    return stats ? stats.insertions + stats.deletions : 0
  }
  return changes
    .map((change) => ({ change, lines: lines(change) }))
    .sort((a, b) => b.lines - a.lines)
    .map(({ change }) => change)
}

/** A turn's recorded diffs, with repository actions for its current worktree. */
export const ChangesCard = memo(function ChangesCard({
  sessionId,
  projectPath,
  toolIds,
  className,
}: {
  sessionId: string
  projectPath: string
  toolIds: string[]
  className?: string
}) {
  const { t } = useTranslation('session')
  const entries = useThreadsStore(
    useShallow((s) => {
      const byId = s.replicas[sessionId]?.state?.byId
      return toolIds.map((id) => byId?.[id])
    }),
  )
  const sessionStatus = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.status)
  const changes = useMemo(() => turnChanges(entries), [entries])
  const all = useMemo(() => changes.flatMap((change) => change.diffs), [changes])
  const totals = useDiffStats(all)
  const counted = totals !== null
  // The rows keep their place unseen until the lines are counted, so they never move once shown.
  const settled = counted || diffsSettled(all)
  const ordered = useMemo(() => (counted ? byChangedLines(changes) : changes), [changes, counted])
  const [allShown, setAllShown] = useState(false)
  const [undoOpen, setUndoOpen] = useState(false)
  const [undoneLocally, setUndoneLocally] = useState(false)
  const root = useGitStore((s) => s.status[projectPath]?.repo?.root ?? null)
  const gitDeleted = useDeletedGitPaths(projectPath)
  const local = isLocalProject(projectPath)
  const previewable = useHtmlPreview(sessionId, projectPath)
  const undoneFromEntries = useMemo(() => {
    const diffTools = entries.filter(
      (entry): entry is ToolEntry =>
        entry?.kind === 'tool' &&
        entry.status === 'completed' &&
        toolContentItems(entry).some(isDiffContentItem),
    )
    return diffTools.length > 0 && diffTools.every((entry) => entry.undone === true)
  }, [entries])
  const undone = undoneLocally || undoneFromEntries
  const busy =
    sessionStatus === 'running' ||
    sessionStatus === 'awaiting_permission' ||
    sessionStatus === 'starting'
  if (changes.length === 0) return null
  const hidden = ordered.length - SHOWN
  const undoLabel = undone ? t('changes.undone') : t('changes.undo')
  const undoTitle = undone
    ? t('changes.alreadyUndone')
    : busy
      ? t('changes.undoBusy')
      : t('changes.undo')

  const deletedOf = (change: TurnChange): boolean =>
    isChangeDeleted({
      changeDeleted: change.deleted,
      path: change.path,
      projectPath,
      repoRoot: root,
      gitDeleted,
    })

  const review = (change: TurnChange): (() => void) | null => {
    const file = relativeToRoot(change.path, projectPath)
    const tracked = root === null ? null : relativeToRoot(change.path, root)
    if (file === null || tracked === null) return null
    const deleted = deletedOf(change)
    return () =>
      openDiff(
        projectPath,
        { path: tracked, oldPath: null, ref: null, projectFile: deleted ? null : file },
        { preview: true },
      )
  }
  const first = ordered.map((change) => review(change)).find((open) => open !== null)
  const page = (change: TurnChange): (() => void) | null => {
    if (deletedOf(change)) return null
    const file = previewable ? relativeToRoot(change.path, projectPath) : null
    return file === null || !isHtmlFile(file) ? null : () => void previewHtml(sessionId, file)
  }
  // Every row keeps the room of a Preview button when one has it, so the counts stay in a column.
  const pages = ordered.some((change) => page(change) !== null)
  const committable =
    root === null
      ? []
      : changes.map((change) => relativeToRoot(change.path, root)).filter((path) => path !== null)

  return (
    <section aria-label={t('changes.label')} className={cn('ks-changes', className)}>
      {/* In a narrow column the buttons keep only their icons. */}
      <div className="ks-changes__head">
        <b>{t('changes.files', { count: changes.length })}</b>
        {totals && <Counts insertions={totals.insertions} deletions={totals.deletions} />}
        {undone && <span className="ks-changes__undone">{t('changes.undone')}</span>}
        <span className="ks-changes__actions">
          <Button
            variant="outline"
            className="ks-btn"
            disabled={busy || undone}
            aria-label={undoLabel}
            title={undoTitle}
            data-changes-undo=""
            onClick={() => setUndoOpen(true)}
          >
            <Icon icon={Undo02Icon} size={14} />
            <span className="ks-btn__label">{undoLabel}</span>
          </Button>
          {first && (
            <Button
              variant="outline"
              className="ks-btn"
              aria-label={t('changes.review')}
              title={t('changes.review')}
              onClick={first}
            >
              <Icon icon={ViewIcon} size={14} />
              <span className="ks-btn__label">{t('changes.review')}</span>
            </Button>
          )}
          {committable.length > 0 && (
            <Button
              className="ks-btn ks-btn--solid"
              aria-label={t('changes.commit')}
              title={t('changes.commit')}
              onClick={() =>
                openGitPane(projectPath, {
                  tab: 'changes',
                  commit: { only: committable, andPush: false },
                  panel: sessionId,
                })
              }
            >
              <Icon icon={GitPullRequestIcon} size={14} />
              <span className="ks-btn__label">{t('changes.commit')}</span>
            </Button>
          )}
        </span>
      </div>
      {(allShown ? ordered : ordered.slice(0, SHOWN)).map((change) => (
        <ChangeRow
          key={change.path}
          sessionId={sessionId}
          change={change}
          projectPath={projectPath}
          local={local}
          deleted={deletedOf(change)}
          counting={!settled}
          onPage={page(change)}
          pages={pages}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className={cn('ks-file ks-changes__more focus-ring', !settled && 'invisible')}
          aria-expanded={allShown}
          onClick={() => setAllShown(!allShown)}
        >
          <Icon icon={ArrowDown01Icon} size={16} />
          {allShown ? t('changes.fewer') : t('changes.more', { count: hidden })}
        </button>
      )}
      <TurnUndoDialog
        open={undoOpen}
        onOpenChange={setUndoOpen}
        sessionId={sessionId}
        projectPath={projectPath}
        toolIds={toolIds}
        onApplied={() => setUndoneLocally(true)}
      />
    </section>
  )
})

function Counts({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <span className="ks-changes__counts tabular">
      <span className="ks-add">+{insertions}</span>
      <span className="ks-del">−{deletions}</span>
    </span>
  )
}

/**
 * A changed file; a left click unfolds its diffs under it and a right click offers file actions
 * (open in Files, open in an external editor, reveal in the file manager, and copy path). An HTML
 * file's page has a Preview at its end, whose room the other rows keep while `pages`.
 */
function ChangeRow({
  sessionId,
  change,
  projectPath,
  local,
  deleted,
  counting,
  onPage,
  pages,
}: {
  sessionId: string
  change: TurnChange
  projectPath: string
  local: boolean
  deleted: boolean
  counting: boolean
  onPage: (() => void) | null
  pages: boolean
}) {
  const { t } = useTranslation(['files', 'common'])
  const [open, setOpen] = useState(false)
  const [loadError, setLoadError] = useState<{ attempt: number; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const needsFull = change.diffs.some((diff) => diff.type === 'digest')
  useEffect(() => {
    if (!open || !needsFull) return
    let active = true
    void Promise.all(change.entryIds.map((id) => loadFullEntry(sessionId, id))).catch(
      (error: unknown) => {
        if (active) setLoadError({ attempt, message: errorMessage(error) })
      },
    )
    return () => {
      active = false
    }
  }, [open, needsFull, sessionId, change.entryIds, attempt])
  const activeError = loadError?.attempt === attempt ? loadError.message : null
  const stats = useDiffStats(change.diffs)
  const shown = relativePath(change.path, projectPath)
  const cut = shown.lastIndexOf('/') + 1
  const menu = useMemo(
    () => changeRowMenuModel({ projectPath, path: change.path, local, deleted }),
    [projectPath, change.path, local, deleted],
  )
  const trigger = (
    <CollapsibleTrigger
      className={cn('ks-file focus-ring', counting && !pages && 'invisible')}
      title={shown}
    >
      <FileTypeIcon path={change.path} className="size-4" />
      <span className="ks-file__name">
        <span className="ks-file__dir">{shown.slice(0, cut)}</span>
        {shown.slice(cut)}
      </span>
      {stats && <Counts insertions={stats.insertions} deletions={stats.deletions} />}
    </CollapsibleTrigger>
  )
  const row = pages ? (
    <div className={cn('ks-file-row', counting && 'invisible')}>
      {trigger}
      {onPage ? (
        <button
          type="button"
          className="ks-page-btn focus-ring"
          title={t('files:htmlPreview.inKettu')}
          onClick={onPage}
        >
          <Icon icon={BrowserIcon} size={13} />
          {t('files:htmlPreview.preview')}
        </button>
      ) : (
        <span aria-hidden className="ks-page-btn invisible">
          <Icon icon={BrowserIcon} size={13} />
          {t('files:htmlPreview.preview')}
        </span>
      )}
    </div>
  ) : (
    trigger
  )
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <ContextMenu>
        <ContextMenuTrigger render={row} />
        <ChangeRowMenu projectPath={projectPath} menu={menu} />
      </ContextMenu>
      <CollapsibleContent className={PANEL} keepMounted={false}>
        <div className="flex flex-col gap-2 px-1.5 pt-1 pb-2">
          {needsFull ? (
            activeError ? (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                <span className="min-w-0 truncate" title={activeError}>
                  {activeError}
                </span>
                <Button size="xs" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                  {t('common:actions.retry')}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-center py-3">
                <Spinner className="size-4 text-muted-foreground" />
              </div>
            )
          ) : (
            change.diffs.map((diff, index) =>
              diff.type === 'diff' ? (
                <DiffBlock key={index} diff={diff} projectPath={projectPath} />
              ) : null,
            )
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ChangeRowMenu({ projectPath, menu }: { projectPath: string; menu: ChangeRowMenuModel }) {
  const { t } = useTranslation(['session', 'files'])
  const hasOpenActions = menu.filesTarget !== null || menu.localTarget !== null
  return (
    <ContextMenuContent className="min-w-56">
      {menu.filesTarget !== null && (
        <ContextMenuItem
          onClick={() => openFile(projectPath, menu.filesTarget!, null, { preview: true })}
        >
          <MenuGlyph icon={File01Icon} />
          {t('session:changes.openInFiles')}
        </ContextMenuItem>
      )}
      {menu.localTarget !== null && (
        <>
          <OpenInEditorMenu path={menu.localTarget} />
          <ContextMenuItem onClick={() => showFileInManager(menu.localTarget!)}>
            <MenuGlyph icon={FolderOpenIcon} />
            {t('files:preview.showIn', { name: fileManagerName() })}
          </ContextMenuItem>
        </>
      )}
      {hasOpenActions && <ContextMenuSeparator />}
      <ContextMenuItem onClick={() => copyFilePathText(menu.copyPath)}>
        <MenuGlyph icon={Link01Icon} />
        {t('files:tree.copyPath')}
      </ContextMenuItem>
      {menu.copyRelativePath !== null && (
        <ContextMenuItem onClick={() => copyFilePathText(menu.copyRelativePath!)}>
          <MenuGlyph icon={Link01Icon} />
          {t('files:tree.copyRelativePath')}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  )
}
