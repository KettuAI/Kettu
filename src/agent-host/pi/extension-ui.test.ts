import { describe, expect, it } from 'vitest'
import {
  MAX_EXTENSION_STATUSES,
  MAX_EXTENSION_STATUS_KEY_CHARS,
  MAX_EXTENSION_STATUS_TEXT_CHARS,
  MAX_EXTENSION_WIDGETS,
  MAX_EXTENSION_WIDGET_KEY_CHARS,
  MAX_EXTENSION_WIDGET_LINES,
  MAX_EXTENSION_WIDGET_LINE_CHARS,
  PiExtensionUi,
  stripExtensionAnsi,
} from './extension-ui'
import type { PiUiRequest } from './protocol'

const statusReq = (
  statusKey: string,
  statusText: string | undefined,
  id = 'req-s',
): PiUiRequest => ({
  type: 'extension_ui_request',
  id,
  method: 'setStatus',
  statusKey,
  statusText,
})

const widgetReq = (
  widgetKey: string,
  widgetLines: unknown,
  widgetPlacement?: string,
  id = 'req-w',
): PiUiRequest => ({
  type: 'extension_ui_request',
  id,
  method: 'setWidget',
  widgetKey,
  widgetLines,
  ...(widgetPlacement !== undefined ? { widgetPlacement } : {}),
})

describe('stripExtensionAnsi', () => {
  it('strips SGR, 256/truecolor, CSI cursor codes, OSC 8 hyperlinks and OSC titles', () => {
    expect(stripExtensionAnsi('\x1b[32m✓ Ready\x1b[0m')).toBe('✓ Ready')
    expect(stripExtensionAnsi('\x1b[38;2;255;120;0mBuild\x1b[0m \x1b[1;34m42%\x1b[0m')).toBe(
      'Build 42%',
    )
    expect(
      stripExtensionAnsi(
        '\x1b]8;;https://example.com\x07docs\x1b]8;;\x07 and \x1b]0;title\x1b\\ok',
      ),
    ).toBe('docs and ok')
    expect(stripExtensionAnsi('\x9b31m8bit-csi\x9b0m')).toBe('8bit-csi')
    expect(stripExtensionAnsi('\x1bPignored-dcs\x1b\\visible')).toBe('visible')
  })
})

