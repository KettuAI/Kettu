// Per-session ephemeral extension UI state for Pi's native `setStatus` and `setWidget` RPC frames.
// Keeps bounded, ANSI-stripped status items and text widgets in stable insertion order.

import type {
  ExtensionStatusView,
  ExtensionUiView,
  ExtensionWidgetPlacement,
  ExtensionWidgetView,
} from '@shared/thread'
import type { PiUiRequest } from './protocol'

/** Maximum number of live status entries retained per session. */
export const MAX_EXTENSION_STATUSES = 24
/** Maximum length of a status key. */
export const MAX_EXTENSION_STATUS_KEY_CHARS = 80
/** Maximum length of a status line after ANSI stripping. */
export const MAX_EXTENSION_STATUS_TEXT_CHARS = 240
/** Maximum number of live text widgets retained per session. */
export const MAX_EXTENSION_WIDGETS = 8
/** Maximum length of a widget key. */
export const MAX_EXTENSION_WIDGET_KEY_CHARS = 80
/** Maximum number of text lines retained per widget. */
export const MAX_EXTENSION_WIDGET_LINES = 40
/** Maximum length of one widget line after ANSI stripping. */
export const MAX_EXTENSION_WIDGET_LINE_CHARS = 400

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const STRING_ESCAPE = /\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07|$)/g
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g
const ESCAPE = /\x1b[@-Z\\-_]/g
const STATUS_CONTROL = /[\x00-\x1f\x7f-\x9f]/g
const WIDGET_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
/* eslint-enable no-control-regex */

/** Strips terminal ANSI escape sequences (OSC, DCS/APC/PM/SOS, CSI, 2-byte ESC) from text. */
export function stripExtensionAnsi(text: string): string {
  return text.replace(OSC, '').replace(STRING_ESCAPE, '').replace(CSI, '').replace(ESCAPE, '')
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function normalizeKey(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = stripExtensionAnsi(raw).replace(STATUS_CONTROL, '').trim()
  if (cleaned === '') return null
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned
}

function normalizeStatusText(raw: string): string {
  const cleaned = stripExtensionAnsi(raw)
    .replace(/\r\n?|\n/g, ' ')
    .replace(STATUS_CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(cleaned, MAX_EXTENSION_STATUS_TEXT_CHARS)
}

function normalizePlacement(raw: unknown): ExtensionWidgetPlacement {
  return raw === 'belowEditor' ? 'belowEditor' : 'aboveEditor'
}

function normalizeWidgetLines(raw: readonly unknown[]): string[] {
  const lines: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const cleaned = stripExtensionAnsi(item).replace(/\r\n?/g, '\n')
    for (const part of cleaned.split('\n')) {
      const line = part.replace(WIDGET_CONTROL, '').trimEnd()
      lines.push(truncate(line, MAX_EXTENSION_WIDGET_LINE_CHARS))
      if (lines.length >= MAX_EXTENSION_WIDGET_LINES) break
    }
    if (lines.length >= MAX_EXTENSION_WIDGET_LINES) break
  }
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}

/** Mutable per-session store for live Pi extension statuses and text widgets. */
export class PiExtensionUi {
  private readonly statuses = new Map<string, string>()
  private readonly widgets = new Map<
    string,
    { lines: string[]; placement: ExtensionWidgetPlacement }
  >()

  hasAny(): boolean {
    return this.statuses.size > 0 || this.widgets.size > 0
  }

  /** Applies one `setStatus` or `setWidget` request; returns true when visible state changed. */
  apply(request: PiUiRequest): boolean {
    if (request.method === 'setStatus') return this.applyStatus(request)
    if (request.method === 'setWidget') return this.applyWidget(request)
    return false
  }

  /** Clears all live statuses and widgets; returns true if anything was cleared. */
  clear(): boolean {
    if (!this.hasAny()) return false
    this.statuses.clear()
    this.widgets.clear()
    return true
  }

  /** Returns an immutable snapshot for `SessionView.extensionUi`, or null when empty. */
  snapshot(): ExtensionUiView | null {
    if (!this.hasAny()) return null
    const statuses: ExtensionStatusView[] = []
    for (const [key, text] of this.statuses) statuses.push({ key, text })
    const widgets: ExtensionWidgetView[] = []
    for (const [key, widget] of this.widgets) {
      widgets.push({ key, lines: [...widget.lines], placement: widget.placement })
    }
    return { statuses, widgets }
  }

  private applyStatus(request: PiUiRequest): boolean {
    const key = normalizeKey(request.statusKey, MAX_EXTENSION_STATUS_KEY_CHARS)
    if (!key) return false
    const raw = request.statusText as unknown
    if (raw === undefined || raw === null) return this.statuses.delete(key)
    if (typeof raw !== 'string') return false
    const text = normalizeStatusText(raw)
    if (text === '') return this.statuses.delete(key)
    const existing = this.statuses.get(key)
    if (existing === text) return false
    // Updating an existing key preserves its insertion order; new keys evict the oldest past cap.
    this.statuses.set(key, text)
    while (this.statuses.size > MAX_EXTENSION_STATUSES) {
      const oldest = this.statuses.keys().next().value
      if (oldest === undefined) break
      this.statuses.delete(oldest)
    }
    return true
  }

  private applyWidget(request: PiUiRequest): boolean {
    const key = normalizeKey(request.widgetKey, MAX_EXTENSION_WIDGET_KEY_CHARS)
    if (!key) return false
    const raw = request.widgetLines
    if (raw === undefined || raw === null) return this.widgets.delete(key)
    if (!Array.isArray(raw)) return false
    const lines = normalizeWidgetLines(raw)
    if (lines.length === 0) return this.widgets.delete(key)
    const placement = normalizePlacement(request.widgetPlacement)
    const existing = this.widgets.get(key)
    if (existing && existing.placement === placement && sameLines(existing.lines, lines)) {
      return false
    }
    this.widgets.set(key, { lines, placement })
    while (this.widgets.size > MAX_EXTENSION_WIDGETS) {
      const oldest = this.widgets.keys().next().value
      if (oldest === undefined) break
      this.widgets.delete(oldest)
    }
    return true
  }
}
