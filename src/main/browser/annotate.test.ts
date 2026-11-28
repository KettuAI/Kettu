import { describe, expect, it } from 'vitest'
import { BROWSER_ANNOTATION_LIMITS } from '@shared/browser'
import {
  ANNOTATE_BINDING,
  buildAnnotateInstallScript,
  buildAnnotateTeardownScript,
  buildStableSelector,
  cssEscapeIdent,
  extractElementMetadata,
  isSensitiveFieldHint,
  isSensitiveInputDescriptor,
  isStableClassName,
  parseBindingMessage,
  sanitizeAnnotatedPayload,
  truncateVisibleText,
  type DocumentLike,
  type ElementLike,
} from './annotate'

interface MockNodeInit {
  tag: string
  id?: string
  classes?: string[]
  attrs?: Record<string, string>
  innerText?: string
  textContent?: string
  value?: string
  type?: string
  hidden?: boolean
  selectedOptions?: { text: string }[]
  rect?: { left: number; top: number; width: number; height: number }
  children?: MockElement[]
}

class MockElement implements ElementLike {
  readonly tagName: string
  readonly id: string
  readonly classList: string[]
  parentElement: MockElement | null = null
  readonly children: MockElement[]
  private readonly attrs: Record<string, string>
  readonly innerText?: string
  readonly textContent?: string
  readonly value?: string
  readonly type?: string
  readonly hidden?: boolean
  readonly selectedOptions?: { text: string }[]
  private readonly rect: { left: number; top: number; width: number; height: number }

  constructor(init: MockNodeInit) {
    this.tagName = init.tag.toUpperCase()
    this.id = init.id ?? init.attrs?.id ?? ''
    this.classList = init.classes ?? []
    this.attrs = { ...(init.attrs ?? {}) }
    if (this.id && !this.attrs.id) this.attrs.id = this.id
    if (init.type && !this.attrs.type) this.attrs.type = init.type
    this.innerText = init.innerText
    this.textContent = init.textContent
    this.value = init.value
    this.type = init.type ?? this.attrs.type
    this.hidden = init.hidden
    this.selectedOptions = init.selectedOptions
    this.rect = init.rect ?? { left: 10, top: 20, width: 120, height: 36 }
    this.children = init.children ?? []
    for (const child of this.children) child.parentElement = this
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs
  }

  getBoundingClientRect() {
    return this.rect
  }

  closest(selector: string): ElementLike | null {
    const wanted = selector.toLowerCase()
    let cur: MockElement | null = this.parentElement
    while (cur) {
      if (cur.tagName.toLowerCase() === wanted) return cur
      cur = cur.parentElement
    }
    return null
  }
}

function makeDoc(
  matchesBySelector: Record<string, MockElement[]>,
  opts: {
    href?: string
    title?: string
    byId?: Record<string, MockElement>
  } = {},
): DocumentLike {
  return {
    title: opts.title ?? 'Demo App',
    location: { href: opts.href ?? 'https://example.com/dashboard' },
    querySelectorAll: (selector) => matchesBySelector[selector] ?? [],
    getElementById: (id) => opts.byId?.[id] ?? null,
  }
}

describe('truncateVisibleText & CSS helpers', () => {
  it('collapses whitespace and truncates long text with an ellipsis', () => {
    expect(truncateVisibleText('  Hello \n\t  world  ', 20)).toBe('Hello world')
    expect(truncateVisibleText('   ', 20)).toBeNull()
    expect(truncateVisibleText('abcdefghij', 6)).toBe('abcde…')
  })

  it('escapes special characters in CSS identifiers', () => {
    expect(cssEscapeIdent('submit-btn')).toBe('submit-btn')
    expect(cssEscapeIdent('123item')).toBe('\\31 23item')
    expect(cssEscapeIdent('form:email')).toBe('form\\:email')
  })

  it('filters out unstable generated CSS-in-JS and arbitrary utility classes', () => {
    expect(isStableClassName('nav-link')).toBe(true)
    expect(isStableClassName('primary_btn')).toBe(true)
    expect(isStableClassName('css-1a2b3c4')).toBe(false)
    expect(isStableClassName('sc-abc1234')).toBe(false)
    expect(isStableClassName('hover:bg-blue-500')).toBe(false)
    expect(isStableClassName('w-[120px]')).toBe(false)
    expect(isStableClassName('Button__x9k2m1')).toBe(false)
  })
})

