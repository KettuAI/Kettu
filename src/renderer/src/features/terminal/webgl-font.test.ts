import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { WebglAddon as EsmWebglAddon } from '@xterm/addon-webgl'

const require = createRequire(import.meta.url)
const { WebglAddon: CjsWebglAddon } = require('@xterm/addon-webgl') as {
  WebglAddon: typeof EsmWebglAddon
}

// xterm.js AttributeData flags (src/common/buffer/Constants.ts)
const FG_BOLD = 1 << 27
const BG_ITALIC = 1 << 26
const DEFAULT_COLOR = 0
const DEFAULT_EXT = 0

interface DrawnGlyph {
  text: string
  font: string
}

interface Strict2DContext {
  assignedFonts: string[]
  drawn: DrawnGlyph[]
  font: string
  fillStyle: string
  strokeStyle: string
  globalCompositeOperation: string
  textBaseline: string
  lineWidth: number
  save: () => void
  restore: () => void
  fillRect: () => void
  clearRect: () => void
  drawImage: () => void
  beginPath: () => void
  rect: () => void
  clip: () => void
  moveTo: () => void
  lineTo: () => void
  stroke: () => void
  setLineDash: () => void
  measureText: () => { actualBoundingBoxDescent: number }
  strokeText: () => void
  fillText: (text: string) => void
  putImageData: () => void
  getImageData: (
    _x: number,
    _y: number,
    width: number,
    height: number,
  ) => {
    width: number
    height: number
    data: Uint8ClampedArray
  }
}

// Chromium 152+ rejects CSS font shorthand strings with leading whitespace,
// silently ignoring the assignment and leaving ctx.font at '10px sans-serif'.
function createStrict2DContext(): Strict2DContext {
  let currentFont = '10px sans-serif'
  const assignedFonts: string[] = []
  const drawn: DrawnGlyph[] = []

  return {
    assignedFonts,
    drawn,
    get font() {
      return currentFont
    },
    set font(value: string) {
      assignedFonts.push(value)
      if (!value || /^\s|\s$|\s{2,}/.test(value)) return
      currentFont = value
    },
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalCompositeOperation: 'source-over',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    save: () => undefined,
    restore: () => undefined,
    fillRect: () => undefined,
    clearRect: () => undefined,
    drawImage: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    setLineDash: () => undefined,
    measureText: () => ({ actualBoundingBoxDescent: 0 }),
    strokeText: () => undefined,
    fillText: (text: string) => {
      drawn.push({ text, font: currentFont })
    },
    putImageData: () => undefined,
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(Math.max(1, width * height * 4))
      data[0] = 255
      data[1] = 255
      data[2] = 255
      data[3] = 255
      return { width, height, data }
    },
  }
}

function createWebgl2Stub(): Record<string, unknown> {
  const noop = () => undefined
  const methods: Record<string, unknown> = {
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    getParameter: (param: number) => (param === 0x0d33 ? 4096 : 16),
    createProgram: () => ({}),
    createShader: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
    createTexture: () => ({}),
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
  }
  return new Proxy(methods, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return noop
    },
  })
}

function createFakeCanvas(contexts: Strict2DContext[]) {
  let ctx2d: Strict2DContext | null = null
  const webgl2 = createWebgl2Stub()
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    classList: { add: () => undefined, remove: () => undefined },
    parentElement: null as unknown,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    remove: () => undefined,
    getContext(kind: string) {
      if (kind === '2d') {
        if (!ctx2d) {
          ctx2d = createStrict2DContext()
          contexts.push(ctx2d)
        }
        return ctx2d
      }
      if (kind === 'webgl2') return webgl2
      return null
    },
  }
  return canvas
}

interface InternalAtlas {
  getRasterizedGlyph: (
    code: number,
    bg: number,
    fg: number,
    ext: number,
    restrictToCellHeight: boolean,
    domContainer: HTMLElement | undefined,
  ) => unknown
}

interface InternalRenderLayer {
  _ctx: Strict2DContext
  _getFont: (terminal: Terminal, isBold: boolean, isItalic: boolean) => string
  _fillCharTrueColor: (
    terminal: Terminal,
    cell: { getWidth: () => number; getChars: () => string },
    x: number,
    y: number,
  ) => void
}

interface InternalAddon {
  activate: (terminal: Terminal) => void
  dispose: () => void
  _renderer?: {
    _charAtlas?: InternalAtlas
    _renderLayers?: InternalRenderLayer[]
  }
}

