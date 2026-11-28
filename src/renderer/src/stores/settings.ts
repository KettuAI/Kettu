import { userFontStack } from '@shared/font-stack'
import {
  DEFAULT_SETTINGS,
  isFontFamilyName,
  USER_FONT_ROLES,
  type CodeSize,
  type ConversationWidth,
  type SettingsFile,
  type UserFonts,
} from '@shared/settings'
import { showColorMode } from '@renderer/lib/color-mode'
import { applyLanguage } from '@renderer/lib/i18n'
import { useSettingsStore, type SettingsStore } from './settings-store'
import { setThreadWidth } from './thread-width'

export { useSettingsStore, type SettingsStore }

const darkQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

/** Applies the user's primary and optional Chinese fonts onto `:root`. */
export function applyUserFonts(root: HTMLElement, fonts: UserFonts): void {
  for (const role of USER_FONT_ROLES) {
    const stack = userFontStack(role, fonts)
    if (stack) root.style.setProperty(`--user-${role}-face`, stack)
    else root.style.removeProperty(`--user-${role}-face`)
    const primary = fonts[role]
    if (primary && isFontFamilyName(primary)) root.setAttribute(`data-user-font-${role}`, '')
    else root.removeAttribute(`data-user-font-${role}`)
  }
}

/** Applies the selected code font size preset onto `:root`. */
export function applyCodeSize(root: HTMLElement, size: CodeSize): void {
  root.dataset.codeSize = size
}

/** Applies the selected conversation width preset onto `:root`. */
export function applyConversationWidth(root: HTMLElement, width: ConversationWidth): void {
  root.dataset.conversationWidth = width
}

export function applyAppearance(settings: SettingsFile, fade = false): void {
  const root = document.documentElement
  const { theme, textSize, codeSize, conversationWidth, reduceMotion, zoom, fonts } =
    settings.appearance
  const dark = theme === 'dark' || (theme === 'system' && (darkQuery?.matches ?? false))
  showColorMode(dark ? 'dark' : 'light', fade)
  root.dataset.textSize = textSize
  applyCodeSize(root, codeSize)
  applyConversationWidth(root, conversationWidth)
  root.dataset.reduceMotion = reduceMotion
  root.style.setProperty('--zoom', String(zoom))
  applyUserFonts(root, fonts)
}

/**
 * Loads the settings, applies appearance as attributes on <html> and the language, and follows
 * every change.
 */
export async function initSettings(): Promise<void> {
  applyAppearance(DEFAULT_SETTINGS)
  darkQuery?.addEventListener('change', () => {
    const { settings, loaded } = useSettingsStore.getState()
    applyAppearance(settings, loaded)
  })
  useSettingsStore.subscribe((state, previous) => {
    // The settings read at launch replace the defaults at once; later changes fade.
    if (state.settings.appearance !== previous.settings.appearance) {
      applyAppearance(state.settings, previous.loaded)
    }
    // Switching the preset after launch clears any prior drag override so it takes effect at once.
    if (
      previous.loaded &&
      state.settings.appearance.conversationWidth !== previous.settings.appearance.conversationWidth
    ) {
      setThreadWidth(null)
    }
    if (state.settings.general.language !== previous.settings.general.language) {
      applyLanguage(state.settings.general.language)
    }
  })
  window.kettu.settings.onChanged((settings) => useSettingsStore.setState({ settings }))
  const settings = await window.kettu.settings.get()
  useSettingsStore.setState({ settings, loaded: true })
  applyAppearance(settings)
  applyLanguage(settings.general.language)
}

/** Whether motion is reduced right now, from the setting or the OS. */
export function prefersReducedMotion(): boolean {
  return (
    useSettingsStore.getState().settings.appearance.reduceMotion === 'always' ||
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  )
}
