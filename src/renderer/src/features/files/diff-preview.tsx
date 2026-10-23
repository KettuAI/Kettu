import { FileSymlinkIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CopyButton } from '@renderer/features/git/copy-button'
import { Diff } from '@renderer/features/session/markdown'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { closeDiff, openFile, type DiffView } from '@renderer/stores/files'
import { FileTypeIcon } from './file-type-icon'
import { Lines, Notice } from './file-preview'
import { folderOf, nameOf } from './paths'

/** A file's change from the branch popover: at a commit, or uncommitted against `HEAD`. */
export function DiffPreview({ projectPath, diff }: { projectPath: string; diff: DiffView }) {
  const { t } = useTranslation('files')
  const folder = folderOf(diff.path)
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-border-soft pr-1 pl-3 text-xs">
        <FileTypeIcon path={diff.path} className="mr-1 size-4" />
        <span
          className="flex min-w-0 flex-1 items-baseline gap-1.5"
          title={diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}
        >
          <span className="shrink-0 font-medium">{nameOf(diff.path)}</span>
          <span className="shrink-0 text-muted-foreground">
            {diff.ref ? (
              <span className="font-mono text-meta">{diff.ref.slice(0, 7)}</span>
            ) : (
              t('diff.uncommitted')
            )}
          </span>
          {folder && <span className="truncate text-muted-foreground">{folder}</span>}
        </span>
        {diff.projectFile !== null && (
          <PanelButton
            label={t('diff.openFile')}
            onClick={() => openFile(projectPath, diff.projectFile!)}
          >
            <FileSymlinkIcon />
          </PanelButton>
        )}
        <CopyButton text={diff.path} label={t('preview.copyPath')} />
        <PanelButton label={t('diff.close')} onClick={() => closeDiff(projectPath)}>
          <XIcon />
        </PanelButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <Body diff={diff} />
      </div>
    </div>
  )
}

function Body({ diff }: { diff: DiffView }) {
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
    <div className="absolute inset-0 overflow-y-auto overscroll-contain" data-selectable="">
      <Diff
        path={result.path}
        oldText={result.oldText}
        newText={result.newText ?? ''}
        className="file-preview"
      />
    </div>
  )
}
