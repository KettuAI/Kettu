import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PANEL = 's1'
const KEPT = 'p0123456789ab'
const GONE = 'pffffffffffff'

const file = { kind: 'file', id: 'src/a.ts', preview: false }
const pane = (pluginId: string, viewId: string, extra: object = {}) => ({
  kind: 'plugin',
  id: `${pluginId}/${viewId}`,
  pluginId,
  viewId,
  preview: false,
  ...extra,
})

/** The stores as a run that finds `saved` in the window's storage loads them. */
async function load(saved: object) {
  vi.resetModules()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'view:v1' ? JSON.stringify(saved) : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  const view = await import('./view')
  const panes = await import('./plugin-panes')
  return { ...view, ...panes }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('plugin tabs a restart brings back', () => {
  it('keeps those that name a plugin and a view, and drops those that do not', async () => {
    const { useViewStore } = await load({
      sideDocs: {
        [PANEL]: [
          pane(KEPT, 'issues'),
          pane('not-a-plugin', 'issues'),
          pane(KEPT, '../x'),
          pane(KEPT, 'issues', { id: 'other' }),
          file,
        ],
      },
    })
    expect(useViewStore.getState().sideDocs[PANEL]).toEqual([pane(KEPT, 'issues'), file])
  })

  it('takes off those whose plugin is gone, once, and shows the tab next to them', async () => {
    const { useViewStore, dropGonePluginPanes } = await load({
      sidePanes: { [PANEL]: 'plugin' },
      sideDocs: { [PANEL]: [file, pane(GONE, 'issues'), pane(KEPT, 'issues')] },
      sideDoc: { [PANEL]: `plugin:${GONE}/issues` },
      sideOrder: { [PANEL]: ['file:src/a.ts', `plugin:${GONE}/issues`, `plugin:${KEPT}/issues`] },
    })
    dropGonePluginPanes(PANEL, new Set([`${KEPT}/issues`]))
    const state = useViewStore.getState()
    expect(state.sideDocs[PANEL]).toEqual([file, pane(KEPT, 'issues')])
    expect(state.sidePane[PANEL]).toBe('plugin')
    expect(state.sideDoc[PANEL]).toBe(`plugin:${KEPT}/issues`)

    // A plugin that goes later leaves its open tab, which shows the view's error, as it is.
    dropGonePluginPanes(PANEL, new Set())
    expect(useViewStore.getState().sideDocs[PANEL]).toEqual([file, pane(KEPT, 'issues')])
  })

  it('takes off a pane its plugin no longer declares, and falls back to the list with none left', async () => {
    const { useViewStore, dropGonePluginPanes } = await load({
      sidePanes: { [PANEL]: 'plugin' },
      sideDocs: { [PANEL]: [pane(KEPT, 'removed')] },
      sideDoc: { [PANEL]: `plugin:${KEPT}/removed` },
    })
    dropGonePluginPanes(PANEL, new Set([`${KEPT}/issues`]))
    const state = useViewStore.getState()
    expect(state.sideDocs[PANEL]).toBeUndefined()
    expect(state.sidePane[PANEL]).toBe('surfaces')
  })

  it('falls back to the list when every tab in the row is gone, whatever order they close in', async () => {
    const { useViewStore, dropGonePluginPanes } = await load({
      sidePanes: { [PANEL]: 'plugin' },
      sideDocs: { [PANEL]: [pane(GONE, 'issues'), pane(GONE, 'tools')] },
      sideDoc: { [PANEL]: `plugin:${GONE}/tools` },
      sideOrder: { [PANEL]: [`plugin:${GONE}/issues`, `plugin:${GONE}/tools`] },
    })
    dropGonePluginPanes(PANEL, new Set())
    const state = useViewStore.getState()
    expect(state.sideDocs[PANEL]).toBeUndefined()
    expect(state.sideDoc[PANEL]).toBeUndefined()
    expect(state.sidePane[PANEL]).toBe('surfaces')
  })

  it('opens a pane once, and starts it over when it is opened with other parameters', async () => {
    const { useViewStore, openPluginPane } = await load({})
    openPluginPane(PANEL, { pluginId: KEPT, viewId: 'issues' })
    openPluginPane(PANEL, { pluginId: KEPT, viewId: 'issues' })
    expect(useViewStore.getState().sideDocs[PANEL]).toEqual([pane(KEPT, 'issues')])
    openPluginPane(PANEL, { pluginId: KEPT, viewId: 'issues', params: { team: 'ENG' } })
    expect(useViewStore.getState().sideDocs[PANEL]).toEqual([
      pane(KEPT, 'issues', { params: { team: 'ENG' } }),
    ])
    expect(useViewStore.getState().sidePane[PANEL]).toBe('plugin')
  })
})
