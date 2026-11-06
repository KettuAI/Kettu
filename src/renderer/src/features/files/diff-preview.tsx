import { useCallback, useRef, useState, type RefObject } from 'react'
import type { SelectedLineRange } from '@pierre/diffs'
import { ArrowDown01Icon, ArrowUp01Icon, AtIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { FileDiff } from '@shared/git'
import { PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { closeDiff, openFile, type DiffView } from '@renderer/stores/files'
import { DiffFileToggle, PathCopy } from './file-header'
import { Lines, Notice } from './file-preview'
import { stepChange, useParsedDiff } from './diff-nav'
import { FilesDiff } from './files-diff'
import { mentionLines, selectedLines, type MentionMiss } from './mention-lines'

/** A file's change: uncommitted against `HEAD` from the Changes list, or at a commit. */
export function DiffPreview({ projectPath, diff }: { projectPath: string; diff: DiffView }) {
  const showFile = (): void => {
    if (diff.projectFile === null) return
    openFile(projectPath, diff.projectFile)
    closeDiff(projectPath)
  }
  const { result, error } = diff
  const drawn =
    result && !result.binary && !result.tooLarge && result.oldText !== result.newText
      ? result
      : null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {drawn ? (
        <Changes
          key={`${drawn.path}\0${diff.ref ?? ''}`}
          projectPath={projectPath}
          diff={diff}
          result={drawn}
          onShowFile={showFile}
        />
      ) : (
        <>
          <Bar diff={diff} onShowFile={showFile} />
          <div className="kp-doc__body">
            <Body diff={diff} error={error} />
          </div>
        </>
      )}
    </div>
  )
}

/** The diff's bar: its path, the commit, the change steps and the Diff and File toggle. */
function Bar({
  diff,
  onShowFile,
  hunks = 0,
  scroller,
}: {
  diff: DiffView
  onShowFile: () => void
  hunks?: number
  scroller?: RefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation('files')
  return (
    <div className="kp-doc__bar">
      <PathCopy
        path={diff.path}
        shown={diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}
      />
      {diff.ref && <span className="kp-doc__ref">{diff.ref.slice(0, 7)}</span>}
      <span className="kp-doc__tools">
        {scroller && hunks > 1 && (
          <span className="kp-doc__hunks" title={t('diff.hunks', { count: hunks })}>
            <PanelButton label={t('diff.previous')} onClick={() => stepChange(scroller, -1)}>
              <PaneIcon icon={ArrowUp01Icon} />
            </PanelButton>
            <PanelButton label={t('diff.next')} onClick={() => stepChange(scroller, 1)}>
              <PaneIcon icon={ArrowDown01Icon} />
            </PanelButton>
          </span>
        )}
        <DiffFileToggle
          value="diff"
          disabled={diff.projectFile === null}
          onChange={(next) => next === 'file' && onShowFile()}
        />
      </span>
    </div>
  )
}

function Body({ diff, error }: { diff: DiffView; error: string | null }) {
  const { t } = useTranslation('files')
  const { result } = diff
  if (error && !result) return <Notice title={t('diff.failed')} description={error} />
  if (!result) return <Lines />
  if (result.binary) {
    return <Notice title={t('preview.binaryTitle')} description={t('diff.binaryDescription')} />
  }
  if (result.tooLarge) {
    return <Notice title={t('diff.tooLargeTitle')} description={t('diff.tooLargeDescription')} />
  }
  return <Notice title={t('diff.sameTitle')} description={t('diff.sameDescription')} />
}

function Changes({
  projectPath,
  diff,
  result,
  onShowFile,
}: {
  projectPath: string
  diff: DiffView
  result: FileDiff
  onShowFile: () => void
}) {
  const { t } = useTranslation(['files', 'composer'])
  const scroller = useRef<HTMLDivElement>(null)
  const fileDiff = useParsedDiff(result.path, result.oldText, result.newText ?? '')
  const [selected, setSelected] = useState<SelectedLineRange | null>(null)
  const [miss, setMiss] = useState<MentionMiss | null>(null)
  const onSelect = useCallback((range: SelectedLineRange | null) => {
    setSelected(range)
    setMiss(null)
  }, [])
  // Lines of a commit are not the file as it is now, so only the working tree's are mentioned.
  const mentionable = diff.ref === null && diff.projectFile !== null
  const lines = mentionable ? selectedLines(selected) : null

  const mention = (): void => {
    if (!lines || diff.projectFile === null) return
    const missed = mentionLines(projectPath, diff.projectFile, lines)
    setMiss(missed)
    if (!missed) setSelected(null)
  }

  return (
    <>
      <Bar diff={diff} onShowFile={onShowFile} hunks={fileDiff.hunks.length} scroller={scroller} />
      <div
        className="kp-doc__body flex flex-col"
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
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-9 outline-none"
        >
          <FilesDiff fileDiff={fileDiff} selected={selected} onSelect={onSelect} />
        </div>
        {miss ? (
          <span className="kp-doc__hint" data-tone="error">
            {miss === 'full' ? t('composer:attachments.limit') : t('diff.noComposer')}
          </span>
        ) : lines ? (
          <button type="button" className="kp-lines" onClick={mention}>
            <PaneIcon icon={AtIcon} size={13} />
            {lines[0] === lines[1]
              ? t('diff.mentionLine', { line: lines[0] })
              : t('diff.mentionLines', { start: lines[0], end: lines[1] })}
          </button>
        ) : (
          <span className="kp-doc__hint">
            {mentionable ? t('diff.selectHint') : t('diff.atCommit')}
          </span>
        )}
      </div>
    </>
  )
}
