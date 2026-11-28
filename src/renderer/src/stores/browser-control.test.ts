import { describe, expect, it } from 'vitest'
import { activeBrowserControl, type BrowserState } from '@shared/browser'
import { IDLE_CONTROL, type SurfaceControl } from '@shared/control'
import { closedTakeoverBrowserPanels } from './browser'

function makeState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    sessionId: 's1',
    tabs: [
      {
        id: 't1',
        url: 'http://localhost:3000/',
        title: 'App',
        loading: false,
        released: false,
        opener: null,
        by: 'agent',
        allowed: false,
      },
    ],
    selected: 't1',
    agentTab: 't1',
    url: 'http://localhost:3000/',
    page: true,
    viewport: null,
    agentUsed: true,
    title: 'App',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    notice: null,
    control: IDLE_CONTROL,
    originRequest: null,
    annotating: false,
    ...overrides,
  }
}

describe('activeBrowserControl (#2927)', () => {
  it('returns null when idle or when takeover/ask has no live agent tab', () => {
    expect(activeBrowserControl(undefined)).toBeNull()
    expect(activeBrowserControl(makeState({ control: IDLE_CONTROL }))).toBeNull()

    const you: SurfaceControl = { kind: 'you', since: 100 }
    const asks: SurfaceControl = {
      kind: 'asks',
      ask: { id: 1, step: 'sign_in', target: 'example.com', reason: 'Sign in' },
    }
    expect(activeBrowserControl(makeState({ control: you }))).toEqual(you)
    expect(activeBrowserControl(makeState({ control: asks }))).toEqual(asks)

    // Closed all tabs or lost the agent tab: label and turn status must never stay stuck.
    expect(activeBrowserControl(makeState({ control: you, tabs: [], agentTab: null }))).toBeNull()
    expect(activeBrowserControl(makeState({ control: you, agentTab: null }))).toBeNull()
    expect(activeBrowserControl(makeState({ control: asks, agentTab: null }))).toBeNull()

    // Agent navigation may enter `agent` state just before the first tab mounts.
    const agent: SurfaceControl = { kind: 'agent', acting: true }
    expect(activeBrowserControl(makeState({ control: agent, tabs: [], agentTab: null }))).toEqual(
      agent,
    )
  })
})

describe('closedTakeoverBrowserPanels (#2927)', () => {
  it('detects closing the browser side panel during takeover without false positives', () => {
    const takenOver = makeState({ control: { kind: 'you', since: 100 } })
    const agentDriven = makeState({
      sessionId: 's2',
      control: { kind: 'agent', acting: true },
    })
    const bySession = { s1: takenOver, s2: agentDriven }

    // Collapsing the browser panel while user holds takeover triggers release.
    expect(closedTakeoverBrowserPanels({ s1: 'browser' }, {}, bySession)).toEqual(['s1'])

    // Switching the side panel to another tab (e.g. files) keeps takeover intact.
    expect(closedTakeoverBrowserPanels({ s1: 'browser' }, { s1: 'files' }, bySession)).toEqual([])

    // Switching to another session keeps s1's sidePane as 'browser' so takeover stays intact.
    expect(
      closedTakeoverBrowserPanels({ s1: 'browser' }, { s1: 'browser', s2: 'files' }, bySession),
    ).toEqual([])

    // Closing the browser panel while the agent (not user takeover) is driving does not release it.
    expect(closedTakeoverBrowserPanels({ s2: 'browser' }, {}, bySession)).toEqual([])
  })
})
