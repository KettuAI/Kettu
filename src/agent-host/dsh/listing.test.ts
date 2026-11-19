// What Kettu reads from DeepSeek Harness's own list of its models, and how it keeps the process
// that lists them out of the user's dsh home.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  LISTING_MODEL,
  LISTING_PROVIDER,
  listedChoices,
  listedEfforts,
  listingRows,
} from './listing'

const value = (provider: string, model: string): string => JSON.stringify([provider, model])

const OPTIONS = [
  {
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: value(LISTING_PROVIDER, LISTING_MODEL),
    options: [
      {
        group: 'deepseek-official',
        name: 'DeepSeek',
        options: [
          { value: value(LISTING_PROVIDER, LISTING_MODEL), name: LISTING_MODEL },
          { value: value('deepseek-official', 'deepseek-flash'), name: 'DeepSeek-V4.1-Flash' },
        ],
      },
      {
        group: 'my-gateway',
        name: 'My Gateway',
        options: [
          { value: value('my-gateway', 'auto/fast'), name: 'Fast', description: 'quick' },
          { value: value('my-gateway', 'plain') },
        ],
      },
    ],
  },
  {
    id: 'reasoning_effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'off', name: 'Off' },
      { value: 'high', name: 'High', description: 'The default balance for most tasks.' },
    ],
  },
]

describe('dsh listing', () => {
  it('reads every route’s models in dsh’s order, with the value that selects each', () => {
    expect(listedChoices(OPTIONS)).toEqual([
      {
        value: value('deepseek-official', 'deepseek-flash'),
        model: {
          provider: 'deepseek-official',
          group: 'DeepSeek',
          model: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
        },
      },
      {
        value: value('my-gateway', 'auto/fast'),
        model: { provider: 'my-gateway', group: 'My Gateway', model: 'auto/fast', name: 'Fast' },
      },
      {
        value: value('my-gateway', 'plain'),
        model: { provider: 'my-gateway', group: 'My Gateway', model: 'plain', name: 'plain' },
      },
    ])
  })

  it('leaves out the model the listing process itself started on', () => {
    const only = [
      {
        id: 'model',
        options: [
          {
            group: 'deepseek-official',
            name: 'DeepSeek',
            options: [{ value: value(LISTING_PROVIDER, LISTING_MODEL), name: LISTING_MODEL }],
          },
        ],
      },
    ]
    expect(listedChoices(only)).toEqual([])
  })

  it('skips what it cannot read as a route and a model', () => {
    const odd = [
      {
        id: 'model',
        options: [
          { group: 'a', name: 'A', options: [{ value: 'plain-text' }, { value: '["only-one"]' }] },
          { group: 'b', name: 'B', options: 'none' },
          'nothing',
          { group: 'c', options: [{ value: value('c', 'model') }] },
        ],
      },
    ]
    expect(listedChoices(odd).map((choice) => choice.model)).toEqual([
      { provider: 'c', group: 'c', model: 'model', name: 'model' },
    ])
    expect(listedChoices(null)).toEqual([])
    expect(listedChoices([{ id: 'other' }])).toEqual([])
  })

  it('reads the selected model’s levels and the one dsh starts it on', () => {
    expect(listedEfforts(OPTIONS)).toEqual({
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
      ],
      effort: 'high',
    })
  })

  it('reads the level that leaves it to the provider, which dsh gives no id', () => {
    const options = [
      {
        id: 'reasoning_effort',
        currentValue: '',
        options: [
          { value: '', name: 'Provider default' },
          { value: 'high', name: 'High' },
        ],
      },
    ]
    expect(listedEfforts(options)).toEqual({
      efforts: [
        { id: '', name: 'Provider default' },
        { id: 'high', name: 'High' },
      ],
      effort: '',
    })
  })

  it('reads no levels for a model that has none', () => {
    expect(listedEfforts([OPTIONS[0]])).toEqual({ efforts: [], effort: null })
  })
})

describe('dsh listing process', () => {
  it('keeps its session in Kettu’s own folder and starts on a model no route has', () => {
    const folder = path.join('tmp', 'kettu "models"')
    const rows = parse(listingRows(folder)) as { id: string; config: Record<string, string> }[]
    expect(rows).toEqual([
      { id: 'acp', config: { provider: LISTING_PROVIDER, model: LISTING_MODEL } },
      { id: 'session-persistence-jsonl', config: { root: path.join(folder, 'sessions') } },
      { id: 'storage-json', config: { root: path.join(folder, 'storages') } },
    ])
  })
})
