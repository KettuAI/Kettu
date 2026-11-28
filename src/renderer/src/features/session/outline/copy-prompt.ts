import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { useThreadsStore } from '@renderer/stores/threads'
import { userText } from '../entries/user-text'

/** Whether extracted prompt text contains non-whitespace content worth copying. */
export function hasCopyablePrompt(text: string): boolean {
  return text.trim().length > 0
}

/**
 * Returns the full prompt text for `entryId` when the entry is already in the session replica, or
 * `null` if it lives on an unloaded page and must be fetched from the host.
 */
export function loadedPromptText(sessionId: string, entryId: string): string | null {
  const entry = useThreadsStore.getState().replicas[sessionId]?.state?.byId[entryId]
  if (entry?.kind !== 'user') return null
  return userText(entry.content)
}

/** Resolves a user prompt's full text from the loaded replica, falling back to `sessions.entry`. */
export async function resolvePromptText(sessionId: string, entryId: string): Promise<string> {
  const loaded = loadedPromptText(sessionId, entryId)
  if (loaded !== null) return loaded
  const entry = await host('sessions.entry', { sessionId, entryId })
  return entry.kind === 'user' ? userText(entry.content) : ''
}

function writeClipboard(text: string, copiedLabel: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return Promise.resolve(false)
  return clipboard.writeText(text).then(
    () => {
      toast(copiedLabel)
      return true
    },
    (error: unknown) => {
      toast(errorMessage(error))
      return false
    },
  )
}

/**
 * Copies a prompt's full text to the clipboard and shows feedback. Starts clipboard writes
 * synchronously whenever the text is already loaded so browser user activation is preserved.
 */
export function copyOutlinePrompt(
  sessionId: string,
  entryId: string,
  copiedLabel: string,
  prefetched?: string | Promise<string>,
): Promise<boolean> {
  const immediate =
    loadedPromptText(sessionId, entryId) ?? (typeof prefetched === 'string' ? prefetched : null)
  if (immediate !== null) {
    if (!hasCopyablePrompt(immediate)) return Promise.resolve(false)
    return writeClipboard(immediate, copiedLabel)
  }
  const pending = prefetched instanceof Promise ? prefetched : resolvePromptText(sessionId, entryId)
  return pending.then(
    (text) => (hasCopyablePrompt(text) ? writeClipboard(text, copiedLabel) : false),
    (error: unknown) => {
      toast(errorMessage(error))
      return false
    },
  )
}
