import { FileIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openFile } from '@renderer/stores/files'
import type { FileRef } from './file-refs'
import { nameOf } from './paths'

/**
 * A file reference in a reply, as a chip: a document icon and the file's name, with the path in
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
      <FileIcon className="size-3.25 text-tertiary" />
      <span>{nameOf(file.path)}</span>
      {file.line && <span className="-ml-[3px]">:{file.line}</span>}
    </button>
  )
}
