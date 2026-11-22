import { describe, expect, it } from 'vitest'
import { RUNTIME_VERSION } from '../artifact-capabilities'
import { parseSelectMessage } from './page-messages'

const keyMessage = (extra: Record<string, unknown>) => ({
  v: RUNTIME_VERSION,
  id: 'k1',
  kind: 'select',
  channel: 'channel-0001',
  selection: null,
  ...extra,
})

describe('a key a page passes on', () => {
  it('reads one of the keys the viewer steps with', () => {
    expect(parseSelectMessage(keyMessage({ key: 'ArrowRight' }))?.key).toBe('ArrowRight')
    expect(parseSelectMessage(keyMessage({ key: 'g' }))?.key).toBe('g')
  })

  it('drops any other key', () => {
    expect(parseSelectMessage(keyMessage({ key: 'Enter' }))).toBeNull()
    expect(parseSelectMessage(keyMessage({ key: 'G' }))).toBeNull()
    expect(parseSelectMessage(keyMessage({ key: 1 }))).toBeNull()
  })

  it('never comes with a pick or a located element', () => {
    const picked = {
      path: 'index.html',
      src: 0,
      tag: 'div',
      text: '',
      textOnly: false,
      style: {},
    }
    expect(parseSelectMessage(keyMessage({ key: 'Escape', selection: picked }))).toBeNull()
    expect(
      parseSelectMessage(keyMessage({ key: 'Escape', located: { src: 0, box: null } })),
    ).toBeNull()
  })

  it('leaves a message without a key as it was', () => {
    expect(parseSelectMessage(keyMessage({}))).not.toHaveProperty('key')
  })
})
