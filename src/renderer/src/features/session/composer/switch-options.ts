import { useTranslation } from 'react-i18next'
import { booleanConfigValue, type ConfigOption } from '@shared/thread'

export const isFast = (o: ConfigOption) => /fast/i.test(o.id)
export const isSpeedSelect = (o: ConfigOption) =>
  o.category === 'model_config' && o.type === 'select' && o.id === 'service-tier'
export const isStandardSpeedChoice = (value: string) =>
  value.trim().toLowerCase() === 'default' || value.trim().toLowerCase() === 'standard'
export const isUltrafastChoice = (value: string) => /ultra[\s_-]*fast/i.test(value)
export const isUltracode = (o: ConfigOption) => /ultracode/i.test(o.id)

/** Whether the option has no value of its own and follows the agent's setting. */
function follows(option: ConfigOption): boolean {
  return 'defaultValue' in option && option.value === 'default'
}

/** Whether a switch is held still while a turn runs. */
export function lockedNow(option: ConfigOption, running: boolean): boolean {
  return !!option.idleOnly && running
}

/** What a switch's second line says: why it cannot change now, whom it follows, or what it does. */
export function useSwitchLine(agent: string) {
  const { t } = useTranslation('composer')
  return (option: ConfigOption, running: boolean): string | undefined => {
    if (lockedNow(option, running)) return t('controls.changesBetweenTurns')
    if (!follows(option)) return option.description
    const value = booleanConfigValue(option)
    return value === true
      ? t('controls.followsAgentOn', { agent })
      : value === false
        ? t('controls.followsAgentOff', { agent })
        : t('controls.followsAgent', { agent })
  }
}
