import { useEffect, useState } from 'react'
import { Alert02Icon, ArrowDown01Icon, RefreshIcon, Undo02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type {
  TurnUndoAction,
  TurnUndoFilePreview,
  TurnUndoPreview,
  TurnUndoReason,
} from '@shared/turn-undo'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { refreshFiles } from '@renderer/stores/files'
import { refreshGitProject } from '@renderer/stores/git'
import { Clamp } from '../clamp'
import { Diff } from '../markdown'
import { PANEL } from './helpers'

export interface TurnUndoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  projectPath: string
  toolIds: string[]
  onApplied?: () => void
}

function actionBadgeClass(action: TurnUndoAction): string {
  if (action === 'delete') return 'ks-undo__badge ks-undo__badge--delete'
  if (action === 'restore') return 'ks-undo__badge ks-undo__badge--restore'
  return 'ks-undo__badge ks-undo__badge--revert'
}

function defaultExpandedPaths(preview: TurnUndoPreview): Record<string, boolean> {
  const firstReady = preview.affectedFiles.find((file) => file.status === 'ready')
  return firstReady ? { [firstReady.path]: true } : {}
}

/** Modal dialog that previews reverse changes for one turn and applies them all-or-nothing. */
export function TurnUndoDialog({
  open,
  onOpenChange,
  sessionId,
  projectPath,
  toolIds,
  onApplied,
}: TurnUndoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ks-undo-dialog w-3xl max-w-[92vw] gap-3 sm:max-w-3xl">
        {open && (
          <TurnUndoDialogBody
            sessionId={sessionId}
            projectPath={projectPath}
            toolIds={toolIds}
            onClose={() => onOpenChange(false)}
            onApplied={onApplied}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function TurnUndoDialogBody({
  sessionId,
  projectPath,
  toolIds,
  onClose,
  onApplied,
}: {
  sessionId: string
  projectPath: string
  toolIds: string[]
  onClose: () => void
  onApplied?: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  const [preview, setPreview] = useState<TurnUndoPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stalePaths, setStalePaths] = useState<string[] | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    host('sessions.previewUndoTurn', { sessionId, toolIds }).then(
      (next) => {
        if (cancelled) return
        setPreview(next)
        setError(null)
        setStalePaths(null)
        setExpanded((prev) => (Object.keys(prev).length > 0 ? prev : defaultExpandedPaths(next)))
        setLoading(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setError(errorMessage(err))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, toolIds, attempt])

  const recheck = (): void => {
    setLoading(true)
    setError(null)
    setAttempt((n) => n + 1)
  }

  const reasonLabel = (reason: TurnUndoReason): string => t(`session:undoTurn.reasons.${reason}`)

  const apply = async (): Promise<void> => {
    if (!preview || !preview.canApply || applying || loading) return
    setApplying(true)
    setError(null)
    try {
      const result = await host('sessions.undoTurn', {
        sessionId,
        toolIds,
        expectedDigests: preview.fileDigests,
      })
      if (result.status === 'stale') {
        setPreview(result.preview)
        setStalePaths(result.changedPaths)
        setExpanded(defaultExpandedPaths(result.preview))
        return
      }
      if (result.status === 'conflict') {
        setPreview(result.preview)
        setStalePaths(null)
        return
      }
      const total =
        result.revertedFiles.length + result.deletedFiles.length + result.restoredFiles.length
      toast(t('session:undoTurn.applied', { count: total }))
      refreshGitProject(projectPath)
      refreshFiles(projectPath)
      onApplied?.()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setApplying(false)
    }
  }

  const toggleFile = (filePath: string, nextOpen: boolean): void => {
    setExpanded((prev) => ({ ...prev, [filePath]: nextOpen }))
  }

  const confirmDisabled = !preview || !preview.canApply || loading || applying

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>{t('session:undoTurn.title')}</DialogTitle>
        <DialogDescription>{t('session:undoTurn.description')}</DialogDescription>
      </DialogHeader>

      <div className="ks-undo__body">
        {stalePaths && stalePaths.length > 0 && (
          <div role="status" data-undo-stale="" className="ks-undo__banner ks-undo__banner--warn">
            <span className="mt-0.5 shrink-0">
              <Icon icon={Alert02Icon} size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t('session:undoTurn.staleTitle')}</p>
              <p className="mt-0.5 text-meta">{t('session:undoTurn.staleBody')}</p>
              <ul className="mt-1.5 list-disc pl-4 font-mono text-xs">
                {stalePaths.map((filePath) => (
                  <li key={filePath} className="truncate" title={filePath}>
                    {filePath}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" data-undo-error="" className="ks-undo__banner ks-undo__banner--danger">
            <span className="mt-0.5 shrink-0">
              <Icon icon={Alert02Icon} size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t('session:undoTurn.errorTitle')}</p>
              <p className="mt-0.5 text-meta">{error}</p>
            </div>
          </div>
        )}

        {loading && !preview ? (
          <div className="flex flex-col gap-2 py-2" data-undo-loading="">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        ) : preview ? (
          <>
            {preview.alreadyUndone && (
              <div role="status" className="ks-undo__banner ks-undo__banner--info">
                <p>{t('session:undoTurn.alreadyUndone')}</p>
              </div>
            )}

            {preview.conflicts.length > 0 && (
              <div
                role="alert"
                data-undo-conflicts=""
                className="ks-undo__banner ks-undo__banner--danger"
              >
                <span className="mt-0.5 shrink-0">
                  <Icon icon={Alert02Icon} size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {t('session:undoTurn.conflictTitle', { count: preview.conflicts.length })}
                  </p>
                  <p className="mt-0.5 text-meta">{t('session:undoTurn.conflictBody')}</p>
                  <ul className="mt-1.5 flex flex-col gap-1 text-xs">
                    {preview.conflicts.map((conflict) => (
                      <li key={conflict.path} className="flex flex-wrap items-baseline gap-1.5">
                        <span className="font-mono font-medium">{conflict.path}</span>
                        <span className="text-meta">— {reasonLabel(conflict.reason)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {preview.affectedFiles.length === 0 ? (
              <p className="py-6 text-center text-meta text-muted-foreground">
                {t('session:undoTurn.noChanges')}
              </p>
            ) : (
              <div className="ks-undo__list" data-undo-files="">
                {preview.affectedFiles.map((file) => (
                  <UndoFileCard
                    key={file.path}
                    file={file}
                    open={expanded[file.path] === true}
                    onOpenChange={(nextOpen) => toggleFile(file.path, nextOpen)}
                    reasonLabel={reasonLabel}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          size="dialog"
          disabled={loading || applying}
          onClick={recheck}
          data-undo-recheck=""
        >
          {loading ? <Spinner className="size-3.5" /> : <Icon icon={RefreshIcon} size={13} />}
          {t('session:undoTurn.recheck')}
        </Button>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="dialog"
            disabled={applying}
            onClick={onClose}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="dialog"
            disabled={confirmDisabled}
            onClick={() => void apply()}
            data-undo-confirm=""
          >
            {applying ? <Spinner className="size-3.5" /> : <Icon icon={Undo02Icon} size={13} />}
            {applying ? t('session:undoTurn.applying') : t('session:undoTurn.confirm')}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

function UndoFileCard({
  file,
  open,
  onOpenChange,
  reasonLabel,
}: {
  file: TurnUndoFilePreview
  open: boolean
  onOpenChange: (open: boolean) => void
  reasonLabel: (reason: TurnUndoReason) => string
}) {
  const { t } = useTranslation('session')
  const cut = file.path.lastIndexOf('/') + 1
  const blocked = file.status !== 'ready'

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={cn('ks-undo__file', blocked && 'ks-undo__file--blocked')}
    >
      <CollapsibleTrigger className="ks-undo__file-head focus-ring" title={file.path}>
        <span className={cn('ks-undo__chevron shrink-0', !open && '-rotate-90')}>
          <Icon icon={ArrowDown01Icon} size={14} />
        </span>
        <FileTypeIcon path={file.path} className="size-4 shrink-0" />
        <span className="ks-file__name">
          <span className="ks-file__dir">{file.path.slice(0, cut)}</span>
          {file.path.slice(cut)}
        </span>
        <span className={actionBadgeClass(file.action)}>{t(`undoTurn.action.${file.action}`)}</span>
        {blocked && (
          <span className="ks-undo__badge ks-undo__badge--conflict">
            {file.status === 'conflict'
              ? t('undoTurn.status.conflict')
              : t('undoTurn.status.unsupported')}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className={PANEL} keepMounted={false}>
        <div className="ks-undo__file-body">
          {blocked && file.reason ? (
            <p className="ks-undo__file-reason">{reasonLabel(file.reason)}</p>
          ) : (
            <>
              {file.action === 'delete' && (
                <p className="ks-undo__file-hint">{t('undoTurn.deleteHint')}</p>
              )}
              {file.action === 'restore' && (
                <p className="ks-undo__file-hint">{t('undoTurn.restoreHint')}</p>
              )}
              <div
                data-diff-block=""
                className="flex flex-col overflow-hidden rounded-code border border-subtle"
              >
                <Clamp maxHeight={320} more={t('tool.showFullDiff')} buttonClassName="mx-2 my-1">
                  <Diff
                    path={file.path}
                    oldText={file.action === 'restore' ? null : file.beforeText}
                    newText={file.action === 'delete' ? '' : (file.afterText ?? '')}
                  />
                </Clamp>
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
