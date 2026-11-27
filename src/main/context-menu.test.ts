import { EventEmitter } from 'node:events'
import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  popup: vi.fn(),
  buildFromTemplate: vi.fn(),
  clipboardRead: vi.fn<() => Promise<{ types: string[] }[]>>(async () => []),
  windowByContents: new WeakMap<object, { isDestroyed(): boolean }>(),
  createdWindows: [] as Array<{
    webContents: EventEmitter & {
      isDestroyed(): boolean
      setZoomFactor: ReturnType<typeof vi.fn>
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      loadURL: ReturnType<typeof vi.fn>
      loadFile: ReturnType<typeof vi.fn>
      undo: ReturnType<typeof vi.fn>
      redo: ReturnType<typeof vi.fn>
      cut: ReturnType<typeof vi.fn>
      copy: ReturnType<typeof vi.fn>
      paste: ReturnType<typeof vi.fn>
      pasteAndMatchStyle: ReturnType<typeof vi.fn>
      delete: ReturnType<typeof vi.fn>
      selectAll: ReturnType<typeof vi.fn>
      replaceMisspelling: ReturnType<typeof vi.fn>
    }
    on: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    isDestroyed(): boolean
  }>,
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')

  class FakeBrowserWindow extends Emitter {
    webContents = Object.assign(new Emitter(), {
      isDestroyed: () => false,
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => {}),
      loadFile: vi.fn(async () => {}),
      undo: vi.fn(),
      redo: vi.fn(),
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      pasteAndMatchStyle: vi.fn(),
      delete: vi.fn(),
      selectAll: vi.fn(),
      replaceMisspelling: vi.fn(),
    })

    constructor() {
      super()
      state.windowByContents.set(this.webContents, this)
      state.createdWindows.push(this as unknown as (typeof state.createdWindows)[number])
    }

    isDestroyed(): boolean {
      return false
    }

    loadFile = vi.fn(async () => {})
    loadURL = vi.fn(async () => {})

    static fromWebContents(contents: object): { isDestroyed(): boolean } | null {
      return state.windowByContents.get(contents) ?? null
    }

    static getAllWindows(): FakeBrowserWindow[] {
      return []
    }

    static getFocusedWindow(): FakeBrowserWindow | null {
      return null
    }
  }

  return {
    app: {
      isPackaged: true,
      getAppPath: () => '/app',
    },
    BrowserWindow: FakeBrowserWindow,
    clipboard: {
      read: (...args: []) => state.clipboardRead(...args),
    },
    Menu: {
      buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
        state.buildFromTemplate(template)
        return { popup: state.popup }
      },
    },
    nativeTheme: {
      shouldUseDarkColors: false,
      themeSource: 'system',
      on: vi.fn(),
    },
    screen: {
      getAllDisplays: () => [],
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    shell: {
      openExternal: vi.fn(),
    },
  }
})

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const {
  attachContextMenu,
  buildContextMenuTemplate,
  contextMenuLabels,
  inspectClipboardTypes,
  readClipboardState,
} = await import('./context-menu')
const { setLocale } = await import('./i18n')
const { configureWindows, createMainWindow } = await import('./window')

function makeActions() {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    pasteAndMatchStyle: vi.fn(),
    delete: vi.fn(),
    selectAll: vi.fn(),
    replaceMisspelling: vi.fn(),
  }
}

function makeEditFlags(
  overrides: Partial<ContextMenuParams['editFlags']> = {},
): ContextMenuParams['editFlags'] {
  return {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: true,
    ...overrides,
  }
}

function makeParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 100,
    y: 200,
    frame: null,
    linkURL: '',
    linkText: '',
    pageURL: 'http://localhost:5173/',
    frameURL: 'http://localhost:5173/',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    titleText: '',
    altText: '',
    suggestedFilename: '',
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { url: '', policy: 'default' },
    misspelledWord: '',
    dictionarySuggestions: [],
    frameCharset: 'UTF-8',
    formControlType: 'none',
    spellcheckEnabled: true,
    menuSourceType: 'mouse',
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: false,
    },
    editFlags: makeEditFlags(),
    ...overrides,
  }
}