describe('PiExtensionUi', () => {
  it('sets, updates in place while keeping insertion order, deduplicates, and clears statuses', () => {
    const ui = new PiExtensionUi()
    expect(ui.snapshot()).toBeNull()
    expect(ui.hasAny()).toBe(false)

    expect(ui.apply(statusReq('branch', '\x1b[36mmain *\x1b[0m'))).toBe(true)
    expect(ui.apply(statusReq('tests', '12/12\npassing'))).toBe(true)
    expect(ui.snapshot()).toEqual({
      statuses: [
        { key: 'branch', text: 'main *' },
        { key: 'tests', text: '12/12 passing' },
      ],
      widgets: [],
    })

    // Duplicate update produces no change.
    expect(ui.apply(statusReq('branch', 'main *'))).toBe(false)

    // In-place update preserves original key order.
    expect(ui.apply(statusReq('branch', 'feat/1837'))).toBe(true)
    expect(ui.snapshot()?.statuses).toEqual([
      { key: 'branch', text: 'feat/1837' },
      { key: 'tests', text: '12/12 passing' },
    ])

    // Clearing with undefined, empty string, or ANSI-only whitespace removes the key.
    expect(ui.apply(statusReq('branch', undefined))).toBe(true)
    expect(ui.apply(statusReq('branch', undefined))).toBe(false)
    expect(ui.snapshot()?.statuses).toEqual([{ key: 'tests', text: '12/12 passing' }])

    expect(ui.apply(statusReq('tests', '\x1b[32m   \x1b[0m'))).toBe(true)
    expect(ui.snapshot()).toBeNull()
    expect(ui.hasAny()).toBe(false)
  })

  it('sets, updates, places, deduplicates and clears text widgets while ignoring non-array payloads', () => {
    const ui = new PiExtensionUi()

    // Non-array payload (such as a TUI factory sentinel) is ignored.
    expect(ui.apply(widgetReq('bad', { render: true }))).toBe(false)
    expect(ui.snapshot()).toBeNull()

    expect(
      ui.apply(
        widgetReq('plan', [
          '',
          '\x1b[1mPlan Progress\x1b[0m',
          '  \x1b[32m✓\x1b[0m Parse RPC\n  • Render UI',
          '',
        ]),
      ),
    ).toBe(true)
    expect(ui.apply(widgetReq('metrics', ['CPU 12%', 'RAM 1.4G'], 'belowEditor'))).toBe(true)

    expect(ui.snapshot()).toEqual({
      statuses: [],
      widgets: [
        {
          key: 'plan',
          lines: ['Plan Progress', '  ✓ Parse RPC', '  • Render UI'],
          placement: 'aboveEditor',
        },
        {
          key: 'metrics',
          lines: ['CPU 12%', 'RAM 1.4G'],
          placement: 'belowEditor',
        },
      ],
    })

    // Duplicate widget emits no change.
    expect(ui.apply(widgetReq('metrics', ['CPU 12%', 'RAM 1.4G'], 'belowEditor'))).toBe(false)

    // Updating placement or lines keeps insertion order.
    expect(ui.apply(widgetReq('plan', ['Done'], 'belowEditor'))).toBe(true)
    expect(ui.snapshot()?.widgets).toEqual([
      { key: 'plan', lines: ['Done'], placement: 'belowEditor' },
      { key: 'metrics', lines: ['CPU 12%', 'RAM 1.4G'], placement: 'belowEditor' },
    ])

    // Empty array and ANSI-only lines clear widgets.
    expect(ui.apply(widgetReq('plan', []))).toBe(true)
    expect(ui.apply(widgetReq('metrics', ['\x1b[0m   ', '\t']))).toBe(true)
    expect(ui.snapshot()).toBeNull()

    // Undefined also clears an active widget.
    expect(ui.apply(widgetReq('summary', ['Line 1'], 'aboveEditor'))).toBe(true)
    expect(ui.apply(widgetReq('summary', undefined))).toBe(true)
    expect(ui.snapshot()).toBeNull()
  })

  it('bounds status count, widget count, line count and text lengths', () => {
    const ui = new PiExtensionUi()

    for (let i = 0; i < MAX_EXTENSION_STATUSES + 5; i++) {
      ui.apply(statusReq(`s-${i}`, `val-${i}`))
    }
    const statusSnap = ui.snapshot()!
    expect(statusSnap.statuses).toHaveLength(MAX_EXTENSION_STATUSES)
    expect(statusSnap.statuses[0]!.key).toBe('s-5')
    expect(statusSnap.statuses[MAX_EXTENSION_STATUSES - 1]!.key).toBe(
      `s-${MAX_EXTENSION_STATUSES + 4}`,
    )

    ui.clear()
    const longKey = 'k'.repeat(MAX_EXTENSION_STATUS_KEY_CHARS + 20)
    const longText = 't'.repeat(MAX_EXTENSION_STATUS_TEXT_CHARS + 50)
    ui.apply(statusReq(longKey, longText))
    const clippedStatus = ui.snapshot()!.statuses[0]!
    expect(clippedStatus.key).toHaveLength(MAX_EXTENSION_STATUS_KEY_CHARS)
    expect(clippedStatus.text).toHaveLength(MAX_EXTENSION_STATUS_TEXT_CHARS)
    expect(clippedStatus.text.endsWith('…')).toBe(true)

    ui.clear()
    for (let i = 0; i < MAX_EXTENSION_WIDGETS + 3; i++) {
      ui.apply(widgetReq(`w-${i}`, [`row ${i}`]))
    }
    const widgetSnap = ui.snapshot()!
    expect(widgetSnap.widgets).toHaveLength(MAX_EXTENSION_WIDGETS)
    expect(widgetSnap.widgets[0]!.key).toBe('w-3')

    ui.clear()
    const longWidgetKey = 'w'.repeat(MAX_EXTENSION_WIDGET_KEY_CHARS + 15)
    const manyLines = Array.from(
      { length: MAX_EXTENSION_WIDGET_LINES + 10 },
      (_, index) => `${index}:${'x'.repeat(MAX_EXTENSION_WIDGET_LINE_CHARS + 30)}`,
    )
    ui.apply(widgetReq(longWidgetKey, manyLines))
    const clippedWidget = ui.snapshot()!.widgets[0]!
    expect(clippedWidget.key).toHaveLength(MAX_EXTENSION_WIDGET_KEY_CHARS)
    expect(clippedWidget.lines).toHaveLength(MAX_EXTENSION_WIDGET_LINES)
    expect(clippedWidget.lines[0]!).toHaveLength(MAX_EXTENSION_WIDGET_LINE_CHARS)
    expect(clippedWidget.lines[0]!.endsWith('…')).toBe(true)
  })

  it('ignores unsupported methods and blank keys, and returns fresh snapshot copies', () => {
    const ui = new PiExtensionUi()
    expect(
      ui.apply({ type: 'extension_ui_request', id: 'x', method: 'setTitle', title: 'Hi' }),
    ).toBe(false)
    expect(ui.apply(statusReq('   ', 'hello'))).toBe(false)
    expect(ui.apply(widgetReq('', ['hello']))).toBe(false)
    expect(ui.clear()).toBe(false)

    ui.apply(widgetReq('w1', ['a']))
    const first = ui.snapshot()!
    first.widgets[0]!.lines.push('mutated')
    expect(ui.snapshot()!.widgets[0]!.lines).toEqual(['a'])
    expect(ui.clear()).toBe(true)
    expect(ui.clear()).toBe(false)
  })
})
