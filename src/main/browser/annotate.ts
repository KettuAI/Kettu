// Page element annotation engine for the built-in browser: builds stable CSS selectors,
// extracts non-sensitive visible metadata, sanitizes payloads coming from external web pages,
// and generates the self-contained Isolated World overlay script with complete teardown.

import { randomUUID } from 'node:crypto'
import {
  BROWSER_ANNOTATION_LIMITS,
  isAnnotatableBrowserUrl,
  type BrowserElementAnnotation,
  type BrowserElementAttributes,
} from '@shared/browser'

/** CDP runtime binding name used inside the isolated annotation world. */
export const ANNOTATE_BINDING = '__kettuAnnotateReport'

/** Isolated world name so page scripts never see or collide with Kettu's annotation runtime. */
export const ANNOTATE_WORLD = 'kettu-annotate'

/** Input types whose values must never be captured into annotations. */
const BLOCKED_INPUT_TYPES = new Set(['password', 'hidden', 'file'])

/** Autocomplete tokens indicating credentials, OTPs, or payment secrets. */
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
])

/** Field name/id/label keywords that indicate sensitive user secrets. */
const SENSITIVE_FIELD_PATTERN =
  /\b(pass(word|wd|code|phrase)?|pwd|secret|token|api\s*key|access\s*key|private\s*key|auth\s*code|otp|totp|2fa|mfa|pin|cvv|cvc|ssn|social\s*security|credit\s*card|card\s*number)\b/i

/** Testing attributes preferred for concise, stable selectors. */
const TEST_ATTRIBUTES = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'] as const

/** Attribute names checked for unique element locators when no id or test attribute exists. */
const UNIQUE_ATTRIBUTES = ['name', 'aria-label', 'placeholder', 'title'] as const

