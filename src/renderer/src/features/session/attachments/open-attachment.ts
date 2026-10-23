import type { Attachment } from '@shared/thread'
import { fileUrlPath, relativePath } from '@renderer/lib/format'
import { openFile } from '@renderer/stores/files'

/**
 * Opens a file or folder attachment: a file in the session's project in the Files pane, any other
 * file or folder in the file manager.
 */
export async function openAttachmentPath(
  attachment: Pick<Attachment, 'type' | 'uri'>,
  projectPath: string | null,
): Promise<void> {
  const path = attachment.uri ? fileUrlPath(attachment.uri, window.overbench.platform) : null
  if (!path) return
  if (attachment.type === 'file' && projectPath) {
    const inside = relativePath(path, projectPath)
    if (inside !== path) return openFile(projectPath, inside.replace(/\\/g, '/'))
  }
  await window.overbench.shell.showItem(path)
}
