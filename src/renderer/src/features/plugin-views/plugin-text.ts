import { pluginText, type PluginTexts } from '@shared/plugins'
import type { PluginSurface } from '@renderer/stores/plugin-surfaces'

/** A text a manifest gives by language, in the language shown, else English, else any it has. */
export function languageText(texts: PluginTexts, locale: string): string {
  return pluginText(texts, Object.values(texts)[0] ?? '', locale)
}

/** A plugin's name as its package gives it, in the language shown. */
export function surfaceTitle(surface: Pick<PluginSurface, 'titles' | 'title'>, locale: string) {
  return pluginText(surface.titles, surface.title, locale)
}
