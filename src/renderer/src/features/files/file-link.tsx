import type { ReactNode } from 'react'
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
  return (
    <button
      type="button"
      data-file-ref=""
      title={`Open ${file.path}${file.line ? `:${file.line}` : ''}`}
      onClick={() => openFile(file.projectPath, file.path, file.line)}
    >
      {children}
    </button>
  )
}
