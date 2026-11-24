import type { TFunction } from 'i18next'
import type { CommandSource } from '@shared/thread'

/**
 * Where a command comes from as the list names it: its plugin, Yours or Kettu; null for the
 * agent's own, which the list marks with the agent's own mark.
 */
export function commandSourceName(
  source: CommandSource | undefined,
  t: TFunction<'composer'>,
): string | null {
  if (!source) return null
  if (source.kind === 'plugin') return source.title
  return source.kind === 'user' ? t('slash.yours') : t('slash.kettu')
}