describe('buildStableSelector', () => {
  it('prefers unique id over test attributes and classes', () => {
    const button = new MockElement({
      tag: 'button',
      id: 'save-btn',
      attrs: { 'data-testid': 'save-action' },
      classes: ['primary'],
    })
    const doc = makeDoc({ '#save-btn': [button], '[data-testid="save-action"]': [button] })
    expect(buildStableSelector(button, doc)).toBe('#save-btn')
  })

  it('falls back to data-testid / data-test when no unique id exists', () => {
    const item = new MockElement({
      tag: 'button',
      attrs: { 'data-test': 'checkout-cta' },
    })
    const doc = makeDoc({ '[data-test="checkout-cta"]': [item] })
    expect(buildStableSelector(item, doc)).toBe('[data-test="checkout-cta"]')
  })

  it('uses unique semantic attributes like aria-label or href', () => {
    const link = new MockElement({
      tag: 'a',
      attrs: { href: '/settings/profile' },
    })
    const doc = makeDoc({ 'a[href="/settings/profile"]': [link] })
    expect(buildStableSelector(link, doc)).toBe('a[href="/settings/profile"]')
  })

  it('builds a concise ancestor path with nth-of-type when siblings share the tag', () => {
    const first = new MockElement({ tag: 'li', classes: ['css-a1b2c3'] })
    const second = new MockElement({ tag: 'li', classes: ['css-d4e5f6'] })
    const list = new MockElement({ tag: 'ul', id: 'nav-list', children: [first, second] })
    const doc = makeDoc({
      '#nav-list': [list],
      li: [first, second],
      'li:nth-of-type(2)': [second],
      '#nav-list > li:nth-of-type(2)': [second],
    })
    expect(buildStableSelector(second, doc)).toBe('li:nth-of-type(2)')

    const scopedDoc = makeDoc({
      '#nav-list': [list],
      li: [first, second],
      'li:nth-of-type(2)': [second, new MockElement({ tag: 'li' })],
      '#nav-list > li:nth-of-type(2)': [second],
    })
    expect(buildStableSelector(second, scopedDoc)).toBe('#nav-list > li:nth-of-type(2)')
  })
})

describe('sensitive input detection & redaction', () => {
  it('flags password, hidden, file, OTP, and secret inputs', () => {
    expect(isSensitiveInputDescriptor({ tag: 'input', type: 'password' })).toBe(true)
    expect(isSensitiveInputDescriptor({ tag: 'input', type: 'hidden' })).toBe(true)
    expect(isSensitiveInputDescriptor({ tag: 'input', type: 'file' })).toBe(true)
    expect(
      isSensitiveInputDescriptor({ tag: 'input', type: 'text', autocomplete: 'current-password' }),
    ).toBe(true)
    expect(
      isSensitiveInputDescriptor({ tag: 'input', type: 'text', autocomplete: 'one-time-code' }),
    ).toBe(true)
    expect(isSensitiveInputDescriptor({ tag: 'input', type: 'text', name: 'api_key' })).toBe(true)
    expect(
      isSensitiveInputDescriptor({ tag: 'input', type: 'text', placeholder: 'Enter CVV' }),
    ).toBe(true)
    expect(isSensitiveFieldHint('user_secret_token')).toBe(true)
    expect(isSensitiveFieldHint('userSecretToken')).toBe(true)
    expect(isSensitiveFieldHint('compass')).toBe(false)
    expect(isSensitiveInputDescriptor({ tag: 'input', type: 'text', name: 'search' })).toBe(false)
  })

  it('never captures value from password or hidden inputs in extractElementMetadata', () => {
    const passwordInput = new MockElement({
      tag: 'input',
      id: 'login-password',
      type: 'password',
      attrs: { placeholder: 'Password', autocomplete: 'current-password' },
      value: 'super-secret-123!',
    })
    const doc = makeDoc({ '#login-password': [passwordInput] })
    const meta = extractElementMetadata(passwordInput, doc, { width: 1280, height: 800 })
    expect(meta.tag).toBe('input')
    expect(meta.attributes.type).toBe('password')
    expect(meta.attributes.placeholder).toBe('Password')
    expect(meta.attributes.value).toBeUndefined()
    expect(meta.text).toBeNull()
  })

  it('captures visible value for ordinary non-sensitive inputs and selects', () => {
    const searchInput = new MockElement({
      tag: 'input',
      id: 'q',
      type: 'search',
      attrs: { placeholder: 'Search docs', 'aria-label': 'Search documentation' },
      value: 'keyboard shortcuts',
    })
    const doc = makeDoc({ '#q': [searchInput] })
    const meta = extractElementMetadata(searchInput, doc, { width: 1280, height: 800 })
    expect(meta.role).toBe('searchbox')
    expect(meta.accessibleName).toBe('Search documentation')
    expect(meta.attributes.value).toBe('keyboard shortcuts')
    expect(meta.attributes.placeholder).toBe('Search docs')
  })

  it('extracts accessible name from associated label and truncates long visible text', () => {
    const longText = 'word '.repeat(80)
    const button = new MockElement({
      tag: 'button',
      id: 'long-btn',
      innerText: longText,
      attrs: { title: 'Submit order' },
    })
    const doc = makeDoc({ '#long-btn': [button] })
    const meta = extractElementMetadata(button, doc, { width: 1024, height: 768 })
    expect(meta.role).toBe('button')
    expect(meta.text).not.toBeNull()
    expect(meta.text!.length).toBeLessThanOrEqual(BROWSER_ANNOTATION_LIMITS.text)
    expect(meta.text!.endsWith('…')).toBe(true)
    expect(meta.viewport).toEqual({ width: 1024, height: 768 })
  })
})

