import type { TFunction } from 'i18next'
import type { SettingsFile } from '@shared/settings'

export type SendKeySetting = SettingsFile['general']['sendKey']

/** The newline key hint shown under Settings > General > Send with for the active send key. */
export function sendKeyDescription(t: TFunction<'settings'>, sendKey: SendKeySetting): string {
  return t(
    sendKey === 'enter'
      ? 'general.sendKey.descriptionEnter'
      : 'general.sendKey.descriptionModEnter',
  )
}
