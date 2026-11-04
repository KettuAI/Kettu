// The writes Kettu makes to a typed artifact itself: the user's edits in its viewer, and the move
// of its content to a newer format when it is opened.

import { INLINE_FILE_BYTES, VERSION_BYTES } from '@shared/artifact-files'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import type { LogFn } from '../../storage'
import { t } from '../../i18n'
import type { FileChange } from '../model'
import { ArtifactError, type ArtifactStore } from '../store'
import type { ArtifactTypes } from './registry'

/** Why a viewer's write was refused, with the runtime's code for it. */
export class ContentWriteError extends Error {
  constructor(
    readonly code: 'invalid' | 'too_large' | 'unsupported',
    message: string,
  ) {
    super(message)
    this.name = 'ContentWriteError'
  }
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * The user's new content text, as a new version from `baseVersion`, which must be the latest; the
 * pictures stay as they are. Checked against the version's format, which it keeps.
 */
export async function writeContent(
  store: ArtifactStore,
  types: ArtifactTypes,
  input: { id: string; baseVersion: number; text: string },
): Promise<{ version: number }> {
  const base = await store.get(input.id)
  const type = base.type
  if (!type) throw new ContentWriteError('unsupported', `${input.id} is not made from a type`)
  if (base.artifact.deletedAt !== null) {
    throw new ArtifactError('deleted', `${input.id} is in Recently deleted`, {
      version: base.artifact.head,
      deleted: true,
    })
  }
  if (base.artifact.head !== input.baseVersion) {
    throw new ArtifactError('conflict', 'Not the latest version', {
      version: base.artifact.head,
      deleted: false,
    })
  }
  const entry = CONTENT_ENTRIES[type.name]
  const bytes = Buffer.from(input.text, 'utf8')
  if (bytes.length > INLINE_FILE_BYTES) {
    throw new ContentWriteError('too_large', `${entry} may be at most 5 MiB`)
  }
  const total =
    base.files.reduce((sum, file) => sum + (file.path === entry ? 0 : file.size), 0) + bytes.length
  if (total > VERSION_BYTES)
    throw new ContentWriteError('too_large', 'The version would be too large')
  types.check(type, {
    paths: new Set([...base.files.map((file) => file.path), entry]),
    entry: input.text,
    changed: new Map([[entry, bytes]]),
  })
  return store.write({
    id: input.id,
    baseVersion: input.baseVersion,
    changes: [{ path: entry, data: bytes }],
    pages: 1,
    author: null,
    note: null,
    type,
  })
}

/**
 * Moves the latest version's content to its type's current format as a new version, when it is
 * in an older one; the new version is the user's. Returns it, or null when there was nothing to
 * move or it could not be moved, which leaves the old version shown by its own format's viewer.
 */
export async function upgradeContent(
  store: ArtifactStore,
  types: ArtifactTypes,
  id: string,
  log: LogFn,
): Promise<number | null> {
  const found = await store.get(id)
  const type = found.type
  if (!type || found.artifact.deletedAt !== null) return null
  const current = types.current(type.name)
  if (type.format >= current) return null
  try {
    const before = new Map<string, Uint8Array>()
    for (const file of found.files) before.set(file.path, await store.bytes(found, file))
    const moved = types.migrate(type, before)
    const changes: FileChange[] = []
    for (const [path, bytes] of moved.files) {
      const was = before.get(path)
      if (!was || Buffer.compare(Buffer.from(was), Buffer.from(bytes)) !== 0) {
        changes.push({ path, data: bytes })
      }
    }
    for (const path of before.keys()) if (!moved.files.has(path)) changes.push({ path, data: null })
    const entry = moved.files.get(CONTENT_ENTRIES[type.name])
    types.check(
      { name: type.name, format: moved.format },
      {
        paths: new Set(moved.files.keys()),
        entry: entry ? utf8(entry) : null,
        changed: new Map(changes.flatMap((c) => (c.data ? [[c.path, c.data] as const] : []))),
      },
    )
    const { version } = await store.write({
      id,
      baseVersion: found.artifact.head,
      changes,
      pages: 1,
      author: null,
      note: t('artifacts.formatUpgraded', { format: moved.format }),
      type: { name: type.name, format: moved.format },
    })
    log('info', `Moved ${id} to ${type.name} format ${moved.format} as version ${version}`)
    return version
  } catch (error) {
    // Another write may have come first; the next open tries again.
    log('warn', `${id} stays in ${type.name} format ${type.format}: ${(error as Error).message}`)
    return null
  }
}
