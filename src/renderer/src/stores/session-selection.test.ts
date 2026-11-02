import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSelection,
  selectionFor,
  selectRange,
  toggleSelected,
  useSessionSelection,
} from './session-selection'

const ids = () => useSessionSelection.getState().ids

describe('session selection', () => {
  beforeEach(clearSelection)

  it('adds and removes rows with Mod-click, leaving out the session in front', () => {
    toggleSelected('b')
    toggleSelected('c')
    expect(ids()).toEqual(['b', 'c'])
    toggleSelected('b')
    expect(ids()).toEqual(['c'])
  })

  it('picks a Shift-click range in sidebar order, from the last pick', () => {
    const order = ['a', 'b', 'c', 'd', 'e']
    selectRange('c', 'a', order)
    expect(ids()).toEqual(['a', 'b', 'c'])
    toggleSelected('e')
    selectRange('d', 'a', order)
    expect(ids()).toEqual(['d', 'e'])
  })

  it('acts on the selection only from a row inside it with two or more picked', () => {
    expect(selectionFor('a', ['a'])).toBeNull()
    expect(selectionFor('c', ['a', 'b'])).toBeNull()
    expect(selectionFor('a', ['a', 'b'])).toEqual(['a', 'b'])
  })
})
