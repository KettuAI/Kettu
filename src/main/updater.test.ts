import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { AppState, AppStateStore } from './app-state'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1', isPackaged: true } }))
vi.mock('./events', () => ({ broadcast: vi.fn() }))
vi.mock('./auto-updater', () => ({
  loadAutoUpdater: () =>
    Promise.reject(new TypeError("Cannot set properties of undefined (setting 'logger')")),
}))

const { Updater } = await import('./updater')

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('shows an automatic check that could not load electron-updater as failed', async () => {
  vi.useFakeTimers()
  // Linux builds update only as an AppImage.
  vi.stubEnv('APPIMAGE', '/opt/OverBench.AppImage')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let state: AppState = { lastRunVersion: '0.0.1', dismissedUpdate: null }
  const appState = {
    get: () => state,
    update: (changes: Partial<AppState>) => (state = { ...state, ...changes }),
  } as unknown as AppStateStore
  const updater = new Updater({ appState, settings: () => DEFAULT_SETTINGS, requestRestart() {} })
  updater.start()
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(() =>
    expect(updater.getStatus().state).toEqual({
      kind: 'error',
      message: "Cannot set properties of undefined (setting 'logger')",
      manual: false,
    }),
  )
})
