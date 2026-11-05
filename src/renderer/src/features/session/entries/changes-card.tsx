import { memo, useMemo } from 'react'
import { ChevronRightIcon, GitPullRequestIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { LineCounts } from '@renderer/features/git/rows'
import { relativePath } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { openDiff } from '@renderer/stores/files'
import { openGitDialog, useGitStore } from '@renderer/stores/git'
import { useThreadsStore } from '@renderer/stores/threads'
import { turnChanges } from '../turn-work'
import { DiffBlock } from './diff-block'
import { PANEL } from './helpers'
import { useDiffStats } from './use-diff-stats'

type Change = ReturnType<typeof turnChanges>[number]

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
  const root = useGitStore((s) => s.status[projectPath]?.repo?.root ?? null)
  if (changes.length === 0) return null

  const review = (path: string): (() => void) | null => {
    const file = within(path, projectPath)
    const tracked = root === null ? null : within(path, root)
    if (file === null || tracked === null) return null
    return () =>
      openDiff(projectPath, { path: tracked, oldPath: null, ref: null, projectFile: file })
  }
  const first = changes.map((change) => review(change.path)).find((open) => open !== null)
  const committable =
    root === null
      ? []
      : changes.map((change) => within(change.path, root)).filter((path) => path !== null)

  return (
    <section
      aria-label={t('changes.label')}
      className={cn('flex flex-col overflow-hidden rounded-card bg-card shadow-card', className)}
    >
      <Collapsible>
        {/* In a narrow column the buttons move under the count together. */}
        <div className="flex min-h-11.5 flex-wrap items-center gap-x-2.5 gap-y-1.5 py-2 pr-2 pl-3.5">
          <CollapsibleTrigger className="group/changes -my-1 -ml-1.5 flex min-w-0 items-center gap-2.5 rounded-tile px-1.5 py-1 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring">
            <ChevronRightIcon
              aria-hidden
              strokeWidth={1.75}
              className="size-3.5 shrink-0 text-tertiary transition-transform duration-(--duration-base) ease-standard group-data-panel-open/changes:rotate-90 motion-reduce:transition-none"
            />
            <span className="text-file font-semibold whitespace-nowrap text-primary">
              {t('changes.files', { count: changes.length })}
            </span>
            {totals && (
              <LineCounts
                insertions={totals.insertions}
                deletions={totals.deletions}
                className="gap-2.5 text-code"
              />
            )}
          </CollapsibleTrigger>
          {(first || committable.length > 0) && (
            <div className="ml-auto flex gap-2.5">
              {first && (
                <Button
                  variant="outline"
                  size="dialog"
                  className="rounded-xl font-medium"
                  onClick={first}
                >
                  {t('changes.review')}
                </Button>
              )}
              {committable.length > 0 && (
                <Button
                  size="dialog"
                  className="rounded-xl font-medium"
                  onClick={() => openGitDialog(projectPath, { kind: 'commit', paths: committable })}
                >
                  <GitPullRequestIcon data-icon="inline-start" className="size-3.25" />
                  {t('changes.commit')}
                </Button>
              )}
            </div>
          )}
        </div>
        <CollapsibleContent className={PANEL} keepMounted={false}>
          {changes.map((change) => (
            <ChangeRow key={change.path} change={change} projectPath={projectPath} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
})

function ChangeRow({ change, projectPath }: { change: Change; projectPath: string }) {
  const stats = useDiffStats(change.diffs)
  const shown = relativePath(change.path, projectPath)
  return (
    <Collapsible className="border-t border-subtle">
      <CollapsibleTrigger className="group/change flex h-8.5 w-full items-center gap-2.5 px-3.5 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring">
        <ChevronRightIcon
          aria-hidden
          strokeWidth={1.75}
          className="size-3.5 shrink-0 text-tertiary transition-transform duration-(--duration-base) ease-standard group-data-panel-open/change:rotate-90 motion-reduce:transition-none"
        />
        <FileTypeIcon path={change.path} className="size-4" />
        <span className="min-w-0 flex-1 truncate font-mono text-hint text-primary" title={shown}>
          {shown}
        </span>
        {stats && (
          <LineCounts
            insertions={stats.insertions}
            deletions={stats.deletions}
            className="gap-2.5 text-code"
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL} keepMounted={false}>
        <div className="flex flex-col gap-2 px-3.5 pb-3.5">
          {change.diffs.map((diff, index) => (
            <DiffBlock key={index} diff={diff} projectPath={projectPath} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
