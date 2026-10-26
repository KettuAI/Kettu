import { useTranslation } from 'react-i18next'
import { openFile } from '@renderer/stores/files'
import type { FileRef } from './file-refs'
import { FileTypeIcon } from './file-type-icon'
import { nameOf } from './paths'

/**
 * A file reference in a reply, as a chip: the file's type icon and its name, with the path in
 * its tooltip. It opens the file in the Files pane at its line.
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
      <FileTypeIcon path={file.path} className="size-3" />
      <span>{nameOf(file.path)}</span>
      {file.line && <span className="-ml-[3px]">:{file.line}</span>}
    </button>
  )
}
