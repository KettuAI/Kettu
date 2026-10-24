// What the user chose to attach: main checks each path and grants it to the agent host, which
// reads nothing else.

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
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
