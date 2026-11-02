import { useCallback, useRef, useState } from 'react'
import type { SelectedLineRange } from '@pierre/diffs'
import { AtSignIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FileDiff } from '@shared/git'
import { Button } from '@renderer/components/ui/button'
import { CopyButton } from '@renderer/features/git/copy-button'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { closeDiff, openFile, type DiffView } from '@renderer/stores/files'
import { DiffFileToggle, PathLabel } from './file-header'
import { Lines, Notice } from './file-preview'
import { stepChange, useHunkCount } from './diff-nav'
import { FilesDiff } from './files-diff'
import { mentionLines, selectedLines } from './mention-lines'

/** A file's change: uncommitted against `HEAD` from the Changes list, or at a commit. */
export function DiffPreview({ projectPath, diff }: { projectPath: string; diff: DiffView }) {
  const { t } = useTranslation('files')
  const showFile = (): void => {
    if (diff.projectFile === null) return
    openFile(projectPath, diff.projectFile)
    closeDiff(projectPath)
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-3.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]">
        <PathLabel path={diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path} />
        {diff.ref && (
          <span className="shrink-0 font-mono text-caption text-tertiary">
            {diff.ref.slice(0, 7)}
          </span>
        )}
        <DiffFileToggle
          value="diff"
          disabled={diff.projectFile === null}
          onChange={(next) => next === 'file' && showFile()}
        />
        <CopyButton text={diff.path} label={t('preview.copyPath')} className="size-6.5" />
      </div>
      <Body projectPath={projectPath} diff={diff} />
    </div>
  )
}

function Body({ projectPath, diff }: { projectPath: string; diff: DiffView }) {
  const { t } = useTranslation('files')
  const { result, error } = diff
  if (error && !result) return <Notice title={t('diff.failed')} description={error} />
  if (!result) return <Lines />
  if (result.binary) {
    return <Notice title={t('preview.binaryTitle')} description={t('diff.binaryDescription')} />
  }
  if (result.tooLarge) {
    return <Notice title={t('diff.tooLargeTitle')} description={t('diff.tooLargeDescription')} />
  }
  if (result.oldText === result.newText) {
    return <Notice title={t('diff.sameTitle')} description={t('diff.sameDescription')} />
  }
  return (
    <Changes
      key={`${result.path}\0${diff.ref ?? ''}`}
      projectPath={projectPath}
      diff={diff}
      result={result}
    />
  )
}

function Changes({
  projectPath,
  diff,
  result,
}: {
  projectPath: string
  diff: DiffView
  result: FileDiff
}) {
  const { t } = useTranslation('files')
  const scroller = useRef<HTMLDivElement>(null)
  const newText = result.newText ?? ''
  const hunks = useHunkCount(result.path, result.oldText, newText)
  const [selected, setSelected] = useState<SelectedLineRange | null>(null)
  const onSelect = useCallback((range: SelectedLineRange | null) => setSelected(range), [])
  // Lines of a commit are not the file as it is now, so only the working tree's are mentioned.
  const lines = diff.ref === null && diff.projectFile !== null ? selectedLines(selected) : null
  const [missed, setMissed] = useState(false)

  const mention = (): void => {
    if (!lines || diff.projectFile === null) return
    if (mentionLines(projectPath, diff.projectFile, lines)) {
      setSelected(null)
      setMissed(false)
    } else {
      setMissed(true)
    }
  }

  return (
    <>
      <div
        ref={scroller}
        data-selectable=""
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-code-block"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape' && selected) setSelected(null)
        }}
      >
        <FilesDiff
          path={result.path}
          oldText={result.oldText}
          newText={newText}
          selected={selected}
          onSelect={onSelect}
        />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-3 pr-2 pl-3.5 text-small text-tertiary shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
        {lines ? (
          <Button variant="outline" size="xs" className="-ml-1.5 text-small" onClick={mention}>
            <AtSignIcon />
            {lines[0] === lines[1]
              ? t('diff.mentionLine', { line: lines[0] })
              : t('diff.mentionLines', { start: lines[0], end: lines[1] })}
          </Button>
        ) : (
          <span className="min-w-0 truncate">
            {diff.ref === null ? t('diff.selectHint') : t('diff.atCommit')}
          </span>
        )}
        {missed && <span className="min-w-0 truncate text-danger">{t('diff.noComposer')}</span>}
        <span className="flex-1" />
        <span className="shrink-0 tabular">{t('diff.hunks', { count: hunks })}</span>
        <span className="flex shrink-0 items-center">
          <PanelButton label={t('diff.previous')} onClick={() => stepChange(scroller, -1)}>
            <ChevronUpIcon className="size-3.5" />
          </PanelButton>
          <PanelButton label={t('diff.next')} onClick={() => stepChange(scroller, 1)}>
            <ChevronDownIcon className="size-3.5" />
          </PanelButton>
        </span>
      </div>
    </>
  )
}
