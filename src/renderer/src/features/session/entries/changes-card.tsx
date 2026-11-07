import { memo, useMemo, useState } from 'react'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { relativePath } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { openDiff } from '@renderer/stores/files'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { useThreadsStore } from '@renderer/stores/threads'
import { turnChanges } from '../turn-work'
import { DiffBlock } from './diff-block'
import { PANEL } from './helpers'
import { cachedStats, useDiffStats } from './use-diff-stats'

type Change = ReturnType<typeof turnChanges>[number]

/** Files listed before the rest are folded away. */
const SHOWN = 3

/** The files with the most changed lines first, the turn's order among equals. */
function byChangedLines(changes: Change[]): Change[] {
  const lines = (change: Change): number => {
    const stats = cachedStats(change.diffs)
    return stats ? stats.insertions + stats.deletions : 0
  }
  return changes
    .map((change) => ({ change, lines: lines(change) }))
    .sort((a, b) => b.lines - a.lines)
    .map(({ change }) => change)
}

/** A path inside `root`, relative to it, or null for one outside. */
function within(path: string, root: string): string | null {
  if (!/^(?:[\\/]|[a-z]:[\\/]|~)/i.test(path)) return path
  const relative = relativePath(path, root)
  return relative === path ? null : relative
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
  const changes = useMemo(() => turnChanges(entries), [entries])
  const all = useMemo(() => changes.flatMap((change) => change.diffs), [changes])
  const totals = useDiffStats(all)
  const counted = totals !== null
  const ordered = useMemo(() => (counted ? byChangedLines(changes) : changes), [changes, counted])
  const [allShown, setAllShown] = useState(false)
  const root = useGitStore((s) => s.status[projectPath]?.repo?.root ?? null)
  if (changes.length === 0) return null
  const hidden = ordered.length - SHOWN

  const review = (path: string): (() => void) | null => {
    const file = within(path, projectPath)
    const tracked = root === null ? null : within(path, root)
    if (file === null || tracked === null) return null
    return () =>
      openDiff(projectPath, { path: tracked, oldPath: null, ref: null, projectFile: file })
  }
  const first = ordered.map((change) => review(change.path)).find((open) => open !== null)
  const committable =
    root === null
      ? []
      : changes.map((change) => within(change.path, root)).filter((path) => path !== null)

  return (
    <section aria-label={t('changes.label')} className={cn('ks-changes', className)}>
      {/* In a narrow column the buttons move under the count together. */}
      <div className="ks-changes__head">
        <b>{t('changes.files', { count: changes.length })}</b>
        {totals && <Counts insertions={totals.insertions} deletions={totals.deletions} />}
        {(first || committable.length > 0) && (
          <span className="ks-changes__actions">
            {first && (
              <Button variant="outline" className="ks-btn" onClick={first}>
                {t('changes.review')}
              </Button>
            )}
            {committable.length > 0 && (
              <Button
                className="ks-btn ks-btn--solid"
                onClick={() => openGitDialog(projectPath, { kind: 'commit', paths: committable })}
              >
                {t('changes.commit')}
              </Button>
            )}
          </span>
        )}
      </div>
      {(allShown ? ordered : ordered.slice(0, SHOWN)).map((change) => (
        <ChangeRow key={change.path} change={change} projectPath={projectPath} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="ks-file ks-changes__more focus-ring"
          aria-expanded={allShown}
          onClick={() => setAllShown(!allShown)}
        >
          <Icon icon={ArrowDown01Icon} size={16} />
          {allShown ? t('changes.fewer') : t('changes.more', { count: hidden })}
        </button>
      )}
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

/** A changed file; a click unfolds its diffs under it. */
function ChangeRow({ change, projectPath }: { change: Change; projectPath: string }) {
  const stats = useDiffStats(change.diffs)
  const shown = relativePath(change.path, projectPath)
  const cut = shown.lastIndexOf('/') + 1
  return (
    <Collapsible>
      <CollapsibleTrigger className="ks-file focus-ring" title={shown}>
        <FileTypeIcon path={change.path} className="size-4" />
        <span className="ks-file__name">
          <span className="ks-file__dir">{shown.slice(0, cut)}</span>
          {shown.slice(cut)}
        </span>
        {stats && <Counts insertions={stats.insertions} deletions={stats.deletions} />}
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL} keepMounted={false}>
        <div className="flex flex-col gap-2 px-1.5 pt-1 pb-2">
          {change.diffs.map((diff, index) => (
            <DiffBlock key={index} diff={diff} projectPath={projectPath} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
