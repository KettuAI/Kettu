// What the user chose to attach: main checks each path and grants it to the agent host, which
// reads nothing else.

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttachmentGrant, GrantedAttachment } from '@shared/attachments'

/** Grants each path that is a file or a folder; in their order, null for any other. */
export async function grantPaths(
  paths: readonly string[],
  grant: (grants: AttachmentGrant[]) => Promise<void>,
): Promise<(GrantedAttachment | null)[]> {
  const checked = await Promise.all(
    paths.map(async (path) => {
      const info = await stat(path).catch(() => null)
      const kind = info?.isDirectory() ? 'folder' : info?.isFile() ? 'file' : null
      if (!info || !kind) return null
      const grantId = randomUUID()
      return {
        grant: { grantId, path, kind },
        granted: {
          grantId,
          name: basename(path) || path,
          kind,
          size: kind === 'file' ? info.size : null,
        },
      } satisfies { grant: AttachmentGrant; granted: GrantedAttachment }
    }),
  )
  await grant(checked.flatMap((item) => (item ? [item.grant] : [])))
  return checked.map((item) => item?.granted ?? null)
}

/** The local paths a `text/uri-list` names, in its order: its `file:` URIs, without comments. */
export function uriListPaths(list: string): string[] {
  return list.split(/\r?\n/).flatMap((line) => {
    const uri = line.trim()
    if (uri === '' || uri.startsWith('#')) return []
    try {
      return [fileURLToPath(uri)]
    } catch {
      return []
    }
  })
}

/**
 * Grants the files and folders copied in the file manager, read from the clipboard's
 * `text/uri-list`, in the order copied. Null when there is no list, or when it does not hold
 * `pastedPath`, the file the paste carried, so a call outside a paste of files reads nothing.
 */
export async function grantClipboardFiles(
  pastedPath: string,
  uriList: string | null,
  grant: (grants: AttachmentGrant[]) => Promise<void>,
): Promise<GrantedAttachment[] | null> {
  if (uriList === null) return null
  const paths = uriListPaths(uriList)
  const [pasted, ...listed] = await Promise.all([pastedPath, ...paths].map(comparable))
  if (!listed.includes(pasted!)) return null
  const granted = await grantPaths(paths, grant)
  return granted.flatMap((item) => (item ? [item] : []))
}

async function comparable(path: string): Promise<string> {
  const real = await realpath(path).catch(() => resolve(path))
  return process.platform === 'win32' ? real.toLowerCase() : real
}
