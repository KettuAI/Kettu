import { FileTextIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolContent } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { relativePath } from '@renderer/lib/format'
import { openDiff } from '@renderer/stores/files'
import { Clamp } from '../clamp'
import { Diff } from '../markdown'
import { BlockCopy, BlockFrame, BlockSpacer } from '@renderer/features/session/markdown/block-frame'
import { useDiffStats } from './use-diff-stats'

/**
 * One file's change in the block frame: its path and line counts in the header, with Open diff,
 * which shows the file's change in the Files pane, and Copy for the new text.
 */
export function DiffBlock({
  diff,
  projectPath,
}: {
  diff: Extract<ToolContent, { type: 'diff' }>
  projectPath: string
}) {
  const { t } = useTranslation('session')
  const { path, oldText, newText } = diff
  const relative = relativePath(path, projectPath)
  const inside = relative !== path || !/^(?:[\\/]|[a-z]:[\\/]|~)/i.test(path)
  // The entry's own object, which the counts are cached by.
  const stats = useDiffStats([diff])
  return (
    <BlockFrame
      header={
        <>
          <FileTextIcon aria-hidden className="size-3.25 shrink-0 text-tertiary" />
          <span className="block-frame-name text-primary" title={relative}>
            {relative}
          </span>
          {stats && (
            <span className="flex shrink-0 gap-1.5 font-mono text-[11.5px] tabular">
              <span className="text-code-ok">+{stats.insertions}</span>
              <span className="text-code-bad">−{stats.deletions}</span>
            </span>
          )}
          <BlockSpacer />
          {inside && (
            <Button
              variant="ghost"
              size="xs"
              className="h-6.5 px-3 text-control font-medium"
              onClick={() =>
                openDiff(projectPath, {
                  path: relative,
                  oldPath: null,
                  ref: null,
                  projectFile: relative,
                })
              }
            >
              {t('block.openDiff')}
            </Button>
          )}
          <BlockCopy text={newText} label={t('block.copyNew')} />
        </>
      }
    >
      <Clamp maxHeight={480} more={t('tool.showFullDiff')} buttonClassName="mx-2 my-1">
        <Diff path={relative} oldText={oldText} newText={newText} framed />
      </Clamp>
    </BlockFrame>
  )
}
