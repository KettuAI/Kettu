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

describe('a pin a pick landed on', () => {
  it('reads the pin by its number', () => {
    expect(parseSelectMessage(keyMessage({ pin: 3 }))?.pin).toBe(3)
  })

  it('drops a pin that is no number or comes with a pick', () => {
    expect(parseSelectMessage(keyMessage({ pin: 0 }))).toBeNull()
    expect(parseSelectMessage(keyMessage({ pin: '3' }))).toBeNull()
    expect(parseSelectMessage(keyMessage({ pin: 2, key: 'g' }))).toBeNull()
  })
})

describe('text typed in place', () => {
  it('reads the text and whether typing ended', () => {
    expect(parseSelectMessage(keyMessage({ typed: { text: 'Hi', done: true } }))?.typed).toEqual({
      text: 'Hi',
      done: true,
    })
  })

  it('drops text that is too long or malformed', () => {
    expect(
      parseSelectMessage(keyMessage({ typed: { text: 'x'.repeat(10_001), done: false } })),
    ).toBeNull()
    expect(parseSelectMessage(keyMessage({ typed: { text: 1, done: false } }))).toBeNull()
    expect(parseSelectMessage(keyMessage({ typed: 'Hi' }))).toBeNull()
  })
})

describe('the ancestors of a pick', () => {
  it('keeps only tag names', () => {
    const picked = {
      path: 'index.html',
      src: 0,
      tag: 'h1',
      text: '',
      textOnly: true,
      style: {},
      ancestors: ['main', 'Bad Tag', 'header'],
    }
    expect(parseSelectMessage(keyMessage({ selection: picked }))?.selection?.ancestors).toEqual([
      'main',
      'header',
    ])
  })
})