/** Collapses whitespace and truncates text with an ellipsis when over `maxChars`. */
export function truncateVisibleText(
  text: string | null | undefined,
  maxChars: number,
): string | null {
  if (typeof text !== 'string') return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (normalized.length <= maxChars) return normalized
  if (maxChars <= 1) return normalized.slice(0, Math.max(0, maxChars))
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

/** Whether a hint string (field name, id, label, placeholder, autocomplete) suggests a secret. */
export function isSensitiveFieldHint(hint: string | null | undefined): boolean {
  if (typeof hint !== 'string' || !hint.trim()) return false
  const lower = hint.toLowerCase()
  for (const token of lower.split(/\s+/)) {
    if (SENSITIVE_AUTOCOMPLETE.has(token)) return true
  }
  // Split snake_case, kebab-case, and camelCase so tokens like `user_secret_token` match word boundaries.
  const normalized = hint.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return SENSITIVE_FIELD_PATTERN.test(normalized)
}

/** Minimal shape needed to decide whether a form control's value is sensitive. */
export interface SensitiveInputDescriptor {
  tag: string
  type?: string | null
  autocomplete?: string | null
  name?: string | null
  id?: string | null
  ariaLabel?: string | null
  placeholder?: string | null
  hidden?: boolean
  ariaHidden?: string | null
}

/**
 * Returns true if the described element is a password, hidden, file, or secret-bearing input
 * whose value must never be extracted or transmitted.
 */
export function isSensitiveInputDescriptor(desc: SensitiveInputDescriptor): boolean {
  const tag = desc.tag.toLowerCase()
  if (desc.hidden || desc.ariaHidden === 'true') return true
  const inputType = (desc.type ?? '').trim().toLowerCase()
  if (tag === 'input' && BLOCKED_INPUT_TYPES.has(inputType)) return true
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false
  return (
    isSensitiveFieldHint(desc.autocomplete) ||
    isSensitiveFieldHint(desc.name) ||
    isSensitiveFieldHint(desc.id) ||
    isSensitiveFieldHint(desc.ariaLabel) ||
    isSensitiveFieldHint(desc.placeholder)
  )
}

/** Escapes a CSS identifier safely without relying on global `CSS.escape`. */
export function cssEscapeIdent(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const ch = value[i]!
    if (code === 0) {
      out += '\uFFFD'
    } else if (
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      (i === 0 && code >= 0x0030 && code <= 0x0039) ||
      (i === 1 && code >= 0x0030 && code <= 0x0039 && value.charCodeAt(0) === 0x002d)
    ) {
      out += `\\${code.toString(16)} `
    } else if ((i === 0 && value.length === 1 && ch === '-') || !/[A-Za-z0-9_-]/.test(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return out
}

/** Escapes a string for use inside a double-quoted CSS attribute selector. */
export function cssEscapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')
}

/**
 * Filters out unstable utility/hash classes (e.g. CSS-in-JS hashes, Tailwind arbitrary variants)
 * so generated selectors stay readable and resilient.
 */
export function isStableClassName(name: string): boolean {
  if (!name || name.length > 40) return false
  if (!/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)) return false
  // Skip common CSS-in-JS and CSS Modules generated hashes.
  if (/^(css|sc|emotion|styled|jss|mui)-[a-z0-9]{4,}$/i.test(name)) return false
  if (/__[a-z0-9]{5,}$/i.test(name)) return false
  if (/[0-9]{4,}/.test(name)) return false
  return true
}

/** Minimal DOM-like interface so selector and metadata builders run cleanly in unit tests. */
export interface ElementLike {
  tagName: string
  id: string
  classList?: Iterable<string> | { [index: number]: string; length: number }
  parentElement: ElementLike | null
  children?: ArrayLike<ElementLike>
  getAttribute(name: string): string | null
  hasAttribute?(name: string): boolean
  innerText?: string
  textContent?: string | null
  value?: string
  type?: string
  hidden?: boolean
  selectedOptions?: ArrayLike<{ text?: string }>
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  closest?(selector: string): ElementLike | null
}

export interface DocumentLike {
  title?: string
  location?: { href?: string }
  querySelectorAll(selector: string): ArrayLike<unknown>
  getElementById?(id: string): ElementLike | null
}

function isUniqueSelector(root: DocumentLike, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function classNamesOf(el: ElementLike): string[] {
  if (!el.classList) return []
  const raw: string[] = []
  if (Symbol.iterator in el.classList) {
    for (const cls of el.classList as Iterable<string>) raw.push(cls)
  } else {
    const list = el.classList as { [index: number]: string; length: number }
    for (let i = 0; i < list.length; i++) {
      const cls = list[i]
      if (typeof cls === 'string') raw.push(cls)
    }
  }
  return raw.filter(isStableClassName).slice(0, 2)
}

function nthOfTypeIndex(el: ElementLike): { index: number; total: number } {
  const parent = el.parentElement
  if (!parent?.children) return { index: 1, total: 1 }
  const tag = el.tagName.toLowerCase()
  let index = 0
  let total = 0
  for (let i = 0; i < parent.children.length; i++) {
    const sibling = parent.children[i]!
    if (sibling.tagName.toLowerCase() !== tag) continue
    total += 1
    if (sibling === el) index = total
  }
  return { index: index || 1, total: total || 1 }
}

/**
 * Generates a concise, stable CSS selector for `element` within `root`, preferring unique `id`,
 * `data-testid`/`data-test`, unique semantic attributes, and finally a compact ancestor path with
 * stable classes or `:nth-of-type()`.
 */
export function buildStableSelector(element: ElementLike, root: DocumentLike): string {
  const tag = element.tagName.toLowerCase()

  const id = (element.id || element.getAttribute('id') || '').trim()
  if (id) {
    const byId = `#${cssEscapeIdent(id)}`
    if (isUniqueSelector(root, byId)) return byId
  }

  for (const attr of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attr)?.trim()
    if (!value || value.length > 80) continue
    const byTest = `[${attr}="${cssEscapeAttrValue(value)}"]`
    if (isUniqueSelector(root, byTest)) return byTest
  }

  for (const attr of UNIQUE_ATTRIBUTES) {
    const value = element.getAttribute(attr)?.trim()
    if (!value || value.length > 80) continue
    const byAttr = `${tag}[${attr}="${cssEscapeAttrValue(value)}"]`
    if (isUniqueSelector(root, byAttr)) return byAttr
  }

  const href = element.getAttribute('href')?.trim()
  if (tag === 'a' && href && href.length <= 80 && !/^javascript:/i.test(href)) {
    const byHref = `a[href="${cssEscapeAttrValue(href)}"]`
    if (isUniqueSelector(root, byHref)) return byHref
  }

  const segments: string[] = []
  let current: ElementLike | null = element
  let depth = 0
  while (current && depth < 6) {
    const curTag = current.tagName.toLowerCase()
    if (curTag === 'html') break

    const curId = (current.id || current.getAttribute('id') || '').trim()
    if (curId && current !== element) {
      const anchor = `#${cssEscapeIdent(curId)}`
      if (isUniqueSelector(root, anchor)) {
        segments.unshift(anchor)
        const candidate = segments.join(' > ')
        if (isUniqueSelector(root, candidate)) return candidate
      }
    }

    let anchoredByTest = false
    if (current !== element) {
      for (const attr of TEST_ATTRIBUTES) {
        const val = current.getAttribute(attr)?.trim()
        if (!val || val.length > 80) continue
        const anchor = `[${attr}="${cssEscapeAttrValue(val)}"]`
        if (isUniqueSelector(root, anchor)) {
          segments.unshift(anchor)
          anchoredByTest = true
          break
        }
      }
      if (anchoredByTest) {
        const candidate = segments.join(' > ')
        if (isUniqueSelector(root, candidate)) return candidate
      }
    }

    if (curTag === 'body') {
      segments.unshift('body')
      break
    }

    const classes = classNamesOf(current)
    let segment = curTag
    if (classes.length > 0) {
      segment += classes.map((c) => `.${cssEscapeIdent(c)}`).join('')
    }
    const { index, total } = nthOfTypeIndex(current)
    if (total > 1) {
      const siblingPath = [segment, ...segments].join(' > ')
      if (!isUniqueSelector(root, siblingPath)) {
        segment = `${curTag}:nth-of-type(${index})`
      }
    }

    segments.unshift(segment)
    const candidate = segments.join(' > ')
    if (isUniqueSelector(root, candidate)) return candidate

    current = current.parentElement
    depth += 1
  }

  return segments.join(' > ') || tag
}

/** Maps common HTML tags to their implicit ARIA role when no explicit `role` attribute is set. */
export function implicitRoleOf(element: ElementLike): string | null {
  const tag = element.tagName.toLowerCase()
  switch (tag) {
    case 'button':
      return 'button'
    case 'a':
      return element.getAttribute('href') ? 'link' : null
    case 'img':
      return 'img'
    case 'nav':
      return 'navigation'
    case 'main':
      return 'main'
    case 'header':
      return 'banner'
    case 'footer':
      return 'contentinfo'
    case 'aside':
      return 'complementary'
    case 'form':
      return 'form'
    case 'textarea':
      return 'textbox'
    case 'select':
      return 'combobox'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'input': {
      const type = (element.getAttribute('type') ?? element.type ?? 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'hidden') return null
      return 'textbox'
    }
    default:
      return null
  }
}

function accessibleNameOf(element: ElementLike, doc: DocumentLike): string | null {
  const ariaLabel = truncateVisibleText(
    element.getAttribute('aria-label'),
    BROWSER_ANNOTATION_LIMITS.accessibleName,
  )
  if (ariaLabel) return ariaLabel

  const labelledBy = element.getAttribute('aria-labelledby')?.trim()
  if (labelledBy && doc.getElementById) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById?.(id))
      .map((node) => (node ? (node.innerText ?? node.textContent ?? '') : ''))
      .filter(Boolean)
    const combined = truncateVisibleText(parts.join(' '), BROWSER_ANNOTATION_LIMITS.accessibleName)
    if (combined) return combined
  }

  const tag = element.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const id = (element.id || element.getAttribute('id') || '').trim()
    if (id) {
      try {
        const labels = doc.querySelectorAll(`label[for="${cssEscapeAttrValue(id)}"]`)
        if (labels.length > 0) {
          const labelEl = labels[0] as ElementLike
          const text = truncateVisibleText(
            labelEl.innerText ?? labelEl.textContent,
            BROWSER_ANNOTATION_LIMITS.accessibleName,
          )
          if (text) return text
        }
      } catch {
        // Ignore invalid selector edge cases.
      }
    }
    const ancestorLabel = element.closest?.('label')
    if (ancestorLabel) {
      const text = truncateVisibleText(
        ancestorLabel.innerText ?? ancestorLabel.textContent,
        BROWSER_ANNOTATION_LIMITS.accessibleName,
      )
      if (text) return text
    }
  }

  if (tag === 'img') {
    const alt = truncateVisibleText(
      element.getAttribute('alt'),
      BROWSER_ANNOTATION_LIMITS.accessibleName,
    )
    if (alt) return alt
  }

  return truncateVisibleText(
    element.getAttribute('title'),
    BROWSER_ANNOTATION_LIMITS.accessibleName,
  )
}

