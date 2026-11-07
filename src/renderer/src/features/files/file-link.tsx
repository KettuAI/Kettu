import { useTranslation } from 'react-i18next'
import { openFile } from '@renderer/stores/files'
import { FileTypeIcon } from './file-type-icon'
import type { FileRef } from './file-refs'
import { nameOf } from './paths'

/**
 * A file reference in a reply, drawn like the thread's links: the file's icon and name over one
 * line, with the path in its tooltip. It opens the file in the Files pane at its line.
 */
export function FileLink({ file }: { file: FileRef & { projectPath: string } }) {
  const { t } = useTranslation('files')
  const target = file.line ? `${file.path}:${file.line}` : file.path
  return (
    <button
      type="button"
      data-file-ref=""
      title={target}
      aria-label={t('link.open', { target })}
      onClick={() => openFile(file.projectPath, file.path, file.line)}
    >
      {/* A button lays out as an inline block, so the line is drawn by an inline span inside it,
          at the same depth as a link's. */}
      <span className="thread-link">
        <FileTypeIcon
          path={file.path}
          className="relative -top-[1.5px] mr-1.5 inline-block size-4 align-middle"
        />
        {nameOf(file.path)}
        {file.line && <span className="text-tertiary">:{file.line}</span>}
      </span>
    </button>
  )
}
