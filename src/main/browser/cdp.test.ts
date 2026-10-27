// The browser's driving layer, as far as it can be tested without Electron: the outline a page
// becomes, the keys a combination turns into, and the rules a navigation follows.

import { describe, expect, it } from 'vitest'
import {
  MAX_SNAPSHOT_LINES,
  ToolFailure,
  buildOutline,
  checkAgentNavigation,
  hasSettled,
  outlineText,
  parseKey,
} from './cdp'

// An accessibility node, shaped as Accessibility.getFullAXTree reports one.
interface Node {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  value?: { value?: unknown }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
}

function node(id: string, role: string, extra: Partial<Node> = {}): Node {
  return { nodeId: id, role: { value: role }, ...extra }
}

/** A sign-in page: a banner link, a heading, two fields, a checkbox and a button. */
function signInTree(): Node[] {
  return [
    node('1', 'RootWebArea', { name: { value: 'Sign in · Acme' }, childIds: ['2', '3'] }),
    node('2', 'banner', { childIds: ['4'], parentId: '1' }),
    node('4', 'link', { name: { value: 'Acme' }, backendDOMNodeId: 41, parentId: '2' }),
    node('3', 'main', { childIds: ['5', '6', '7', '8', '9'], parentId: '1' }),
    node('5', 'heading', {
      name: { value: 'Sign in' },
      properties: [{ name: 'level', value: { value: 1 } }],
      parentId: '3',
    }),
    node('6', 'textbox', { name: { value: 'Email' }, backendDOMNodeId: 42, parentId: '3' }),
    node('7', 'textbox', {
      name: { value: 'Password' },
      backendDOMNodeId: 43,
      parentId: '3',
      properties: [{ name: 'valuetext', value: { value: 'hunter2' } }],
    }),
    node('8', 'checkbox', {
      name: { value: 'Remember me' },
      backendDOMNodeId: 44,
      parentId: '3',
      properties: [{ name: 'checked', value: { value: false } }],
    }),
    node('9', 'button', {
      name: { value: 'Sign in' },
      backendDOMNodeId: 45,
      parentId: '3',
      properties: [{ name: 'disabled', value: { value: false } }],
    }),
  ]
}

describe('buildOutline', () => {
  it('writes the page as an indented outline with a ref on what an agent can act on', () => {
    const outline = buildOutline(signInTree())
    expect(outline.lines).toEqual([
      '- banner:',
      '  - link "Acme" [ref=e1]',
      '- main:',
      '  - heading "Sign in" [level=1]',
      '  - textbox "Email" [ref=e2]',
      '  - textbox "Password" [value="hunter2"] [ref=e3]',
      '  - checkbox "Remember me" [ref=e4]',
      '  - button "Sign in" [ref=e5]',
    ])
    expect([...outline.refs.entries()]).toEqual([
      ['e1', 41],
      ['e2', 42],
      ['e3', 43],
      ['e4', 44],
      ['e5', 45],
    ])
    expect(outline.more).toBe(0)
  })

  it('shows the states an agent acts on', () => {
    const outline = buildOutline([
      node('1', 'RootWebArea', { childIds: ['2', '3', '4', '5'] }),
      node('2', 'checkbox', {
        name: { value: 'Checked' },
        backendDOMNodeId: 1,
        properties: [{ name: 'checked', value: { value: true } }],
      }),
      node('3', 'button', {
        name: { value: 'Off' },
        backendDOMNodeId: 2,
        properties: [
          { name: 'disabled', value: { value: true } },
          { name: 'expanded', value: { value: false } },
        ],
      }),
      node('4', 'link', {
        name: { value: 'Open' },
        backendDOMNodeId: 3,
        properties: [{ name: 'expanded', value: { value: true } }],
      }),
      node('5', 'tab', {
        name: { value: 'One' },
        backendDOMNodeId: 4,
        properties: [{ name: 'selected', value: { value: true } }],
      }),
    ])
    expect(outline.lines).toEqual([
      '- checkbox "Checked" [checked] [ref=e1]',
      '- button "Off" [disabled] [ref=e2]',
      '- link "Open" [expanded] [ref=e3]',
      '- tab "One" [selected] [ref=e4]',
    ])
  })

  it('drops ignored nodes and the wrappers that only hold one child', () => {
    const outline = buildOutline([
      node('1', 'RootWebArea', {
        name: { value: 'Page' },
        childIds: ['2', '3'],
      }),
      node('2', 'generic', { ignored: true, childIds: ['4'], parentId: '1' }),
      node('4', 'button', { name: { value: 'Save' }, backendDOMNodeId: 9, parentId: '2' }),
      node('3', 'none', { childIds: ['5'], parentId: '1' }),
      node('5', 'StaticText', { name: { value: 'Hello' }, parentId: '3' }),
    ])
    expect(outline.lines).toEqual(['- button "Save" [ref=e1]'])
  })

  it('includes a same-origin frame under its iframe node', () => {
    const outline = buildOutline([
      node('1', 'RootWebArea', { name: { value: 'Host' }, childIds: ['2'] }),
      node('2', 'Iframe', { name: { value: 'Inner' }, childIds: ['3'], parentId: '1' }),
      node('3', 'RootWebArea', { childIds: ['4'], parentId: '2' }),
      node('4', 'link', { name: { value: 'Away' }, backendDOMNodeId: 7, parentId: '3' }),
    ])
    expect(outline.lines).toEqual(['- iframe "Inner":', '  - link "Away" [ref=e1]'])
  })

  it('stops at 2000 lines and says how many it left', () => {
    const children = Array.from({ length: 2_100 }, (_, i) =>
      node(`c${i}`, 'button', {
        name: { value: `Line ${i}` },
        backendDOMNodeId: i + 1,
        parentId: '1',
      }),
    )
    const outline = buildOutline([
      node('1', 'RootWebArea', {
        name: { value: 'Long' },
        childIds: children.map((c) => c.nodeId),
      }),
      ...children,
    ])
    expect(outline.lines).toHaveLength(MAX_SNAPSHOT_LINES)
    expect(outline.more).toBe(100)
    expect(outlineText({ url: 'http://localhost/', title: 'Long' }, outline)).toMatch(
      /\n… 100 more lines$/,
    )
  })

  it('counts each ref once, however many nodes share a backend id', () => {
    const outline = buildOutline([
      node('1', 'RootWebArea', { childIds: ['2', '3'] }),
      node('2', 'link', { name: { value: 'One' }, backendDOMNodeId: 5 }),
      node('3', 'link', { name: { value: 'Two' }, backendDOMNodeId: 5 }),
    ])
    expect([...outline.refs.values()]).toEqual([5, 5])
    expect([...outline.refs.keys()]).toEqual(['e1', 'e2'])
  })
})

