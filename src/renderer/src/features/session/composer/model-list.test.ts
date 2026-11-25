import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { modelLists } from './model-list'

const CHOICES: NonNullable<ConfigOption['choices']> = [
  { value: 'default', name: 'Default (recommended)', shownAs: 'opus' },
  { value: 'opus', name: 'Opus 5.5' },
  { value: 'sonnet', name: 'Sonnet 5.5' },
  { value: 'haiku', name: 'Haiku 5.5' },
  { value: 'claude-fable-5-2', name: 'Fable 5.2' },
  { value: 'claude-opus-4-8', name: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
]

const values = (reads: readonly { value: string }[]) => reads.map((r) => r.value)

describe('the model menu’s main list', () => {
  it('picks the current generation when the user chose no favorites', () => {
    const lists = modelLists(CHOICES, 'opus')
    expect(values(lists.main)).toEqual(['claude-fable-5-2', 'opus', 'sonnet', 'haiku'])
    expect(values(lists.more)).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6'])
    expect(lists.extra).toBeNull()
  })

  it('lists only the favorites, in the user’s order, with every other model under More', () => {
    const lists = modelLists(CHOICES, 'sonnet', { pinned: ['sonnet', 'claude-opus-4-8'] })
    expect(values(lists.main)).toEqual(['sonnet', 'claude-opus-4-8'])
    expect(values(lists.more)).toEqual(['opus', 'haiku', 'claude-fable-5-2', 'claude-sonnet-4-6'])
    expect(lists.extra).toBeNull()
  })

  it('keeps the favorites’ order even against the families’ own', () => {
    const lists = modelLists(CHOICES, 'haiku', {
      pinned: ['haiku', 'claude-sonnet-4-6', 'claude-fable-5-2', 'opus'],
    })
    expect(values(lists.main)).toEqual(['haiku', 'claude-sonnet-4-6', 'claude-fable-5-2', 'opus'])
  })

  it('gives the chosen model a row of its own when it is no favorite', () => {
    const lists = modelLists(CHOICES, 'haiku', { pinned: ['sonnet'] })
    expect(values(lists.main)).toEqual(['sonnet'])
    expect(lists.extra?.value).toBe('haiku')
  })

  it('skips favorites the agent no longer offers, and picks again when none is left', () => {
    const some = modelLists(CHOICES, 'opus', { pinned: ['gone', 'haiku'] })
    expect(values(some.main)).toEqual(['haiku'])
    const none = modelLists(CHOICES, 'opus', { pinned: ['gone', 'default'] })
    expect(values(none.main)).toEqual(values(modelLists(CHOICES, 'opus').main))
  })

  it('leaves the recent models out once there are favorites', () => {
    const several: NonNullable<ConfigOption['choices']> = [
      { value: 'a/one', name: 'a/One' },
      { value: 'b/two', name: 'b/Two' },
      { value: 'c/three', name: 'c/Three' },
    ]
    const lists = modelLists(several, 'a/one', { pinned: ['c/three'], recent: ['b/two'] })
    expect(values(lists.main)).toEqual(['c/three'])
  })
})