describe('sanitizeAnnotatedPayload & parseBindingMessage', () => {
  it('redacts sensitive input values even if a page attempts to send them in raw payload', () => {
    const sanitized = sanitizeAnnotatedPayload(
      {
        url: 'https://app.example.com/login',
        pageTitle: 'Sign in',
        selector: '#pwd',
        tag: 'input',
        domId: 'pwd',
        role: 'textbox',
        accessibleName: 'Password',
        text: 'should-be-dropped',
        attributes: {
          type: 'password',
          placeholder: 'Enter password',
          value: 'leaked-password',
          href: 'javascript:alert(1)',
        },
        rect: { x: 10.4, y: 20.6, width: 200.2, height: 34.8 },
        viewport: { width: 1280, height: 800 },
      },
      null,
      null,
      't1',
    )
    expect(sanitized).not.toBeNull()
    expect(sanitized!.attributes.value).toBeUndefined()
    expect(sanitized!.attributes.href).toBeUndefined()
    expect(sanitized!.text).toBeNull()
    expect(sanitized!.attributes.placeholder).toBe('Enter password')
    expect(sanitized!.rect).toEqual({ x: 10, y: 21, width: 200, height: 35 })
    expect(sanitized!.tabId).toBe('t1')
  })

  it('rejects non-http(s) URLs and malformed payloads', () => {
    expect(
      sanitizeAnnotatedPayload(
        { url: 'about:blank', selector: 'div', tag: 'div' },
        'about:blank',
        null,
      ),
    ).toBeNull()
    expect(
      sanitizeAnnotatedPayload(
        { url: 'file:///etc/passwd', selector: 'body', tag: 'body' },
        null,
        null,
      ),
    ).toBeNull()
    expect(sanitizeAnnotatedPayload(null, 'https://example.com', null)).toBeNull()
  })

  it('validates CDP binding messages against the session token', () => {
    const token = 'tok-123'
    expect(parseBindingMessage(JSON.stringify({ token, type: 'exit' }), token)).toEqual({
      type: 'exit',
    })
    expect(
      parseBindingMessage(
        JSON.stringify({ token, type: 'pick', element: { tag: 'button', selector: '#ok' } }),
        token,
      ),
    ).toEqual({ type: 'pick', element: { tag: 'button', selector: '#ok' } })
    expect(parseBindingMessage(JSON.stringify({ token: 'wrong', type: 'exit' }), token)).toBeNull()
    expect(parseBindingMessage('not-json', token)).toBeNull()
    expect(parseBindingMessage(JSON.stringify({ token, type: 'exit' }), null)).toBeNull()
  })

  it('generates syntactically valid install and teardown scripts referencing the binding', () => {
    const install = buildAnnotateInstallScript('token-abc')
    const teardown = buildAnnotateTeardownScript()
    expect(install).toContain(ANNOTATE_BINDING)
    expect(install).toContain("attachShadow({ mode: 'closed' })")
    expect(teardown).toContain('__kettuAnnotateCleanup')
    expect(() => new Function(install)).not.toThrow()
    expect(() => new Function(teardown)).not.toThrow()
  })
})
