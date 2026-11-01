// The web client's pairing page in each state it shows, rendered to text, in English and Chinese.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairProgress } from './pair'

const secure = vi.hoisted(() => ({ value: true }))
vi.stubGlobal('window', {
  kettu: { platform: 'darwin' },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  get isSecureContext() {
    return secure.value
  },
})

const { i18n } = await import('@renderer/lib/i18n')
const { PairingView } = await import('./pairing-page')

afterEach(async () => {
  secure.value = true
  await i18n.changeLanguage('en')
})

const text = (props: Partial<Parameters<typeof PairingView>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(PairingView, {
      notice: null,
      deviceName: 'Safari · iPhone',
      progress: null,
      added: false,
      link: '',
      invalid: false,
      onLink: () => {},
      onSubmit: () => {},
      ...props,
    }),
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')

describe('the pairing page', () => {
  it('says where to get a code, with a field for its link', () => {
    const body = text()
    expect(body).toContain('Use Kettu in this browser')
    expect(body).toContain('Settings › Remote access › Add device, choose Browser')
    expect(body).toContain('Pairing link')
    expect(body).toMatch(/ Pair $/)
    expect(body).not.toContain('not protected')
  })

  it('names a link that is not a pairing link', () => {
    expect(text({ link: 'https://example.com', invalid: true })).toContain(
      'This is not a Kettu pairing link.',
    )
  })

  it('waits for the owner to add the browser under its name', () => {
    expect(text({ progress: { state: 'connecting' } })).toContain('Connecting to the computer…')
    const waiting = text({ progress: { state: 'waiting' } })
    expect(waiting).toContain('Confirm on the computer')
    expect(waiting).toContain('asks whether to add “Safari · iPhone”')
    expect(waiting).not.toContain('Pairing link')
    expect(text({ added: true })).toContain('Added. Opening Kettu…')
  })

  it.each([
    ['void', 'This code no longer works'],
    ['rejected', 'did not add this browser'],
    ['unreachable', 'Could not reach the computer.'],
    ['update_client', 'This page is older than Kettu on the computer.'],
    ['update_host', 'Kettu on the computer is too old for this page.'],
  ] as const)('says why pairing failed: %s, and offers to try again', (reason, said) => {
    const progress: PairProgress = { state: 'failed', reason }
    const body = text({ progress, link: 'http://192.168.1.8:47821/pair#AQ' })
    expect(body).toContain(said)
    expect(body).toMatch(/ Try again $/)
  })

  it('says when the computer removed this browser, until pairing starts again', () => {
    expect(text({ notice: 'removed' })).toContain('This browser was removed from the computer.')
    expect(text({ notice: 'removed', progress: { state: 'connecting' } })).not.toContain('removed')
  })

  it('warns on a page opened over plain http', () => {
    secure.value = false
    expect(text()).toContain('This page is not protected on the network')
  })

  it('speaks Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    secure.value = false
    const body = text({ progress: { state: 'failed', reason: 'rejected' } })
    expect(body).toContain('在这个浏览器里用 Kettu')
    expect(body).toContain('电脑的主人没有添加这个浏览器。')
    expect(body).toContain('这个页面在网络上没有保护')
  })
})
