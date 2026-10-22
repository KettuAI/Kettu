import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { openFile } from '@renderer/stores/files'
import type { FileRef } from './file-refs'

/** A file reference in a reply, which opens the file in the Files pane at its line. */
export function FileLink({
  file,
  children,
}: {
  file: FileRef & { projectPath: string }
  children: ReactNode
}) {
  const { t } = useTranslation('files')
  return (
    <button
      type="button"
      data-file-ref=""
      title={t('link.open', { target: file.line ? `${file.path}:${file.line}` : file.path })}
      onClick={() => openFile(file.projectPath, file.path, file.line)}
    >
      {children}
    </button>
  )
}
