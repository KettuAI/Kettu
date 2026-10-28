import { describe, expect, it } from 'vitest'
import { authorLabel } from './pr-author'

describe('authorLabel', () => {
  it('names a user by their profile name, with the login when it differs', () => {
    expect(authorLabel({ login: 'mirachen', name: 'Mira Chen', bot: false })).toEqual({
      name: 'Mira Chen',
      login: 'mirachen',
      initial: 'M',
    })
  })

  it('leaves the login out when the name says it, ignoring case', () => {
    expect(authorLabel({ login: 'amigoer', name: 'Amigoer', bot: false })).toEqual({
      name: 'Amigoer',
      login: null,
      initial: 'A',
    })
  })

  it('shows the login as the name without a profile name', () => {
    expect(authorLabel({ login: 'jweber', name: null, bot: false })).toEqual({
      name: 'jweber',
      login: null,
      initial: 'J',
    })
    expect(authorLabel({ login: 'jweber', name: '  ', bot: false }).name).toBe('jweber')
  })

  it("names a bot by its app's name", () => {
    expect(authorLabel({ login: 'overbench-builder[bot]', name: null, bot: true })).toEqual({
      name: 'overbench-builder',
      login: null,
      initial: 'O',
    })
  })

  it('takes a whole character as the initial', () => {
    expect(authorLabel({ login: 'wangxm', name: '王小明', bot: false }).initial).toBe('王')
    expect(authorLabel({ login: 'emoji', name: '\u{1F600} Smile', bot: false }).initial).toBe(
      '\u{1F600}',
    )
  })
})
