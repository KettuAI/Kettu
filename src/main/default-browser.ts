// The system's default browser, which links from agents open in unless the user picks Kettu's own.

import type { DefaultBrowser } from '@shared/ipc'
import { createLogger, describeError } from './log'

const log = createLogger('default-browser')

// The icon draws at 16 px, so 32 px is sharp on a 2x display.
const ICON_SIZE = 32

/** What main reads the handler of `https:` links from: Electron's `app`, or a test's stand-in. */
export interface BrowserSource {
  /** The handler's name and icon; rejects where unsupported, as on Linux. */
  getApplicationInfoForProtocol(url: string): Promise<{
    name: string
    icon: { isEmpty(): boolean; resize(size: { width: number; height: number }): IconImage }
  }>
  getApplicationNameForProtocol(url: string): string
}

interface IconImage {
  toDataURL(): string
}

/**
 * A readable name from what the system calls the handler: the name without `.app` or `.exe`, and
 * on Linux a desktop entry's id such as `google-chrome.desktop` or `org.mozilla.firefox.desktop`
 * as words. Null when there is none.
 */
export function browserName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return null
  const entry = /^(.*)\.desktop$/i.exec(name)?.[1]
  if (entry === undefined) return name.replace(/\.(app|exe)$/i, '').trim() || null
  const id = entry.split('.').at(-1) ?? ''
  const words = id.split(/[-_\s]+/).filter(Boolean)
  if (words.length === 0) return null
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ')
}

/** The handler of `https:` links, its name and a small PNG of its icon as a data URL. */
export async function readDefaultBrowser(source: BrowserSource): Promise<DefaultBrowser> {
  try {
    const info = await source.getApplicationInfoForProtocol('https://')
    const icon = info.icon.isEmpty()
      ? null
      : info.icon.resize({ width: ICON_SIZE, height: ICON_SIZE }).toDataURL()
    const name = browserName(info.name)
    if (name) return { name, icon: icon?.startsWith('data:image/png;base64,') ? icon : null }
  } catch (error) {
    log.info(`No application info for https links: ${describeError(error)}`)
  }
  try {
    return { name: browserName(source.getApplicationNameForProtocol('https://')), icon: null }
  } catch (error) {
    log.warn(`Could not read the default browser: ${describeError(error)}`)
    return { name: null, icon: null }
  }
}

let cached: Promise<DefaultBrowser> | null = null

/** The default browser, read once per run. */
export function defaultBrowser(source: BrowserSource): Promise<DefaultBrowser> {
  cached ??= readDefaultBrowser(source)
  return cached
}
