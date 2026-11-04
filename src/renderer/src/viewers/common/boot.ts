// What every type viewer starts from: the page's config, the language and color mode, and the
// artifact's content, read through the `content` capability where the page has it, else from the
// served file, which shows it but cannot change it.

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  isArtifactTypeName,
  VIEWER_CONFIG_ID,
  type ViewerConfig,
  type ViewerView,
} from '@shared/artifact-types'
import { CONTENT_CAPABILITY, type ContentNamespace } from '@shared/artifact-runtime/content'
import { i18nOptions, isLocale } from '@shared/locale'
import en from '@shared/locales/en/viewers.json'
import zhCN from '@shared/locales/zh-CN/viewers.json'

/** The config the served page holds; the page was served by Kettu, so it is trusted as written. */
export function readConfig(): ViewerConfig | null {
  const element = document.getElementById(VIEWER_CONFIG_ID)
  try {
    const value = JSON.parse(element?.textContent ?? '') as Partial<ViewerConfig>
    if (
      !isArtifactTypeName(value.type) ||
      !Number.isSafeInteger(value.format) ||
      !Number.isSafeInteger(value.version) ||
      typeof value.entry !== 'string' ||
      !isLocale(value.locale)
    ) {
      return null
    }
    return value as ViewerConfig
  } catch {
    return null
  }
}

/** How the page shows, from its address: a card's thumbnail and a print ask for theirs. */
export function readView(): ViewerView {
  const view = new URLSearchParams(location.search).get('view')
  return view === 'thumbnail' || view === 'print' ? view : 'normal'
}

export function startI18n(config: ViewerConfig): void {
  void i18next
    .use(initReactI18next)
    .init(
      i18nOptions(config.locale, { en: { viewers: en }, 'zh-CN': { viewers: zhCN } }, 'viewers'),
    )
}

/** Follows the color mode, as the theme's own dark variant needs on the root. */
export function followColorMode(): void {
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const apply = () => (document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light')
  apply()
  dark.addEventListener('change', apply)
}

/** The served content file's text. */
export async function readServed(config: ViewerConfig): Promise<string> {
  const response = await fetch(config.entry, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${config.entry} answered ${response.status}`)
  return response.text()
}

interface Runtime {
  use?(name: string): Promise<unknown>
}

/** The `content` namespace, or null where the page has none, as in a published copy. */
export async function contentCapability(): Promise<ContentNamespace | null> {
  const runtime = (window as { kettu?: Runtime }).kettu
  if (typeof runtime?.use !== 'function') return null
  try {
    return ((await runtime.use(CONTENT_CAPABILITY)) as ContentNamespace | null) ?? null
  } catch {
    return null
  }
}

/** Why a write was refused, by the runtime's error code. */
export function writeFailure(error: unknown): { code: string; message: string } {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  return {
    code: typeof code === 'string' ? code : 'failed',
    message: typeof message === 'string' ? message : '',
  }
}

/** Tells a print that the pages are laid out and their pictures loaded. */
export async function markReady(): Promise<void> {
  await document.fonts.ready
  await Promise.all(
    [...document.images].map((image) =>
      image.complete
        ? null
        : new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', resolve, { once: true })
          }),
    ),
  )
  document.documentElement.dataset.ready = 'true'
}

/** The slide or place to come back to after the page loads a new version, where it may keep one. */
export const remembered = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value)
    } catch {
      // A frame on an opaque origin keeps nothing.
    }
  },
}