/**
 * Extracts structured, non-sensitive element metadata from a DOM element.
 * Mirrors the logic run inside the isolated browser world so it can be unit-tested directly.
 */
export function extractElementMetadata(
  element: ElementLike,
  doc: DocumentLike,
  viewport: { width: number; height: number },
): Omit<BrowserElementAnnotation, 'id' | 'tabId'> {
  const tag = element.tagName.toLowerCase()
  const domId = truncateVisibleText(
    element.id || element.getAttribute('id'),
    BROWSER_ANNOTATION_LIMITS.domId,
  )
  const role = truncateVisibleText(
    element.getAttribute('role') ?? implicitRoleOf(element),
    BROWSER_ANNOTATION_LIMITS.role,
  )
  const accessibleName = accessibleNameOf(element, doc)
  const selector =
    truncateVisibleText(buildStableSelector(element, doc), BROWSER_ANNOTATION_LIMITS.selector) ??
    tag

  const rawType = element.getAttribute('type') ?? element.type ?? null
  const sensitive = isSensitiveInputDescriptor({
    tag,
    type: rawType,
    autocomplete: element.getAttribute('autocomplete'),
    name: element.getAttribute('name'),
    id: domId,
    ariaLabel: element.getAttribute('aria-label'),
    placeholder: element.getAttribute('placeholder'),
    hidden: element.hidden || element.hasAttribute?.('hidden') === true,
    ariaHidden: element.getAttribute('aria-hidden'),
  })

  const attributes: BrowserElementAttributes = {}
  const href = element.getAttribute('href')?.trim()
  if (href && !/^javascript:/i.test(href)) {
    const cleaned = truncateVisibleText(href, BROWSER_ANNOTATION_LIMITS.attribute)
    if (cleaned) attributes.href = cleaned
  }
  const alt = truncateVisibleText(element.getAttribute('alt'), BROWSER_ANNOTATION_LIMITS.attribute)
  if (alt) attributes.alt = alt
  const placeholder = truncateVisibleText(
    element.getAttribute('placeholder'),
    BROWSER_ANNOTATION_LIMITS.attribute,
  )
  if (placeholder) attributes.placeholder = placeholder
  const title = truncateVisibleText(
    element.getAttribute('title'),
    BROWSER_ANNOTATION_LIMITS.attribute,
  )
  if (title) attributes.title = title
  if ((tag === 'input' || tag === 'button') && rawType) {
    const cleanedType = truncateVisibleText(rawType.toLowerCase(), BROWSER_ANNOTATION_LIMITS.tag)
    if (cleanedType) attributes.type = cleanedType
  }

  if (!sensitive && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
    let rawValue: string | null = null
    if (tag === 'select' && element.selectedOptions && element.selectedOptions.length > 0) {
      const selectedTexts: string[] = []
      for (let i = 0; i < element.selectedOptions.length; i++) {
        const text = element.selectedOptions[i]?.text
        if (text) selectedTexts.push(text)
      }
      rawValue = selectedTexts.join(', ')
    } else if (typeof element.value === 'string') {
      rawValue = element.value
    }
    const cleanedValue = truncateVisibleText(rawValue, BROWSER_ANNOTATION_LIMITS.value)
    if (cleanedValue) attributes.value = cleanedValue
  }

  // Never read form control textContent as visible text for inputs/textareas; prefer rendered innerText.
  let text: string | null = null
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
    const rawText = element.innerText !== undefined ? element.innerText : element.textContent
    text = truncateVisibleText(rawText, BROWSER_ANNOTATION_LIMITS.text)
  }

  const bounds = element.getBoundingClientRect()
  const rect = {
    x: Math.round(bounds.left),
    y: Math.round(bounds.top),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  }

  return {
    url: doc.location?.href ?? '',
    pageTitle: truncateVisibleText(doc.title, BROWSER_ANNOTATION_LIMITS.pageTitle),
    selector,
    tag,
    domId,
    role,
    accessibleName,
    text,
    attributes,
    rect,
    viewport: {
      width: Math.max(0, Math.round(viewport.width)),
      height: Math.max(0, Math.round(viewport.height)),
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteInt = (value: unknown, min = -100_000): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(min, Math.round(value))
}

/**
 * Validates and sanitizes an untrusted annotation payload received from a web page over CDP.
 * Enforces URL checks, length limits, and second-layer redaction of sensitive input values.
 */
export function sanitizeAnnotatedPayload(
  raw: unknown,
  fallbackUrl: string | null,
  fallbackTitle: string | null,
  tabId?: string,
): BrowserElementAnnotation | null {
  if (!isRecord(raw)) return null
  const candidateUrl = typeof raw.url === 'string' && raw.url ? raw.url : (fallbackUrl ?? '')
  if (!isAnnotatableBrowserUrl(candidateUrl)) return null
  const url = candidateUrl.slice(0, BROWSER_ANNOTATION_LIMITS.url)

  const tag = truncateVisibleText(
    typeof raw.tag === 'string' ? raw.tag.toLowerCase() : null,
    BROWSER_ANNOTATION_LIMITS.tag,
  )
  const selector = truncateVisibleText(
    typeof raw.selector === 'string' ? raw.selector : null,
    BROWSER_ANNOTATION_LIMITS.selector,
  )
  if (!tag || !selector) return null

  const domId = truncateVisibleText(
    typeof raw.domId === 'string' ? raw.domId : null,
    BROWSER_ANNOTATION_LIMITS.domId,
  )
  const role = truncateVisibleText(
    typeof raw.role === 'string' ? raw.role : null,
    BROWSER_ANNOTATION_LIMITS.role,
  )
  const accessibleName = truncateVisibleText(
    typeof raw.accessibleName === 'string' ? raw.accessibleName : null,
    BROWSER_ANNOTATION_LIMITS.accessibleName,
  )
  const pageTitle = truncateVisibleText(
    typeof raw.pageTitle === 'string' && raw.pageTitle.trim() ? raw.pageTitle : fallbackTitle,
    BROWSER_ANNOTATION_LIMITS.pageTitle,
  )

  const rawAttrs = isRecord(raw.attributes) ? raw.attributes : {}
  const attrType = truncateVisibleText(
    typeof rawAttrs.type === 'string' ? rawAttrs.type.toLowerCase() : null,
    BROWSER_ANNOTATION_LIMITS.tag,
  )
  const attrPlaceholder = truncateVisibleText(
    typeof rawAttrs.placeholder === 'string' ? rawAttrs.placeholder : null,
    BROWSER_ANNOTATION_LIMITS.attribute,
  )
  const attrTitle = truncateVisibleText(
    typeof rawAttrs.title === 'string' ? rawAttrs.title : null,
    BROWSER_ANNOTATION_LIMITS.attribute,
  )
  const attrAlt = truncateVisibleText(
    typeof rawAttrs.alt === 'string' ? rawAttrs.alt : null,
    BROWSER_ANNOTATION_LIMITS.attribute,
  )
  const rawHref = typeof rawAttrs.href === 'string' ? rawAttrs.href.trim() : ''
  const attrHref =
    rawHref && !/^javascript:/i.test(rawHref)
      ? truncateVisibleText(rawHref, BROWSER_ANNOTATION_LIMITS.attribute)
      : null

  const sensitive = isSensitiveInputDescriptor({
    tag,
    type: attrType,
    autocomplete: typeof raw.autocomplete === 'string' ? raw.autocomplete : null,
    name: typeof raw.inputName === 'string' ? raw.inputName : null,
    id: domId,
    ariaLabel: accessibleName,
    placeholder: attrPlaceholder,
    hidden: raw.hidden === true,
    ariaHidden: typeof raw.ariaHidden === 'string' ? raw.ariaHidden : null,
  })

  const attributes: BrowserElementAttributes = {}
  if (attrHref) attributes.href = attrHref
  if (attrAlt) attributes.alt = attrAlt
  if (attrPlaceholder) attributes.placeholder = attrPlaceholder
  if (attrTitle) attributes.title = attrTitle
  if (attrType) attributes.type = attrType
  if (!sensitive && typeof rawAttrs.value === 'string') {
    const attrValue = truncateVisibleText(rawAttrs.value, BROWSER_ANNOTATION_LIMITS.value)
    if (attrValue) attributes.value = attrValue
  }

  const text = sensitive
    ? null
    : truncateVisibleText(
        typeof raw.text === 'string' ? raw.text : null,
        BROWSER_ANNOTATION_LIMITS.text,
      )

  const rawRect = isRecord(raw.rect) ? raw.rect : {}
  const rawViewport = isRecord(raw.viewport) ? raw.viewport : {}

  return {
    id: `ba_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    url,
    pageTitle,
    selector,
    tag,
    domId,
    role,
    accessibleName,
    text,
    attributes,
    rect: {
      x: finiteInt(rawRect.x),
      y: finiteInt(rawRect.y),
      width: finiteInt(rawRect.width, 0),
      height: finiteInt(rawRect.height, 0),
    },
    viewport: {
      width: finiteInt(rawViewport.width, 0),
      height: finiteInt(rawViewport.height, 0),
    },
    ...(tabId ? { tabId } : {}),
  }
}

export type AnnotateBindingMessage = { type: 'pick'; element: unknown } | { type: 'exit' }

/** Validates a raw JSON payload received via `Runtime.bindingCalled` against `expectedToken`. */
export function parseBindingMessage(
  payload: unknown,
  expectedToken: string | null,
): AnnotateBindingMessage | null {
  if (!expectedToken || typeof payload !== 'string' || payload.length > 64 * 1024) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.token !== expectedToken) return null
  if (parsed.type === 'exit') return { type: 'exit' }
  if (parsed.type === 'pick' && isRecord(parsed.element)) {
    return { type: 'pick', element: parsed.element }
  }
  return null
}

/**
 * Generates the self-contained script injected into the tab's isolated world to display the
 * Shadow DOM hover highlight, capture element clicks without triggering page actions, and clean
 * up completely when torn down or exited with Escape.
 */
export function buildAnnotateInstallScript(token: string): string {
  const tokenJson = JSON.stringify(token)
  const bindingJson = JSON.stringify(ANNOTATE_BINDING)
  const limitsJson = JSON.stringify(BROWSER_ANNOTATION_LIMITS)
  return `(() => {
  const GLOBAL = globalThis;
  const CLEANUP_KEY = '__kettuAnnotateCleanup';
  if (typeof GLOBAL[CLEANUP_KEY] === 'function') {
    try { GLOBAL[CLEANUP_KEY](); } catch {}
  }

  const TOKEN = ${tokenJson};
  const BINDING = ${bindingJson};
  const LIMITS = ${limitsJson};
  const HOST_ATTR = 'data-kettu-annotate-host';
  const STYLE_ATTR = 'data-kettu-annotate-cursor';
  const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];
  const UNIQUE_ATTRS = ['name', 'aria-label', 'placeholder', 'title'];
  const BLOCKED_TYPES = new Set(['password', 'hidden', 'file']);
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'
  ]);
  const SENSITIVE_RE = /\\b(pass(word|wd|code|phrase)?|pwd|secret|token|api\\s*key|access\\s*key|private\\s*key|auth\\s*code|otp|totp|2fa|mfa|pin|cvv|cvc|ssn|social\\s*security|credit\\s*card|card\\s*number)\\b/i;

  const rootEl = document.documentElement;
  if (!rootEl) return false;

  const cursorStyle = document.createElement('style');
  cursorStyle.setAttribute(STYLE_ATTR, '1');
  cursorStyle.textContent = 'html, body, body * { cursor: crosshair !important; }';
  rootEl.appendChild(cursorStyle);

  const host = document.createElement('div');
  host.setAttribute(HOST_ATTR, '1');
  const shadow = host.attachShadow({ mode: 'closed' });

  const sheet = document.createElement('style');
  sheet.textContent = [
    ':host{all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;}',
    '.hover{position:fixed;box-sizing:border-box;display:none;pointer-events:none;border:2px solid #0060e2;background:rgba(0,96,226,0.12);border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,0.75);}',
    '.flash{position:fixed;box-sizing:border-box;display:none;pointer-events:none;border:2px solid #f2581b;background:rgba(242,88,27,0.16);border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,0.85);opacity:1;transition:opacity 420ms ease-out;}',
    '.badge{position:fixed;display:none;pointer-events:none;max-width:340px;padding:3px 7px;border-radius:5px;background:#161c24;color:#f5f7fa;font:500 11px/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 12px rgba(0,0,0,0.28),0 0 0 1px rgba(255,255,255,0.12);}',
    '.badge .dim{color:#9ab8da;margin-left:6px;font-weight:400;}'
  ].join('');
  shadow.appendChild(sheet);

  const hoverBox = document.createElement('div');
  hoverBox.className = 'hover';
  const flashBox = document.createElement('div');
  flashBox.className = 'flash';
  const badge = document.createElement('div');
  badge.className = 'badge';
  const badgeMain = document.createElement('span');
  const badgeDim = document.createElement('span');
  badgeDim.className = 'dim';
  badge.appendChild(badgeMain);
  badge.appendChild(badgeDim);
  shadow.appendChild(hoverBox);
  shadow.appendChild(flashBox);
  shadow.appendChild(badge);
  rootEl.appendChild(host);

  function truncate(text, max) {
    if (typeof text !== 'string') return null;
    const norm = text.replace(/\\s+/g, ' ').trim();
    if (!norm) return null;
    if (norm.length <= max) return norm;
    return norm.slice(0, max - 1).trimEnd() + '…';
  }

  function escapeIdent(val) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(val);
    }
    return String(val).replace(/[^A-Za-z0-9_-]/g, '\\\\$&');
  }

  function escapeAttr(val) {
    return String(val).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\a ');
  }

  function isStableClass(name) {
    if (!name || name.length > 40) return false;
    if (!/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)) return false;
    if (/^(css|sc|emotion|styled|jss|mui)-[a-z0-9]{4,}$/i.test(name)) return false;
    if (/__[a-z0-9]{5,}$/i.test(name)) return false;
    if (/[0-9]{4,}/.test(name)) return false;
    return true;
  }

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  }

  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();
    const id = (el.id || el.getAttribute('id') || '').trim();
    if (id) {
      const byId = '#' + escapeIdent(id);
      if (isUnique(byId)) return byId;
    }
    for (const attr of TEST_ATTRS) {
      const val = (el.getAttribute(attr) || '').trim();
      if (val && val.length <= 80) {
        const sel = '[' + attr + '="' + escapeAttr(val) + '"]';
        if (isUnique(sel)) return sel;
      }
    }
    for (const attr of UNIQUE_ATTRS) {
      const val = (el.getAttribute(attr) || '').trim();
      if (val && val.length <= 80) {
        const sel = tag + '[' + attr + '="' + escapeAttr(val) + '"]';
        if (isUnique(sel)) return sel;
      }
    }
    const href = (el.getAttribute('href') || '').trim();
    if (tag === 'a' && href && href.length <= 80 && !/^javascript:/i.test(href)) {
      const sel = 'a[href="' + escapeAttr(href) + '"]';
      if (isUnique(sel)) return sel;
    }
    const segs = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      const curTag = cur.tagName.toLowerCase();
      if (curTag === 'html') break;
      const curId = (cur.id || cur.getAttribute('id') || '').trim();
      if (curId && cur !== el) {
        const anchor = '#' + escapeIdent(curId);
        if (isUnique(anchor)) {
          segs.unshift(anchor);
          if (isUnique(segs.join(' > '))) return segs.join(' > ');
        }
      }
      if (cur !== el) {
        let matched = false;
        for (const attr of TEST_ATTRS) {
          const val = (cur.getAttribute(attr) || '').trim();
          if (val && val.length <= 80) {
            const anchor = '[' + attr + '="' + escapeAttr(val) + '"]';
            if (isUnique(anchor)) {
              segs.unshift(anchor);
              matched = true;
              break;
            }
          }
        }
        if (matched && isUnique(segs.join(' > '))) return segs.join(' > ');
      }
      if (curTag === 'body') {
        segs.unshift('body');
        break;
      }
      const classes = Array.from(cur.classList || []).filter(isStableClass).slice(0, 2);
      let seg = curTag + (classes.length ? classes.map((c) => '.' + escapeIdent(c)).join('') : '');
      const parent = cur.parentElement;
      if (parent) {
        let index = 0;
        let total = 0;
        for (const child of Array.from(parent.children)) {
          if (child.tagName.toLowerCase() !== curTag) continue;
          total += 1;
          if (child === cur) index = total;
        }
        if (total > 1 && !isUnique([seg, ...segs].join(' > '))) {
          seg = curTag + ':nth-of-type(' + (index || 1) + ')';
        }
      }
      segs.unshift(seg);
      const cand = segs.join(' > ');
      if (isUnique(cand)) return cand;
      cur = cur.parentElement;
      depth += 1;
    }
    return segs.join(' > ') || tag;
  }

  function isSensitiveHint(val) {
    if (typeof val !== 'string' || !val.trim()) return false;
    const lower = val.toLowerCase();
    for (const part of lower.split(/\\s+/)) {
      if (SENSITIVE_AUTOCOMPLETE.has(part)) return true;
    }
    const norm = val.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    return SENSITIVE_RE.test(norm);
  }

  function isSensitiveElement(el) {
    const tag = el.tagName.toLowerCase();
    if (el.hidden || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    const type = (el.getAttribute('type') || el.type || '').trim().toLowerCase();
    if (tag === 'input' && BLOCKED_TYPES.has(type)) return true;
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
    return (
      isSensitiveHint(el.getAttribute('autocomplete')) ||
      isSensitiveHint(el.getAttribute('name')) ||
      isSensitiveHint(el.id || el.getAttribute('id')) ||
      isSensitiveHint(el.getAttribute('aria-label')) ||
      isSensitiveHint(el.getAttribute('placeholder'))
    );
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return el.getAttribute('href') ? 'link' : null;
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    return null;
  }

  function accessibleName(el) {
    const aria = truncate(el.getAttribute('aria-label'), LIMITS.accessibleName);
    if (aria) return aria;
    const labelledBy = (el.getAttribute('aria-labelledby') || '').trim();
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => {
        const node = document.getElementById(id);
        return node ? (node.innerText || node.textContent || '') : '';
      }).filter(Boolean);
      const joined = truncate(parts.join(' '), LIMITS.accessibleName);
      if (joined) return joined;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const id = (el.id || el.getAttribute('id') || '').trim();
      if (id) {
        try {
          const label = document.querySelector('label[for="' + escapeAttr(id) + '"]');
          if (label) {
            const txt = truncate(label.innerText || label.textContent, LIMITS.accessibleName);
            if (txt) return txt;
          }
        } catch {}
      }
      const parentLabel = typeof el.closest === 'function' ? el.closest('label') : null;
      if (parentLabel) {
        const txt = truncate(parentLabel.innerText || parentLabel.textContent, LIMITS.accessibleName);
        if (txt) return txt;
      }
    }
    if (tag === 'img') {
      const alt = truncate(el.getAttribute('alt'), LIMITS.accessibleName);
      if (alt) return alt;
    }
    return truncate(el.getAttribute('title'), LIMITS.accessibleName);
  }

  function extractVisibleText(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return null;
    try {
      const hasPasswordDescendant = typeof el.querySelector === 'function' && el.querySelector('input[type="password"]');
      if (hasPasswordDescendant) {
        const clone = el.cloneNode(true);
        for (const node of Array.from(clone.querySelectorAll('input, textarea, script, style'))) {
          node.remove();
        }
        return truncate(clone.textContent, LIMITS.text);
      }
    } catch {}
    return truncate(typeof el.innerText === 'string' ? el.innerText : el.textContent, LIMITS.text);
  }

  function extractElement(el) {
    const tag = el.tagName.toLowerCase();
    const domId = truncate(el.id || el.getAttribute('id'), LIMITS.domId);
    const role = truncate(el.getAttribute('role') || implicitRole(el), LIMITS.role);
    const name = accessibleName(el);
    const selector = truncate(buildSelector(el), LIMITS.selector) || tag;
    const sensitive = isSensitiveElement(el);
    const attrs = {};
    const href = (el.getAttribute('href') || '').trim();
    if (href && !/^javascript:/i.test(href)) {
      const cleanHref = truncate(href, LIMITS.attribute);
      if (cleanHref) attrs.href = cleanHref;
    }
    const alt = truncate(el.getAttribute('alt'), LIMITS.attribute);
    if (alt) attrs.alt = alt;
    const placeholder = truncate(el.getAttribute('placeholder'), LIMITS.attribute);
    if (placeholder) attrs.placeholder = placeholder;
    const title = truncate(el.getAttribute('title'), LIMITS.attribute);
    if (title) attrs.title = title;
    const rawType = el.getAttribute('type') || el.type || '';
    if ((tag === 'input' || tag === 'button') && rawType) {
      const cleanType = truncate(String(rawType).toLowerCase(), LIMITS.tag);
      if (cleanType) attrs.type = cleanType;
    }
    if (!sensitive && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
      let rawVal = '';
      if (tag === 'select' && el.selectedOptions && el.selectedOptions.length) {
        rawVal = Array.from(el.selectedOptions).map((o) => o.text || '').filter(Boolean).join(', ');
      } else if (typeof el.value === 'string') {
        rawVal = el.value;
      }
      const cleanVal = truncate(rawVal, LIMITS.value);
      if (cleanVal) attrs.value = cleanVal;
    }
    const r = el.getBoundingClientRect();
    return {
      url: location.href,
      pageTitle: truncate(document.title, LIMITS.pageTitle),
      selector,
      tag,
      domId,
      role,
      accessibleName: name,
      text: sensitive ? null : extractVisibleText(el),
      attributes: attrs,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      inputName: el.getAttribute('name') || undefined,
      hidden: Boolean(el.hidden || el.hasAttribute('hidden')),
      ariaHidden: el.getAttribute('aria-hidden') || undefined,
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.max(0, Math.round(r.width)),
        height: Math.max(0, Math.round(r.height))
      },
      viewport: {
        width: Math.max(0, Math.round(window.innerWidth)),
        height: Math.max(0, Math.round(window.innerHeight))
      }
    };
  }

  function targetAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function') {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el || el === host || el === rootEl || el === cursorStyle) return null;
    if (host.contains(el)) return null;
    return el;
  }

  function shortBadgeLabel(el) {
    const tag = el.tagName.toLowerCase();
    const id = (el.id || '').trim();
    if (id) return tag + '#' + id.slice(0, 32);
    for (const attr of TEST_ATTRS) {
      const val = (el.getAttribute(attr) || '').trim();
      if (val) return tag + '[' + attr + '="' + val.slice(0, 28) + '"]';
    }
    const classes = Array.from(el.classList || []).filter(isStableClass).slice(0, 2);
    if (classes.length) return tag + '.' + classes.join('.');
    return tag;
  }

  let hovered = null;
  let rafId = 0;
  let flashTimer = 0;
  let flashHideTimer = 0;

  function hideHover() {
    hoverBox.style.display = 'none';
    badge.style.display = 'none';
  }

  function positionHover(el) {
    if (!el || !el.isConnected) {
      hovered = null;
      hideHover();
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) {
      hideHover();
      return;
    }
    hoverBox.style.display = 'block';
    hoverBox.style.left = r.left + 'px';
    hoverBox.style.top = r.top + 'px';
    hoverBox.style.width = r.width + 'px';
    hoverBox.style.height = r.height + 'px';

    badgeMain.textContent = shortBadgeLabel(el);
    badgeDim.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    badge.style.display = 'block';
    const bRect = badge.getBoundingClientRect();
    const pad = 6;
    let top = r.top - bRect.height - pad;
    if (top < 4) {
      top = r.bottom + pad;
      if (top + bRect.height > window.innerHeight - 4) {
        top = Math.max(4, r.top + 4);
      }
    }
    const left = Math.max(4, Math.min(r.left, window.innerWidth - bRect.width - 4));
    badge.style.top = top + 'px';
    badge.style.left = left + 'px';
  }

  function flashPicked(el) {
    clearTimeout(flashTimer);
    clearTimeout(flashHideTimer);
    const r = el.getBoundingClientRect();
    flashBox.style.transition = 'none';
    flashBox.style.opacity = '1';
    flashBox.style.display = 'block';
    flashBox.style.left = r.left + 'px';
    flashBox.style.top = r.top + 'px';
    flashBox.style.width = r.width + 'px';
    flashBox.style.height = r.height + 'px';
    void flashBox.offsetWidth;
    flashBox.style.transition = 'opacity 420ms ease-out';
    flashTimer = setTimeout(() => {
      flashBox.style.opacity = '0';
      flashHideTimer = setTimeout(() => {
        flashBox.style.display = 'none';
      }, 440);
    }, 140);
  }

  function send(msg) {
    const fn = GLOBAL[BINDING];
    if (typeof fn === 'function') {
      try { fn(JSON.stringify(msg)); } catch {}
    }
  }

  function onPointerMove(e) {
    const el = targetAt(e.clientX, e.clientY);
    hovered = el;
    if (el) positionHover(el);
    else hideHover();
  }

  function onMouseOut(e) {
    if (!e.relatedTarget) {
      hovered = null;
      hideHover();
    }
  }

  function onBlur() {
    hovered = null;
    hideHover();
  }

  function scheduleReposition() {
    if (!hovered || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (hovered) positionHover(hovered);
    });
  }

  function blockPointerAction(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onSubmit(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = targetAt(e.clientX, e.clientY) || hovered;
    if (!el) return;
    flashPicked(el);
    send({ token: TOKEN, type: 'pick', element: extractElement(el) });
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    send({ token: TOKEN, type: 'exit' });
    cleanup();
  }

  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerdown', blockPointerAction, true);
  window.addEventListener('pointerup', blockPointerAction, true);
  window.addEventListener('mousedown', blockPointerAction, true);
  window.addEventListener('mouseup', blockPointerAction, true);
  window.addEventListener('auxclick', blockPointerAction, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('submit', onSubmit, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onBlur, false);
  window.addEventListener('resize', scheduleReposition, { passive: true });
  window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
  document.addEventListener('mouseout', onMouseOut, true);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    cancelAnimationFrame(rafId);
    clearTimeout(flashTimer);
    clearTimeout(flashHideTimer);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', blockPointerAction, true);
    window.removeEventListener('pointerup', blockPointerAction, true);
    window.removeEventListener('mousedown', blockPointerAction, true);
    window.removeEventListener('mouseup', blockPointerAction, true);
    window.removeEventListener('auxclick', blockPointerAction, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('submit', onSubmit, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onBlur, false);
    window.removeEventListener('resize', scheduleReposition);
    window.removeEventListener('scroll', scheduleReposition, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    if (cursorStyle.parentNode) cursorStyle.remove();
    if (host.parentNode) host.remove();
    if (GLOBAL[CLEANUP_KEY] === cleanup) {
      try { delete GLOBAL[CLEANUP_KEY]; } catch { GLOBAL[CLEANUP_KEY] = undefined; }
    }
  }

  GLOBAL[CLEANUP_KEY] = cleanup;
  return true;
})()`
}

/** Generates the teardown script that removes all injected annotation listeners and overlay DOM. */
export function buildAnnotateTeardownScript(): string {
  return `(() => {
  const GLOBAL = globalThis;
  const CLEANUP_KEY = '__kettuAnnotateCleanup';
  if (typeof GLOBAL[CLEANUP_KEY] === 'function') {
    try { GLOBAL[CLEANUP_KEY](); } catch {}
  }
  for (const node of Array.from(document.querySelectorAll('[data-kettu-annotate-host], [data-kettu-annotate-cursor]'))) {
    node.remove();
  }
  return true;
})()`
}