class FakeWebContents extends EventEmitter {
  destroyed = false
  undo = vi.fn()
  redo = vi.fn()
  cut = vi.fn()
  copy = vi.fn()
  paste = vi.fn()
  pasteAndMatchStyle = vi.fn()
  delete = vi.fn()
  selectAll = vi.fn()
  replaceMisspelling = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function clickItem(template: MenuItemConstructorOptions[], label: string): void {
  const item = template.find((entry) => entry.label === label)
  expect(item, `expected menu item "${label}"`).toBeDefined()
  item!.click?.({} as never, undefined, {} as never)
}

beforeEach(() => {
  setLocale('en')
  state.popup.mockReset()
  state.buildFromTemplate.mockReset()
  state.clipboardRead.mockReset()
  state.clipboardRead.mockResolvedValue([])
  state.createdWindows.length = 0
})

afterEach(() => {
  setLocale('en')
})

describe('inspectClipboardTypes', () => {
  it('detects empty clipboard', () => {
    expect(inspectClipboardTypes([])).toEqual({ hasContent: false, hasText: false })
    expect(inspectClipboardTypes(['   '])).toEqual({ hasContent: false, hasText: false })
  })

  it('detects image-only and file-only clipboards as pasteable non-text content', () => {
    expect(inspectClipboardTypes(['image/png'])).toEqual({ hasContent: true, hasText: false })
    expect(inspectClipboardTypes(['text/uri-list'])).toEqual({ hasContent: true, hasText: false })
  })

  it('detects plain text, HTML, and RTF as both content and text', () => {
    expect(inspectClipboardTypes(['text/plain'])).toEqual({ hasContent: true, hasText: true })
    expect(inspectClipboardTypes(['text/plain;charset=utf-8'])).toEqual({
      hasContent: true,
      hasText: true,
    })
    expect(inspectClipboardTypes(['text/html'])).toEqual({ hasContent: true, hasText: true })
    expect(inspectClipboardTypes(['text/rtf'])).toEqual({ hasContent: true, hasText: true })
  })
})

describe('readClipboardState', () => {
  it('merges MIME types across clipboard items', async () => {
    const result = await readClipboardState(async () => [
      { types: ['image/png'] },
      { types: ['text/plain'] },
    ])
    expect(result).toEqual({ hasContent: true, hasText: true })
  })

  it('falls back to empty state when reading the clipboard throws', async () => {
    const result = await readClipboardState(async () => {
      throw new Error('clipboard locked')
    })
    expect(result).toEqual({ hasContent: false, hasText: false })
  })
})

describe('buildContextMenuTemplate', () => {
  it('builds localized edit items with explicit click handlers and no role overrides', () => {
    const actions = makeActions()
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: true,
        editFlags: makeEditFlags({
          canUndo: true,
          canRedo: false,
          canCut: true,
          canCopy: true,
          canPaste: true,
          canDelete: true,
          canSelectAll: true,
        }),
      }),
      { actions },
    )

    expect(template).not.toBeNull()
    expect(
      template!.map((item) =>
        item.type === 'separator' ? '---' : `${item.label}:${item.enabled ? 'on' : 'off'}`,
      ),
    ).toEqual([
      'Undo:on',
      'Redo:off',
      '---',
      'Cut:on',
      'Copy:on',
      'Paste:on',
      'Paste and Match Style:on',
      'Delete:on',
      '---',
      'Select All:on',
    ])
    // Avoid Electron roles so Windows/Linux (null app menu) and localized labels stay consistent.
    expect(template!.every((item) => item.role === undefined)).toBe(true)

    clickItem(template!, 'Undo')
    clickItem(template!, 'Redo')
    clickItem(template!, 'Cut')
    clickItem(template!, 'Copy')
    clickItem(template!, 'Paste')
    clickItem(template!, 'Paste and Match Style')
    clickItem(template!, 'Delete')
    clickItem(template!, 'Select All')

    expect(actions.undo).toHaveBeenCalledTimes(1)
    expect(actions.redo).toHaveBeenCalledTimes(1)
    expect(actions.cut).toHaveBeenCalledTimes(1)
    expect(actions.copy).toHaveBeenCalledTimes(1)
    expect(actions.paste).toHaveBeenCalledTimes(1)
    expect(actions.pasteAndMatchStyle).toHaveBeenCalledTimes(1)
    expect(actions.delete).toHaveBeenCalledTimes(1)
    expect(actions.selectAll).toHaveBeenCalledTimes(1)
  })

  it('keeps Paste enabled for clipboard images or copied files even when canPaste is false', () => {
    const actions = makeActions()
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: true,
        editFlags: makeEditFlags({ canPaste: false, canSelectAll: true }),
      }),
      {
        actions,
        clipboard: { hasContent: true, hasText: false },
      },
    )

    const paste = template!.find((item) => item.label === 'Paste')
    const pasteMatch = template!.find((item) => item.label === 'Paste and Match Style')
    expect(paste?.enabled).toBe(true)
    expect(pasteMatch?.enabled).toBe(false)

    clickItem(template!, 'Paste')
    expect(actions.paste).toHaveBeenCalledTimes(1)
  })

  it('enables both Paste actions when clipboard has text even if canPaste is false', () => {
    const actions = makeActions()
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: true,
        editFlags: makeEditFlags({ canPaste: false }),
      }),
      {
        actions,
        clipboard: { hasContent: true, hasText: true },
      },
    )

    expect(template!.find((item) => item.label === 'Paste')?.enabled).toBe(true)
    expect(template!.find((item) => item.label === 'Paste and Match Style')?.enabled).toBe(true)
  })

  it('disables Paste actions when both canPaste and clipboard content are absent', () => {
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: true,
        editFlags: makeEditFlags({ canPaste: false }),
      }),
      {
        actions: makeActions(),
        clipboard: { hasContent: false, hasText: false },
      },
    )

    expect(template!.find((item) => item.label === 'Paste')?.enabled).toBe(false)
    expect(template!.find((item) => item.label === 'Paste and Match Style')?.enabled).toBe(false)
  })

  it('prepends up to 5 spelling suggestions followed by a separator when a word is misspelled', () => {
    const actions = makeActions()
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: true,
        misspelledWord: 'helo',
        dictionarySuggestions: ['hello', 'help', 'halo', 'held', 'helm', 'hero'],
      }),
      { actions },
    )

    expect(template!.slice(0, 6).map((item) => item.label ?? item.type)).toEqual([
      'hello',
      'help',
      'halo',
      'held',
      'helm',
      'separator',
    ])
    expect(template!.find((item) => item.label === 'hero')).toBeUndefined()

    clickItem(template!, 'hello')
    expect(actions.replaceMisspelling).toHaveBeenCalledWith('hello')
  })

  it('returns Copy only for a non-editable text selection', () => {
    const actions = makeActions()
    const template = buildContextMenuTemplate(
      makeParams({
        isEditable: false,
        selectionText: 'Agent reply text',
        editFlags: makeEditFlags({ canCopy: true }),
      }),
      { actions },
    )

    expect(template).toHaveLength(1)
    expect(template![0]?.label).toBe('Copy')
    expect(template![0]?.enabled).toBe(true)
    clickItem(template!, 'Copy')
    expect(actions.copy).toHaveBeenCalledTimes(1)
  })

  it('returns null for non-editable empty areas, whitespace-only selections, or non-copyable text', () => {
    const actions = makeActions()
    expect(buildContextMenuTemplate(makeParams({ isEditable: false }), { actions })).toBeNull()
    expect(
      buildContextMenuTemplate(
        makeParams({
          isEditable: false,
          selectionText: '   \n\t ',
          editFlags: makeEditFlags({ canCopy: true }),
        }),
        { actions },
      ),
    ).toBeNull()
    expect(
      buildContextMenuTemplate(
        makeParams({
          isEditable: false,
          selectionText: 'text',
          editFlags: makeEditFlags({ canCopy: false }),
        }),
        { actions },
      ),
    ).toBeNull()
  })

  it('uses localized labels for both en and zh-CN', () => {
    setLocale('en')
    const en = contextMenuLabels()
    expect(en).toEqual({
      undo: 'Undo',
      redo: 'Redo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      pasteAndMatchStyle: 'Paste and Match Style',
      delete: 'Delete',
      selectAll: 'Select All',
    })

    setLocale('zh-CN')
    const zh = contextMenuLabels()
    expect(zh).toEqual({
      undo: '撤销',
      redo: '重做',
      cut: '剪切',
      copy: '拷贝',
      paste: '粘贴',
      pasteAndMatchStyle: '粘贴并匹配样式',
      delete: '删除',
      selectAll: '全选',
    })

    const template = buildContextMenuTemplate(makeParams({ isEditable: true }), {
      actions: makeActions(),
    })
    expect(template!.some((item) => item.label === '粘贴')).toBe(true)
    expect(template!.some((item) => item.label === '粘贴并匹配样式')).toBe(true)
  })
})

