import { errorMessage } from './host'
import { i18n } from './i18n'

// The host's reasons for refusing a memory request, as `data.reason` carries them.
const REASONS = {
  memory_secret: 'secret',
  memory_full: 'full',
  memory_changed: 'changed',
  memory_gone: 'gone',
  memory_off: 'off',
  memory_not_found: 'notFound',
} as const

/** Why the host refused a memory request, in the user's language; null for another error. */
export function memoryRefusal(error: unknown): string | null {
  const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
  if (typeof reason !== 'string' || !Object.hasOwn(REASONS, reason)) return null
  return i18n.t(`settings:memory.errors.${REASONS[reason as keyof typeof REASONS]}`)
}

/** What to show for a failed memory request: the refusal's reason, else the host's own words. */
export function memoryErrorText(error: unknown): string {
  return memoryRefusal(error) ?? errorMessage(error)
}
