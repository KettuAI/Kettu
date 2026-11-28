import { describe, expect, it } from 'vitest'
import { RUNTIME_VERSION } from '../artifact-capabilities'
import { MAX_MULTI_SELECT, parseSelectMessage } from './page-messages'

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

  it('reads an optional viewport bounding box on a pick and ignores malformed ones', () => {
    const withBox = {
      path: 'index.html',
      src: 12,
      tag: 'div',
      text: 'Card',
      textOnly: false,
      style: {},
      box: { x: 40, y: -20, width: 320, height: 180 },
    }
    expect(parseSelectMessage(keyMessage({ selection: withBox }))?.selection?.box).toEqual({
      x: 40,
      y: -20,
      width: 320,
      height: 180,
    })

    const badBox = { ...withBox, box: { x: 0, y: 0, width: -10, height: 20 } }
    expect(parseSelectMessage(keyMessage({ selection: badBox }))?.selection?.box).toBeUndefined()
  })
})

describe('pin bounding box and live anchor bounds', () => {
  it('reads an optional pinBox alongside a pin pick and rejects stray or invalid pinBox', () => {
    const parsed = parseSelectMessage(
      keyMessage({ pin: 2, pinBox: { x: 100, y: 80, width: 240, height: 90 } }),
    )
    expect(parsed?.pin).toBe(2)
    expect(parsed?.pinBox).toEqual({ x: 100, y: 80, width: 240, height: 90 })

    expect(
      parseSelectMessage(keyMessage({ pinBox: { x: 0, y: 0, width: 10, height: 10 } })),
    ).toBeNull()
    expect(
      parseSelectMessage(keyMessage({ pin: 2, pinBox: { x: 0, y: 0, width: -1, height: 10 } })),
    ).toBeNull()
  })

  it('reads live anchor rect updates including offscreen negative coordinates and null box', () => {
    expect(
      parseSelectMessage(
        keyMessage({
          anchor: {
            box: { x: 24, y: -420, width: 300, height: 200 },
            viewport: { width: 1024, height: 768 },
          },
        }),
      )?.anchor,
    ).toEqual({
      box: { x: 24, y: -420, width: 300, height: 200 },
      viewport: { width: 1024, height: 768 },
    })

    expect(
      parseSelectMessage(
        keyMessage({
          anchor: { box: null, viewport: { width: 800, height: 600 } },
        }),
      )?.anchor,
    ).toEqual({
      box: null,
      viewport: { width: 800, height: 600 },
    })
  })

  it('rejects malformed or mixed anchor messages', () => {
    expect(
      parseSelectMessage(
        keyMessage({
          anchor: {
            box: { x: 0, y: 0, width: 10, height: 10 },
            viewport: { width: -1, height: 600 },
          },
        }),
      ),
    ).toBeNull()
    expect(
      parseSelectMessage(
        keyMessage({
          pin: 1,
          anchor: { box: null, viewport: { width: 800, height: 600 } },
        }),
      ),
    ).toBeNull()
    expect(
      parseSelectMessage(
        keyMessage({
          key: 'Escape',
          anchor: { box: null, viewport: { width: 800, height: 600 } },
        }),
      ),
    ).toBeNull()
  })
})

describe('multi-element marquee selections', () => {
  const sampleItem = (src: number | null, tag = 'article', text = 'Card') => ({
    path: 'index.html',
    src,
    tag,
    text,
    textOnly: false,
    style: {},
    box: { x: 20, y: 40, width: 200, height: 100 },
  })

  it('parses a valid selections array including script-created elements with null src', () => {
    const parsed = parseSelectMessage(
      keyMessage({
        selections: [sampleItem(10, 'article', 'Card 1'), sampleItem(null, 'button', 'Action')],
      }),
    )
    expect(parsed?.selection).toBeNull()
    expect(parsed?.selections).toHaveLength(2)
    expect(parsed?.selections?.[0]).toMatchObject({
      src: 10,
      tag: 'article',
      text: 'Card 1',
      box: { x: 20, y: 40, width: 200, height: 100 },
    })
    expect(parsed?.selections?.[1]).toMatchObject({ src: null, tag: 'button', text: 'Action' })
  })

  it('rejects empty, oversized, malformed, or mixed selections messages', () => {
    expect(parseSelectMessage(keyMessage({ selections: [] }))).toBeNull()
    expect(
      parseSelectMessage(
        keyMessage({
          selections: Array.from({ length: MAX_MULTI_SELECT + 1 }, (_, i) => sampleItem(i)),
        }),
      ),
    ).toBeNull()
    expect(parseSelectMessage(keyMessage({ selections: [null] }))).toBeNull()
    expect(
      parseSelectMessage(keyMessage({ selection: sampleItem(1), selections: [sampleItem(2)] })),
    ).toBeNull()
    expect(parseSelectMessage(keyMessage({ selections: [sampleItem(1)], pin: 1 }))).toBeNull()
    expect(
      parseSelectMessage(
        keyMessage({
          selections: [sampleItem(1)],
          anchor: { box: null, viewport: { width: 800, height: 600 } },
        }),
      ),
    ).toBeNull()
  })
})