describe('attachContextMenu', () => {
  it('opens an editable menu with Paste enabled for image clipboard and dispatches webContents.paste', async () => {
    const contents = new FakeWebContents()
    const win = { isDestroyed: () => false }
    state.windowByContents.set(contents, win)
    const frame = {
      isDestroyed: () => false,
      detached: false,
    } as unknown as ContextMenuParams['frame']
    state.clipboardRead.mockResolvedValue([{ types: ['image/png'] }])

    attachContextMenu(contents as unknown as WebContents)
    contents.emit(
      'context-menu',
      {},
      makeParams({
        isEditable: true,
        frame,
        menuSourceType: 'mouse',
        editFlags: makeEditFlags({ canPaste: false, canSelectAll: true }),
      }),
    )

    await vi.waitFor(() => expect(state.popup).toHaveBeenCalledTimes(1))
    expect(state.popup).toHaveBeenCalledWith({
      window: win,
      frame,
      sourceType: 'mouse',
    })

    const template = state.buildFromTemplate.mock.calls[0]![0] as MenuItemConstructorOptions[]
    expect(template.find((item) => item.label === 'Paste')?.enabled).toBe(true)
    clickItem(template, 'Paste')
    expect(contents.paste).toHaveBeenCalledTimes(1)
  })

  it('opens Copy synchronously for non-editable selections without querying the clipboard', () => {
    const contents = new FakeWebContents()
    const readClipboard = vi.fn(async () => ({ hasContent: true, hasText: true }))
    attachContextMenu(contents as unknown as WebContents, readClipboard)

    contents.emit(
      'context-menu',
      {},
      makeParams({
        isEditable: false,
        selectionText: 'Copyable reply',
        editFlags: makeEditFlags({ canCopy: true }),
      }),
    )

    expect(readClipboard).not.toHaveBeenCalled()
    expect(state.popup).toHaveBeenCalledTimes(1)
    const template = state.buildFromTemplate.mock.calls[0]![0] as MenuItemConstructorOptions[]
    clickItem(template, 'Copy')
    expect(contents.copy).toHaveBeenCalledTimes(1)
  })

  it('does not open a menu on non-editable empty areas', () => {
    const contents = new FakeWebContents()
    attachContextMenu(contents as unknown as WebContents)
    contents.emit('context-menu', {}, makeParams({ isEditable: false, selectionText: '' }))
    expect(state.popup).not.toHaveBeenCalled()
  })

  it('ignores stale clipboard reads when a newer context-menu event arrives first', async () => {
    const contents = new FakeWebContents()
    let resolveFirst!: (value: { hasContent: boolean; hasText: boolean }) => void
    let resolveSecond!: (value: { hasContent: boolean; hasText: boolean }) => void
    let call = 0
    const readClipboard = vi.fn(
      () =>
        new Promise<{ hasContent: boolean; hasText: boolean }>((resolve) => {
          if (++call === 1) resolveFirst = resolve
          else resolveSecond = resolve
        }),
    )

    attachContextMenu(contents as unknown as WebContents, readClipboard)
    contents.emit('context-menu', {}, makeParams({ isEditable: true }))
    contents.emit('context-menu', {}, makeParams({ isEditable: true }))

    resolveSecond({ hasContent: true, hasText: false })
    await vi.waitFor(() => expect(state.popup).toHaveBeenCalledTimes(1))

    resolveFirst({ hasContent: false, hasText: false })
    await Promise.resolve()
    expect(state.popup).toHaveBeenCalledTimes(1)
    const template = state.buildFromTemplate.mock.calls[0]![0] as MenuItemConstructorOptions[]
    expect(template.find((item) => item.label === 'Paste')?.enabled).toBe(true)
  })

  it('guards against destroyed webContents and detached frames', async () => {
    const contents = new FakeWebContents()
    const detachedFrame = {
      isDestroyed: () => false,
      detached: true,
    } as unknown as ContextMenuParams['frame']
    attachContextMenu(contents as unknown as WebContents, async () => ({
      hasContent: true,
      hasText: true,
    }))

    contents.emit('context-menu', {}, makeParams({ isEditable: true, frame: detachedFrame }))
    await vi.waitFor(() => expect(state.popup).toHaveBeenCalledTimes(1))
    expect(state.popup).toHaveBeenCalledWith({
      window: undefined,
      frame: undefined,
      sourceType: 'mouse',
    })

    const template = state.buildFromTemplate.mock.calls[0]![0] as MenuItemConstructorOptions[]
    contents.destroyed = true
    clickItem(template, 'Paste')
    expect(contents.paste).not.toHaveBeenCalled()
  })
})

describe('createMainWindow context-menu wiring', () => {
  it('registers the context-menu handler on new main windows', async () => {
    configureWindows({
      systemLocale: 'en',
      state: {
        placement: () => ({
          bounds: { x: 0, y: 0, width: 1280, height: 820 },
          maximized: false,
        }),
        track: vi.fn(),
        flush: vi.fn(async () => {}),
      } as never,
    })

    createMainWindow('hidden')
    expect(state.createdWindows).toHaveLength(1)
    const win = state.createdWindows[0]!
    expect(win.webContents.listenerCount('context-menu')).toBe(1)

    state.clipboardRead.mockResolvedValue([{ types: ['text/plain'] }])
    win.webContents.emit(
      'context-menu',
      {},
      makeParams({ isEditable: true, editFlags: makeEditFlags({ canPaste: false }) }),
    )
    await vi.waitFor(() => expect(state.popup).toHaveBeenCalledTimes(1))
    const template = state.buildFromTemplate.mock.calls[0]![0] as MenuItemConstructorOptions[]
    clickItem(template, 'Paste')
    expect(win.webContents.paste).toHaveBeenCalledTimes(1)
  })
})