describe('outlineText', () => {
  it('heads the outline with the page title and address', () => {
    const text = outlineText(
      { url: 'http://localhost:5173/login', title: 'Sign in · Acme' },
      buildOutline(signInTree()),
    )
    expect(text.split('\n')[0]).toBe('- Page: Sign in · Acme (http://localhost:5173/login)')
  })

  it('says Untitled and about:blank when the page has neither', () => {
    const text = outlineText({ url: '', title: null }, { lines: [], refs: new Map(), more: 0 })
    expect(text).toBe('- Page: Untitled (about:blank)')
  })
})

describe('parseKey', () => {
  it('reads a named key', () => {
    expect(parseKey('Enter')).toMatchObject({
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    })
    expect(parseKey('ArrowDown')).toMatchObject({ code: 'ArrowDown', windowsVirtualKeyCode: 40 })
    expect(parseKey('Escape')).toMatchObject({ code: 'Escape', windowsVirtualKeyCode: 27 })
    expect(parseKey('F5')).toMatchObject({ code: 'F5', windowsVirtualKeyCode: 116 })
  })

  it('reads a combination, with its modifiers', () => {
    expect(parseKey('Control+A')).toMatchObject({
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    })
    expect(parseKey('Shift+Control+ArrowLeft')).toMatchObject({
      code: 'ArrowLeft',
      modifiers: 10,
    })
    expect(parseKey('Meta+Shift+Enter')).toMatchObject({ code: 'Enter', modifiers: 12 })
  })

  it('sends no text with a control key, so the page does not see a letter', () => {
    expect(parseKey('Control+A')).not.toHaveProperty('text')
    expect(parseKey('a')).toMatchObject({ key: 'a', text: 'a' })
    expect(parseKey('Shift+A')).toMatchObject({ key: 'A', text: 'A', modifiers: 8 })
  })

  it('refuses a key it does not know', () => {
    for (const key of ['', 'Control+', 'Hyper+A', 'SomeKey', 'Control+NotAKey']) {
      expect(() => parseKey(key)).toThrow(ToolFailure)
    }
  })
})

describe('checkAgentNavigation', () => {
  it('opens a local dev host and the empty document', () => {
    expect(checkAgentNavigation('http://localhost:5173/login')).toBe('http://localhost:5173/login')
    expect(checkAgentNavigation('about:blank')).toBe('about:blank')
  })

  it('refuses any other origin until the user allows it, naming it', () => {
    expect(() => checkAgentNavigation('https://example.com/')).toThrow(
      expect.objectContaining({
        code: 'not_allowed',
        message: expect.stringContaining('example.com'),
      }),
    )
  })

  it('refuses a scheme that never opens', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(() => checkAgentNavigation(url)).toThrow(
        expect.objectContaining({ code: 'not_allowed' }),
      )
    }
  })

  it('refuses a relative address as invalid', () => {
    expect(() => checkAgentNavigation('/login')).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    )
  })
})

describe('hasSettled', () => {
  const quiet = { loading: false, inFlight: 0 }

  it('waits while the page loads or a request is in flight', () => {
    expect(hasSettled({ ...quiet, loading: true, idleSince: 0 }, 5_000)).toBe(false)
    expect(hasSettled({ ...quiet, inFlight: 1, idleSince: 0 }, 5_000)).toBe(false)
  })

  it('settles once the network has been quiet for 500 ms', () => {
    expect(hasSettled({ ...quiet, idleSince: 1_000 }, 1_400)).toBe(false)
    expect(hasSettled({ ...quiet, idleSince: 1_000 }, 1_500)).toBe(true)
    expect(hasSettled({ ...quiet, idleSince: null }, 1_500)).toBe(false)
  })
})
