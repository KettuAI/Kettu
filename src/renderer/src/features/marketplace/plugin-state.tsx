// The state Kettu judges a plugin to be in, as the Marketplace writes it: Ready, Needs setup with
// what is missing, Off, or Error once its script was stopped.

import { useTranslation } from 'react-i18next'
import { missingSettings, pluginState, type InstalledKettuPlugin } from '@shared/plugins'
import { missingWords } from './plugin-model'
import './plugin-state.css'

/** The state as a dot and its words: green Ready, amber Needs setup, red Error, gray Off. */
export function PluginStateMark({
  plugin,
  long = false,
}: {
  plugin: InstalledKettuPlugin
  /** Says what is missing in place of Needs setup, as an Installed row does. */
  long?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const state = pluginState(plugin)
  return (
    <span className="k-plug-state" data-state={state}>
      {long && state === 'needsSetup'
        ? t('plugin.state.needs', { what: missingWords(missingSettings(plugin)) })
        : t(`plugin.state.${state}`)}
    </span>
  )
}
