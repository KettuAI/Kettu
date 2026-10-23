import { describe, expect, it } from 'vitest'
import { parseTitle } from './commit-title.mjs'

describe('parseTitle', () => {
  it('splits a header into type, scope, breaking and subject', () => {
    expect(parseTitle('fix(ui): close the model menu')).toEqual({
      type: 'fix',
      scope: 'ui',
      breaking: false,
      subject: 'close the model menu',
    })
    expect(parseTitle('feat!: drop node 22')).toEqual({
      type: 'feat',
      scope: undefined,
      breaking: true,
      subject: 'drop node 22',
    })
    expect(parseTitle('perf(thread)!: virtualize entries')).toMatchObject({
      scope: 'thread',
      breaking: true,
    })
  })

  it('reads squash commit subjects, with their pull request number', () => {
    expect(parseTitle('feat(usage): add the usage page (#12)')).toMatchObject({
      type: 'feat',
      subject: 'add the usage page (#12)',
    })
  })

  it('leaves judging the parts to the caller', () => {
    expect(parseTitle('Feature(Top Bar): Add it.')).toEqual({
      type: 'Feature',
      scope: 'Top Bar',
      breaking: false,
      subject: 'Add it.',
    })
    expect(parseTitle('fix:')).toMatchObject({ subject: '' })
    expect(parseTitle('fix: ')).toMatchObject({ subject: '' })
  })

  it('returns null without a header', () => {
    expect(parseTitle('Close the model menu')).toBeNull()
    expect(parseTitle('Revert "feat: add login"')).toBeNull()
    expect(parseTitle('fix:close the menu')).toBeNull()
    expect(parseTitle('fix (ui): close the menu')).toBeNull()
    expect(parseTitle('')).toBeNull()
  })
})
