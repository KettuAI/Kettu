import { describe, expect, it } from 'vitest'
import { commentsMessage } from './reply-quote'

describe('commentsMessage', () => {
  it('quotes each passage before its comment, in the order given, then the text', () => {
    const message = commentsMessage(
      [
        { passage: 'CI is running', comment: 'Post the result' },
        { passage: 'I kept main', comment: 'Why not the branch?' },
      ],
      'Looks good overall.',
    )
    expect(message).toBe(
      '> CI is running\n\nPost the result\n\n> I kept main\n\nWhy not the branch?\n\nLooks good overall.',
    )
  })

  it('ends with the last comment when there is no text', () => {
    expect(commentsMessage([{ passage: 'A', comment: 'B' }], '  \n')).toBe('> A\n\nB')
  })

  it('keeps a passage of several lines in one quote block', () => {
    const message = commentsMessage(
      [{ passage: 'first\r\nsecond\n\n\n\nthird', comment: 'ok' }],
      '',
    )
    expect(message).toBe('> first\n> second\n>\n> third\n\nok')
  })

  it('escapes a passage line that starts with ">", so it stays one quote level', () => {
    const message = commentsMessage([{ passage: '> nested\n  >also\na > b', comment: 'c' }], '')
    expect(message).toBe('> \\> nested\n>   \\>also\n> a > b\n\nc')
  })

  it('returns the text alone without comments', () => {
    expect(commentsMessage([], 'just this')).toBe('just this')
  })
})
