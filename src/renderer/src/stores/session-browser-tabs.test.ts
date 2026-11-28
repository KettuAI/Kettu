import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionBrowserTab } from '@shared/browser'
import { IDLE_CONTROL } from '@shared/control'

const { localRequest, remoteRequest } = vi.hoisted(() => {
  const localRequest = vi.fn()
  const remoteRequest = vi.fn()
  ;(globalThis as { window?: unknown }).window = {
    kettu: {
      platform: 'darwin',
      client: 'web',
      hostPlatform: () => 'darwin',
      systemLocale: 'en',
      agents: { request: localRequest },
      hosts: { request: remoteRequest },
    },
  }
  return { localRequest, remoteRequest }
})

import {
  mentionResolver,
  surfaceMention,
  surfaceRefs,
} from '@renderer/features/session/composer/chips'
import {
  effectiveBrowserTabs,
  matchBrowserTabMentions,
  mentionSurfacesOf,
} from '@renderer/features/session/composer/mention-surfaces'
import { forgetSessionHost, learnSessionHosts } from '@renderer/lib/host'
import { useBrowserStore } from './browser'
import {
  clearHostSessionBrowserTabs,
  forgetSessionBrowserTabs,
  hostBrowserTabsOpened,
  loadSessionBrowserTabs,
  receiveSessionBrowserTabs,
  resetSessionBrowserTabs,
  useSessionBrowserTabsStore,
} from './session-browser-tabs'

const reportedTab: SessionBrowserTab = {
  id: 't1',
  url: 'https://example.com/docs',
  title: 'Docs',
  active: true,
  by: 'user',
  allowed: false,
}

describe('session-browser-tabs store and mention wiring', () => {
  beforeEach(() => {
    localRequest.mockReset()
    remoteRequest.mockReset()
    resetSessionBrowserTabs()
    useBrowserStore.setState({ bySession: {}, stills: {}, unseen: {} })
  })

  afterEach(() => {
    forgetSessionHost('s-remote')
    forgetSessionHost('s-old')
  })

  it('loads reported tabs from the target host (local/web or remote) and builds page mentions', async () => {
    localRequest.mockResolvedValue({ tabs: [reportedTab] })
    const remoteTab: SessionBrowserTab = {
      id: 't2',
      url: 'http://localhost:5173/app',
      title: 'Preview App',
      active: true,
      by: 'agent',
      allowed: true,
    }
    remoteRequest.mockResolvedValue({ tabs: [remoteTab] })
    learnSessionHosts('host-b', ['s-remote'])

    expect(await loadSessionBrowserTabs('s-web')).toEqual([reportedTab])
    expect(localRequest).toHaveBeenCalledWith('browser.tabs', { sessionId: 's-web' })

    expect(await loadSessionBrowserTabs('s-remote')).toEqual([remoteTab])
    expect(remoteRequest).toHaveBeenCalledWith('host-b', 'browser.tabs', { sessionId: 's-remote' })

    // Composer mention resolution finds the host-reported tab and emits a page ref on send.
    const surfaces = mentionSurfacesOf('s-web')
    expect(surfaces.page).toEqual([{ id: 't1', name: 'Docs' }])
    const token = surfaceMention('page', 't1')
    const refs = surfaceRefs(`Check ${token} please`, mentionResolver([], null, surfaces))
    expect(refs).toEqual([{ kind: 'page', tabId: 't1', name: 'Docs' }])

    // Composer `@` mention matching filters by title, URL, or mention token.
    const listed = effectiveBrowserTabs(
      undefined,
      useSessionBrowserTabsStore.getState().bySession['s-remote'],
    )
    expect(matchBrowserTabMentions(listed, '')).toEqual([
      {
        browserTab: true,
        id: 't2',
        name: 'Preview App',
        url: 'http://localhost:5173/app',
        active: true,
        mention: 'page:t2',
      },
    ])
    expect(matchBrowserTabMentions(listed, '5173')).toHaveLength(1)
    expect(matchBrowserTabMentions(listed, 'nomatch')).toEqual([])
  })

  it('gracefully falls back to an empty list when talking to an older host without browser.tabs', async () => {
    remoteRequest.mockRejectedValue({ code: 'unknown_method', message: 'Unknown' })
    learnSessionHosts('host-old', ['s-old'])

    expect(await loadSessionBrowserTabs('s-old')).toEqual([])
    expect(remoteRequest).toHaveBeenCalledTimes(1)

    // Subsequent calls on the same connection skip hitting the older host again.
    expect(await loadSessionBrowserTabs('s-old')).toEqual([])
    expect(remoteRequest).toHaveBeenCalledTimes(1)

    // After reconnect (e.g. host upgraded), querying is re-enabled.
    remoteRequest.mockResolvedValueOnce({ tabs: [reportedTab] })
    hostBrowserTabsOpened('host-old')
    expect(await loadSessionBrowserTabs('s-old')).toEqual([reportedTab])
    expect(remoteRequest).toHaveBeenCalledTimes(2)
  })

  it('prefers local desktop tabs when present and isolates host/session cleanup', () => {
    learnSessionHosts('host-b', ['s-remote'])
    receiveSessionBrowserTabs('s-local', [reportedTab])
    receiveSessionBrowserTabs('s-remote', [{ ...reportedTab, id: 't-rem', title: 'Remote' }])

    // Local Electron tabs take precedence over host-reported tabs for the same session.
    useBrowserStore.setState({
      bySession: {
        's-local': {
          sessionId: 's-local',
          tabs: [
            {
              id: 't-local',
              url: 'https://local.test/',
              title: 'Local Window',
              loading: false,
              released: false,
              opener: null,
              by: 'user',
              allowed: false,
            },
          ],
          selected: 't-local',
          agentTab: null,
          url: 'https://local.test/',
          page: true,
          viewport: null,
          agentUsed: false,
          title: 'Local Window',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          notice: null,
          control: IDLE_CONTROL,
          originRequest: null,
          annotating: false,
        },
      },
    })
    expect(mentionSurfacesOf('s-local').page).toEqual([{ id: 't-local', name: 'Local Window' }])
    expect(mentionSurfacesOf('s-remote').page).toEqual([{ id: 't-rem', name: 'Remote' }])

    // Clearing host-b removes only host-b's reported tabs.
    clearHostSessionBrowserTabs('host-b')
    expect(useSessionBrowserTabsStore.getState().bySession['s-remote']).toBeUndefined()
    expect(useSessionBrowserTabsStore.getState().bySession['s-local']).toEqual([reportedTab])

    // Removing a session forgets its reported tabs cleanly.
    forgetSessionBrowserTabs('s-local')
    expect(useSessionBrowserTabsStore.getState().bySession['s-local']).toBeUndefined()
  })
})