function createFakeTerminal(
  contexts: Strict2DContext[],
  optionsOverride: Partial<{
    fontFamily: string
    fontSize: number
    fontWeight: string
    fontWeightBold: string
  }> = {},
) {
  const eventStub = () => ({ dispose: () => undefined })
  const makeColor = (css: string, rgba: number) => ({ css, rgba })
  const ansi = Array.from({ length: 256 }, () => makeColor('#ffffff', 0xffffffff))
  const contrastCache = {
    getColor: () => undefined,
    setColor: () => undefined,
    clear: () => undefined,
  }
  const colors = {
    foreground: makeColor('#e6edf3', 0xe6edf3ff),
    background: makeColor('#0d1117', 0x0d1117ff),
    cursor: makeColor('#e6edf3', 0xe6edf3ff),
    cursorAccent: makeColor('#0d1117', 0x0d1117ff),
    selectionForeground: undefined,
    selectionBackgroundTransparent: makeColor('rgba(255,255,255,0.2)', 0xffffff33),
    selectionBackgroundOpaque: makeColor('#30363d', 0x30363dff),
    selectionInactiveBackgroundTransparent: makeColor('rgba(255,255,255,0.1)', 0xffffff1a),
    selectionInactiveBackgroundOpaque: makeColor('#21262d', 0x21262dff),
    ansi,
    contrastCache,
    halfContrastCache: contrastCache,
  }

  const rawOptions = {
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: 13,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    lineHeight: 1.2,
    letterSpacing: 0,
    allowTransparency: false,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    customGlyphs: false,
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'bar',
    cursorWidth: 1,
    overviewRuler: undefined,
    rescaleOverlappingGlyphs: false,
    ...optionsOverride,
  }

  const fakeDocument = {
    createElement: (tag: string) => {
      if (tag === 'canvas') return createFakeCanvas(contexts)
      return { style: {}, appendChild: () => undefined, removeChild: () => undefined }
    },
  }

  const fakeWindow = {
    devicePixelRatio: 2,
    requestIdleCallback: () => 0,
    cancelIdleCallback: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    ResizeObserver: class {
      observe() {
        return undefined
      }
      disconnect() {
        return undefined
      }
    },
    matchMedia: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  }

  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('window', fakeWindow)

  const screenElement = {
    isConnected: true,
    style: {} as Record<string, string>,
    appendChild: (child: { parentElement?: unknown }) => {
      child.parentElement = screenElement
      return child
    },
    removeChild: (child: { parentElement?: unknown }) => {
      child.parentElement = null
      return child
    },
    append: () => undefined,
  }

  const core = {
    element: screenElement,
    screenElement,
    options: rawOptions,
    cols: 80,
    rows: 24,
    unicodeService: {
      wcwidth: () => 1,
      getStringCellWidth: (s: string) => s.length,
    },
    linkifier: {
      onShowLinkUnderline: eventStub,
      onHideLinkUnderline: eventStub,
    },
    coreService: {
      decPrivateModes: {},
      isCursorInitialized: true,
      isCursorHidden: false,
    },
    optionsService: {
      rawOptions,
      onOptionChange: eventStub,
    },
    _renderService: {
      setRenderer: () => undefined,
      handleResize: () => undefined,
    },
    _characterJoinerService: {
      getJoinedCharacters: () => [],
    },
    _charSizeService: {
      width: 8,
      height: 16,
      hasValidSize: true,
    },
    _coreBrowserService: {
      dpr: 2,
      isFocused: true,
      mainDocument: fakeDocument,
      window: fakeWindow,
      onWindowChange: eventStub,
      onDprChange: eventStub,
    },
    _decorationService: {
      forEachDecorationAtCell: () => undefined,
      onDecorationRegistered: eventStub,
      onDecorationRemoved: eventStub,
    },
    _logService: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    _themeService: {
      colors,
      onChangeColors: eventStub,
    },
    _store: {
      _isDisposed: true,
    },
  }

  return {
    element: screenElement,
    options: rawOptions,
    cols: 80,
    rows: 24,
    buffer: { active: { baseY: 0, cursorY: 0, cursorX: 0 } },
    _core: core,
  } as unknown as Terminal
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each([
  ['ESM (lib/addon-webgl.mjs)', EsmWebglAddon],
  ['CJS (lib/addon-webgl.js)', CjsWebglAddon],
])('@xterm/addon-webgl font shorthand patch (%s)', (_label, WebglAddonCtor) => {
  it('sets valid CSS font shorthands without leading whitespace in TextureAtlas and BaseRenderLayer', () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/152.0.0.0' })
    const contexts: Strict2DContext[] = []
    const terminal = createFakeTerminal(contexts)
    const addon = new WebglAddonCtor() as unknown as InternalAddon

    addon.activate(terminal)

    const atlas = addon._renderer?._charAtlas
    const linkLayer = addon._renderer?._renderLayers?.[0]
    expect(atlas).toBeDefined()
    expect(linkLayer).toBeDefined()

    const cases = [
      {
        code: 'a'.charCodeAt(0),
        bg: DEFAULT_COLOR,
        fg: DEFAULT_COLOR,
        expected: 'normal 26px "JetBrains Mono", monospace',
      },
      {
        code: 'b'.charCodeAt(0),
        bg: DEFAULT_COLOR,
        fg: FG_BOLD,
        expected: 'bold 26px "JetBrains Mono", monospace',
      },
      {
        code: 'c'.charCodeAt(0),
        bg: BG_ITALIC,
        fg: DEFAULT_COLOR,
        expected: 'italic normal 26px "JetBrains Mono", monospace',
      },
      {
        code: 'd'.charCodeAt(0),
        bg: BG_ITALIC,
        fg: FG_BOLD,
        expected: 'italic bold 26px "JetBrains Mono", monospace',
      },
    ]

    for (const testCase of cases) {
      atlas!.getRasterizedGlyph(
        testCase.code,
        testCase.bg,
        testCase.fg,
        DEFAULT_EXT,
        false,
        undefined,
      )
    }

    const drawnByAtlas = contexts.flatMap((ctx) => ctx.drawn)
    expect(drawnByAtlas).toEqual(
      cases.map((testCase) => ({
        text: String.fromCharCode(testCase.code),
        font: testCase.expected,
      })),
    )

    expect(linkLayer!._getFont(terminal, false, false)).toBe(
      'normal 26px "JetBrains Mono", monospace',
    )
    expect(linkLayer!._getFont(terminal, true, false)).toBe('bold 26px "JetBrains Mono", monospace')
    expect(linkLayer!._getFont(terminal, false, true)).toBe(
      'italic normal 26px "JetBrains Mono", monospace',
    )
    expect(linkLayer!._getFont(terminal, true, true)).toBe(
      'italic bold 26px "JetBrains Mono", monospace',
    )

    linkLayer!._fillCharTrueColor(terminal, { getWidth: () => 1, getChars: () => 'x' }, 0, 0)
    expect(linkLayer!._ctx.drawn.at(-1)).toEqual({
      text: 'x',
      font: 'normal 26px "JetBrains Mono", monospace',
    })

    const allAssignedFonts = contexts.flatMap((ctx) => ctx.assignedFonts)
    expect(allAssignedFonts.length).toBeGreaterThanOrEqual(5)
    for (const assigned of allAssignedFonts) {
      expect(assigned).not.toMatch(/^\s|\s$|\s{2,}/)
    }

    addon.dispose()
  })

  it('omits blank fontWeight and trims fontFamily whitespace without producing extra spaces', () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/152.0.0.0' })
    const contexts: Strict2DContext[] = []
    const terminal = createFakeTerminal(contexts, {
      fontFamily: '  "Fira Code", monospace  ',
      fontSize: 14,
      fontWeight: '   ',
      fontWeightBold: '700',
    })
    const addon = new WebglAddonCtor() as unknown as InternalAddon

    addon.activate(terminal)

    const atlas = addon._renderer?._charAtlas
    const linkLayer = addon._renderer?._renderLayers?.[0]
    expect(atlas).toBeDefined()
    expect(linkLayer).toBeDefined()

    atlas!.getRasterizedGlyph(
      'z'.charCodeAt(0),
      DEFAULT_COLOR,
      DEFAULT_COLOR,
      DEFAULT_EXT,
      false,
      undefined,
    )
    atlas!.getRasterizedGlyph(
      'y'.charCodeAt(0),
      BG_ITALIC,
      DEFAULT_COLOR,
      DEFAULT_EXT,
      false,
      undefined,
    )

    expect(contexts.flatMap((ctx) => ctx.drawn)).toEqual([
      { text: 'z', font: '28px "Fira Code", monospace' },
      { text: 'y', font: 'italic 28px "Fira Code", monospace' },
    ])
    expect(linkLayer!._getFont(terminal, false, false)).toBe('28px "Fira Code", monospace')
    expect(linkLayer!._getFont(terminal, true, true)).toBe('italic 700 28px "Fira Code", monospace')

    addon.dispose()
  })
})
