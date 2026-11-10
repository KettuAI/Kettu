import { useTranslation } from 'react-i18next'
import type { ToolContent } from '@shared/thread'
import { relativePath } from '@renderer/lib/format'
import { Clamp } from '../clamp'
import { Diff } from '../markdown'

export function DiffBlock({
  diff,
  projectPath,
}: {
  diff: Extract<ToolContent, { type: 'diff' }>
  projectPath: string
}) {
  const { t } = useTranslation('session')
  return (
    <div
      data-diff-block=""
      className="flex flex-col overflow-hidden rounded-code border border-subtle"
    >
      <Clamp maxHeight={480} more={t('tool.showFullDiff')} buttonClassName="mx-2 my-1">
        <Diff
          path={relativePath(diff.path, projectPath)}
          oldText={diff.oldText}
          newText={diff.newText}
        />
      </Clamp>
    </div>
  )
}
