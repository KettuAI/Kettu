/** Why a player failed: the system's message for a read error, null for a format it cannot play. */
export function playerFailure(element: HTMLMediaElement): string | null {
  const error = element.error
  return error?.code === MediaError.MEDIA_ERR_NETWORK ? error.message || null : null
}
