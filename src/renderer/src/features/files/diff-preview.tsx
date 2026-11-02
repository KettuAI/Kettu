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
import { stepChange, useParsedDiff } from './diff-nav'
import { FilesDiff } from './files-diff'
import { mentionLines, selectedLines, type MentionMiss } from './mention-lines'

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
        <CopyButton
          text={diff.path}
          label={t('preview.copyPath')}
          className="size-6.5"
          iconClassName="size-3.25"
        />
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
  const fileDiff = useParsedDiff(result.path, result.oldText, result.newText ?? '')
  const [selected, setSelected] = useState<SelectedLineRange | null>(null)
  const onSelect = useCallback((range: SelectedLineRange | null) => setSelected(range), [])
  // Lines of a commit are not the file as it is now, so only the working tree's are mentioned.
  const lines = diff.ref === null && diff.projectFile !== null ? selectedLines(selected) : null
  const [miss, setMiss] = useState<MentionMiss | null>(null)

  const mention = (): void => {
    if (!lines || diff.projectFile === null) return
    const missed = mentionLines(projectPath, diff.projectFile, lines)
    setMiss(missed)
    if (!missed) setSelected(null)
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || !selected) return
        // Handled here, so the session does not also take Esc as a request to stop.
        event.preventDefault()
        setSelected(null)
      }}
    >
      {/* Focusable, so a click on a line focuses it and Esc reaches the handler above. */}
      <div
        ref={scroller}
        tabIndex={-1}
        data-selectable=""
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-code-block"
      >
        <FilesDiff fileDiff={fileDiff} selected={selected} onSelect={onSelect} />
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
        {miss && (
          <span className="min-w-0 truncate text-danger">
            {miss === 'full' ? t('attachments.limit', { ns: 'composer' }) : t('diff.noComposer')}
          </span>
        )}
        <span className="flex-1" />
        <span className="shrink-0 tabular">
          {t('diff.hunks', { count: fileDiff.hunks.length })}
        </span>
        <span className="flex shrink-0 items-center">
          <PanelButton label={t('diff.previous')} onClick={() => stepChange(scroller, -1)}>
            <ChevronUpIcon className="size-3.5" />
          </PanelButton>
          <PanelButton label={t('diff.next')} onClick={() => stepChange(scroller, 1)}>
            <ChevronDownIcon className="size-3.5" />
          </PanelButton>
        </span>
      </div>
    </div>
  )
}
