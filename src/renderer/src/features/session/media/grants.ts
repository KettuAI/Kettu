import { createContext } from 'react'
import type { MediaOpenResult } from '@shared/media'
import { host } from '@renderer/lib/host'

/**
 * The session of the agent reply being rendered, whose naming of a file lets its image through.
 * Only agent replies provide it, so images in thoughts, tool output and previews stay as text.
 */
export const SessionIdContext = createContext<string | null>(null)

/** The entry being rendered, by which the viewer knows its media. */
export const EntryIdContext = createContext<string | null>(null)

const MAX_GRANTS = 500
const granted = new Map<string, Promise<MediaOpenResult>>()

/**
 * The host's answer for an image the thread names. A grant is kept for the run, so a reply that
 * renders again reuses it; anything else is asked again, since the file may appear meanwhile.
 * `fresh` asks again anyway, for a grant main has dropped.
 */
export function openMedia(
  projectPath: string,
  path: string,
  sessionId: string,
  fresh = false,
): Promise<MediaOpenResult> {
  const key = `${sessionId}\0${projectPath}\0${path}`
  const kept = fresh ? undefined : granted.get(key)
  if (kept) return kept
  const request = host('media.open', { projectPath, path, sessionId })
  granted.delete(key)
  request.then(
    (result) => {
      if (result.kind !== 'granted') return
      granted.set(key, request)
      for (const old of granted.keys()) {
        if (granted.size <= MAX_GRANTS) break
        granted.delete(old)
      }
    },
    () => {},
  )
  return request
}
