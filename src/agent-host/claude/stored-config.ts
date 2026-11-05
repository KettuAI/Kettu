import type { ConfigOption } from '@shared/thread'
import { OPTION_IDS, ultracodeOption } from './config'

/** Old threads displayed false even when no override had been chosen. */
export function restoreConfig(config: readonly ConfigOption[], legacy?: unknown): ConfigOption[] {
  const current = config.find((option) => option.id === OPTION_IDS.ultracode)
  if (current && 'defaultValue' in current) return [...config]
  const override =
    typeof legacy === 'object' && legacy !== null && 'ultracode' in legacy
      ? legacy.ultracode
      : undefined
  return [
    ...config.filter((option) => option.id !== OPTION_IDS.ultracode),
    ultracodeOption(typeof override === 'boolean' ? override : 'default'),
  ]
}
