// The web client's themes: the theme files are on the host, which any of its owner's clients may
// install or remove, and this browser keeps which one it shows, as a window keeps its own.

import { safeName } from '@shared/file-name'
import type { KettuApi } from '@shared/ipc'
import type {
  HostAdminMethod,
  HostAdminParams,
  HostAdminResult,
  HostThemes,
} from '@shared/remote/host-admin'
import type { SettingsFile, SettingsPatch } from '@shared/settings'
import {
  BUILTIN_THEME_ID,
  parseThemeFile,
  THEME_MAX_BYTES,
  type ThemeLoadFailure,
  type ThemesState,
} from '@shared/themes'

/** Where the host's last list is kept, so a reload shows this browser's theme at once. */
const KEY = 'kettu.themes'
// Fatal, as the host reads a file, so one that is not UTF-8 is refused rather than mangled.
const UTF8 = new TextDecoder('utf-8', { fatal: true })

export type AdminCall = <M extends HostAdminMethod>(
  method: M,
  ...params: HostAdminParams<M> extends undefined ? [] : [HostAdminParams<M>]
) => Promise<HostAdminResult<M>>

export interface WebThemesDeps {
  admin: AdminCall
  onHostChanged(listener: (themes: HostThemes) => void): () => void
  /** Each connection, after which the host's list is read again. */
  onConnected(listener: () => void): () => void
  settings: {
    current(): SettingsFile
    update(patch: SettingsPatch): Promise<SettingsFile>
    onChanged(listener: (settings: SettingsFile) => void): () => void
  }
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Asks for a theme file in the browser; null when the user cancels. */
  pickFile(): Promise<File | null>
  download(blob: Blob, name: string): void
  copyPath(path: string): Promise<void>
}

/** What this browser shows: the host's themes, with the one it chose and why that one fails. */
export function themesState(host: HostThemes, chosen: string): ThemesState {
  const { installed } = host
  if (chosen === BUILTIN_THEME_ID || installed.some(({ id }) => id === chosen)) {
    return { installed, chosen, failed: null }
  }
  const failure: ThemeLoadFailure = host.failed.find(({ id }) => id === chosen)?.failure ?? {
    code: 'missing',
  }
  return { installed, chosen, failed: { id: chosen, failure } }
}

function kept(storage: WebThemesDeps['storage']): HostThemes {
  try {
    const value = JSON.parse(storage?.getItem(KEY) ?? 'null') as HostThemes | null
    if (value && Array.isArray(value.installed) && Array.isArray(value.failed)) return value
  } catch {
    // An unreadable copy is dropped; the host's list replaces it once read.
  }
  return { installed: [], failed: [] }
}

export function webThemes(deps: WebThemesDeps): KettuApi['themes'] {
  let host = kept(deps.storage)
  // Whether the host's list was read since the page loaded, or only kept from last time.
  let fresh = false
  const listeners = new Set<(state: ThemesState) => void>()
  const chosen = (): string => deps.settings.current().appearance.colorTheme
  let shown = chosen()
  const state = (): ThemesState => themesState(host, chosen())
  const publish = (): void => {
    const next = state()
    for (const listener of listeners) listener(next)
  }
  const take = (next: HostThemes): void => {
    host = next
    fresh = true
    try {
      deps.storage?.setItem(KEY, JSON.stringify(next))
    } catch {
      // Without storage a reload shows the built-in theme until the host answers.
    }
    publish()
  }
  const read = async (): Promise<ThemesState> => {
    take(await deps.admin('themes.get'))
    return state()
  }
  deps.onHostChanged(take)
  deps.onConnected(() => {
    read().catch((error: unknown) => console.error("Could not read the host's themes", error))
  })
  deps.settings.onChanged((file) => {
    if (file.appearance.colorTheme === shown) return
    shown = file.appearance.colorTheme
    publish()
  })
  const choose = (id: string) => deps.settings.update({ appearance: { colorTheme: id } })
  /** Shows the theme an install showed, as a window's install chooses it. */
  const installed = async <R extends { status: string; id?: string; show?: boolean }>(
    result: R,
  ): Promise<R> => {
    if (result.status === 'installed' && result.show && result.id) await choose(result.id)
    return result
  }

  return {
    // The list kept from last time answers at once; the host's comes through `onChanged`.
    get: async () => {
      if (!fresh) read().catch(() => {})
      return state()
    },
    install: async () => {
      const file = await deps.pickFile()
      if (!file) return { status: 'cancelled' }
      if (file.size > THEME_MAX_BYTES) {
        return { status: 'failed', file: file.name, error: { code: 'too-large' } }
      }
      let text: string
      try {
        text = UTF8.decode(await file.arrayBuffer())
      } catch (error) {
        const code = error instanceof TypeError ? 'not-json' : 'unreadable'
        return { status: 'failed', file: file.name, error: { code } }
      }
      return installed(await deps.admin('themes.add', { file: file.name, text }))
    },
    replace: async (token) => installed(await deps.admin('themes.replace', { token })),
    remove: async (id) => {
      await deps.admin('themes.remove', { id })
      if (id === chosen()) await choose(BUILTIN_THEME_ID)
    },
    // The browser saves it where it saves downloads and says so itself.
    export: async (text) => {
      const parsed = parseThemeFile(text)
      if (!parsed.ok) throw new Error(`Not a theme file: ${parsed.error.code}`)
      deps.download(
        new Blob([text], { type: 'application/json' }),
        `${safeName(parsed.theme.name, 'theme')}.json`,
      )
      return null
    },
    reveal: async (id) => deps.copyPath(await deps.admin('themes.path', { id })),
    catalog: (refresh) => deps.admin('themes.catalog', { refresh }),
    installCatalog: async (id) => installed(await deps.admin('themes.installCatalog', { id })),
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Asks for a theme file through a file input; null when the user closes the chooser. */
export function pickThemeFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}
