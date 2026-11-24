import { useEffect, useMemo, type RefObject } from 'react'
import { CheckmarkCircle02Icon, Delete02Icon, File01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ChangedFile, GitStatus } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ChangeBadge } from '@renderer/features/files/change-badge'
import { Glyph } from '@renderer/features/shell/glyph'
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
import type { Loaded } from '../use-git-data'
import { committable, leftOutExcept, tickState, toggled } from './commit-selection'

const NO_PATHS: readonly string[] = []

// A row's click opens the preview tab right after the Git tab; a double click, a tab that stays.
const PREVIEW = { preview: true, fromPanel: true }
const KEPT = { fromPanel: true }

/** The working tree's changed files, ticked for the next commit; one opens its diff in a tab. */
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
              shown={shown === `diff:${diffId({ path: file.path, ref: null })}`}
              onTick={() => {}}
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
              shown={shown === `diff:${diffId({ path: file.path, ref: null })}`}
              onTick={(on) => setLeftOut(projectPath, toggled(leftOut, file.path, on))}
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

/** One changed file: its tick, name and line counts; it opens its diff in a tab. */
function FileEntry({
  status,
  file,
  ticked,
  shown,
  onTick,
  blocked,
}: {
  status: GitStatus
  file: ChangedFile
  ticked: boolean
  /** The panel's diff tab shows this file's change. */
  shown: boolean
  onTick: (on: boolean) => void
  blocked: boolean
}) {
  const { t } = useTranslation('git')
  const slash = file.path.lastIndexOf('/')
  const name = file.path.slice(slash + 1)
  // The two folders nearest the file say enough; the tooltip has the whole path.
  const folder = slash < 0 ? '' : file.path.slice(0, slash).split('/').slice(-2).join('/')
  const conflicted = file.status === 'conflicted'
  const inProject =
    file.status === 'deleted'
      ? null
      : projectRelative(status.repo?.root ?? status.projectPath, status.projectPath, file.path)
  return (
    <div
      aria-current={shown || undefined}
      className="group/file flex h-8 items-center gap-2 rounded-xl px-2 transition-colors focus-within:bg-hover hover:bg-hover aria-[current]:bg-selected"
    >
      <Checkbox
        checked={ticked}
        disabled={conflicted}
        aria-label={t('pane.changes.tick', { name })}
        onCheckedChange={onTick}
      />
      <button
        type="button"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        aria-label={t('timeline.openDiff', { name })}
        onClick={() => openChangeDiff(status, file, null, PREVIEW)}
        onDoubleClick={() => openChangeDiff(status, file, null, KEPT)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:focus-ring"
      >
        <ChangeBadge status={file.status} />
        <span className="min-w-0 shrink truncate text-ui text-primary">{name}</span>
        <span className="min-w-0 flex-1 truncate text-small text-tertiary">{folder}</span>
      </button>
      {conflicted ? (
        <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-danger/11 px-1.75 text-caption font-medium text-danger">
          {t('popover.conflict')}
        </span>
      ) : (
        <>
          <span className="hidden shrink-0 items-center group-focus-within/file:flex group-hover/file:flex">
            {inProject !== null && (
              <RowAction
                label={t('pane.changes.openInFiles')}
                icon={File01Icon}
                onClick={() => openFile(status.projectPath, inProject, null, KEPT)}
              />
            )}
            <RowAction
              label={t('pane.changes.discardFile')}
              icon={Delete02Icon}
              disabled={blocked}
              onClick={() =>
                openGitDialog(status.projectPath, { kind: 'discard', paths: [file.path] })
              }
            />
          </span>
          <LineCounts insertions={file.insertions} deletions={file.deletions} />
          {file.insertions !== null && file.deletions !== null && (
            <span className="group-focus-within/file:hidden group-hover/file:hidden">
              <LineBar insertions={file.insertions} deletions={file.deletions} />
            </span>
          )}
        </>
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
            onClick={onClick}
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
