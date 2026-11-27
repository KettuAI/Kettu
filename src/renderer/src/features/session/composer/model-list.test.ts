import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import {
  familyGroups,
  matchesModel,
  modelLists,
  moreInOrder,
  searchModels,
  splitChoiceName,
} from './model-list'

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

describe('provider grouping for Pi and multi-provider model choices', () => {
  const PI_MULTI: NonNullable<ConfigOption['choices']> = [
    {
      value: 'provider1/gpt-6.3-sol',
      name: 'provider1/gpt-6.3-sol',
      modelId: 'gpt-6.3-sol',
      group: 'provider1',
    },
    {
      value: 'provider1/gpt-6.2-sol',
      name: 'provider1/gpt-6.2-sol',
      modelId: 'gpt-6.2-sol',
      group: 'provider1',
    },
    {
      value: 'provider1/gpt-6.1-sol',
      name: 'provider1/gpt-6.1-sol',
      modelId: 'gpt-6.1-sol',
      group: 'provider1',
    },
    {
      value: 'provider2/gpt-6.3-sol',
      name: 'provider2/gpt-6.3-sol',
      modelId: 'gpt-6.3-sol',
      group: 'provider2',
    },
    {
      value: 'provider2/gpt-6.2-sol',
      name: 'provider2/gpt-6.2-sol',
      modelId: 'gpt-6.2-sol',
      group: 'provider2',
    },
    {
      value: 'provider2/gpt-6.1-sol',
      name: 'provider2/gpt-6.1-sol',
      modelId: 'gpt-6.1-sol',
      group: 'provider2',
    },
  ]

  it('aggregates multi-provider Pi models under each provider while preserving model values', () => {
    const lists = modelLists(PI_MULTI, 'provider1/gpt-6.3-sol')
    expect(lists.several).toBe(true)
    expect(lists.chosen?.value).toBe('provider1/gpt-6.3-sol')
    expect(lists.chosen?.provider).toBe('provider1')
    expect(lists.chosen?.name).toBe('gpt-6.3-sol')

    const orderedMore = moreInOrder(lists.more)
    expect(orderedMore.map((read) => [read.provider, read.name, read.value])).toEqual([
      ['provider1', 'gpt-6.2-sol', 'provider1/gpt-6.2-sol'],
      ['provider1', 'gpt-6.1-sol', 'provider1/gpt-6.1-sol'],
      ['provider2', 'gpt-6.2-sol', 'provider2/gpt-6.2-sol'],
      ['provider2', 'gpt-6.1-sol', 'provider2/gpt-6.1-sol'],
    ])
  })

  it('keeps nested slashes in Pi model ids and display names inside their real provider group', () => {
    const choices: NonNullable<ConfigOption['choices']> = [
      {
        value: 'openrouter/openai/gpt-6.1-sol',
        name: 'openrouter/openai/gpt-6.1-sol',
        modelId: 'openai/gpt-6.1-sol',
        group: 'openrouter',
      },
      {
        value: 'openrouter/anthropic/claude-opus-4-8',
        name: 'openrouter/Claude 4.8 / Fast',
        modelId: 'anthropic/claude-opus-4-8',
        group: 'openrouter',
      },
      {
        value: 'anthropic/claude-sonnet-5-5',
        name: 'anthropic/Claude Sonnet 5.5',
        modelId: 'claude-sonnet-5-5',
        group: 'anthropic',
      },
    ]
    const lists = modelLists(choices, 'openrouter/openai/gpt-6.1-sol')
    expect(lists.several).toBe(true)
    expect(familyGroups(lists.all).map((group) => group.provider)).toEqual([
      'openrouter',
      'anthropic',
    ])
    expect(lists.all.map((read) => [read.provider, read.name])).toEqual([
      ['openrouter', 'openai/gpt-6.1-sol'],
      ['openrouter', 'Claude 4.8 / Fast'],
      ['anthropic', 'Claude Sonnet 5.5'],
    ])
  })

  it('treats single-provider Pi lists with nested slashes as one provider with no bogus split groups', () => {
    const single: NonNullable<ConfigOption['choices']> = [
      {
        value: 'openrouter/openai/gpt-6.1-sol',
        name: 'openrouter/openai/gpt-6.1-sol',
        modelId: 'openai/gpt-6.1-sol',
      },
      {
        value: 'openrouter/anthropic/claude-opus-4-8',
        name: 'openrouter/anthropic/claude-opus-4-8',
        modelId: 'anthropic/claude-opus-4-8',
      },
    ]
    const lists = modelLists(single, 'openrouter/openai/gpt-6.1-sol')
    expect(lists.several).toBe(false)
    expect(lists.all.map((read) => [read.provider, read.name])).toEqual([
      ['openrouter', 'openai/gpt-6.1-sol'],
      ['openrouter', 'anthropic/claude-opus-4-8'],
    ])
  })

  it('handles providerless models and preserves providerless display names', () => {
    const plain: NonNullable<ConfigOption['choices']> = [
      { value: 'gpt-6.2-sol', name: '6.2 Sol' },
      { value: 'gpt-6.1-sol', name: '6.1 Sol' },
    ]
    const lists = modelLists(plain, 'gpt-6.2-sol')
    expect(lists.several).toBe(false)
    expect(lists.all.map((read) => [read.provider, read.name])).toEqual([
      ['', '6.2 Sol'],
      ['', '6.1 Sol'],
    ])
    expect(
      splitChoiceName({ value: 'deepseek-v5', name: 'DeepSeek-V5', group: 'DeepSeek' }),
    ).toEqual(['', 'DeepSeek-V5'])
    expect(
      splitChoiceName({
        value: 'my-gateway/auto/fast',
        name: 'My Gateway/Fast',
        modelId: 'auto/fast',
      }),
    ).toEqual(['My Gateway/', 'Fast'])
  })

  it('filters grouped Pi models by provider, model name, or id and preserves provider grouping', () => {
    const lists = modelLists(PI_MULTI, 'provider1/gpt-6.3-sol')
    const byProvider = searchModels(lists.all, 'provider2')
    expect(byProvider.map((group) => [group.provider, values(group.items)])).toEqual([
      ['provider2', ['provider2/gpt-6.3-sol', 'provider2/gpt-6.2-sol', 'provider2/gpt-6.1-sol']],
    ])

    const byModel = searchModels(lists.all, 'gpt-6.1')
    expect(byModel.map((group) => [group.provider, values(group.items)])).toEqual([
      ['provider1', ['provider1/gpt-6.1-sol']],
      ['provider2', ['provider2/gpt-6.1-sol']],
    ])

    const chosen = lists.all.find((read) => read.value === 'provider2/gpt-6.1-sol')!
    expect(matchesModel(chosen, 'provider2 6.1')).toBe(true)
    expect(matchesModel(chosen, 'provider1 6.1')).toBe(false)
  })
})
