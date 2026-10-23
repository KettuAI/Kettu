import { ATTACHMENT_LIMIT } from '@shared/attachments'

/**
 * The paths behind dropped or pasted files, "" for one with no file on disk. Only real `File`s
 * are taken: anything else a page passes, such as an object with its own `map`, could name a path.
 */
export function filePaths(files: unknown, pathOf: (file: File) => string): string[] {
  if (
    !Array.isArray(files) ||
    files.length > ATTACHMENT_LIMIT ||
    !files.every((file) => file instanceof File)
  ) {
    throw new Error(`Attachments take a list of at most ${ATTACHMENT_LIMIT} files`)
  }
  return files.map((file: File) => pathOf(file))
}
