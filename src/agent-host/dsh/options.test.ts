// The models and reasoning levels Kettu offers for a DeepSeek Harness session, and the route and
// model each stands for when its process starts.

import { describe, expect, it } from 'vitest'
import type { ListedModel } from './listing'
import {
  CONFIG,
  choiceOf,
  configOptions,
  listedModelChoices,
  modelChoices,
  startChoice,
} from './options'
import { NO_ROUTES, type Routes } from './routes'

const GATEWAY: Routes = {
  yaml: '',
  groups: [
    {
      provider: 'my-gateway',
      name: 'My Gateway',
      effort: 'high',
      models: [
        { id: 'auto/fast', name: 'Fast', efforts: ['off', 'high'] },
        { id: 'plain', name: 'plain', efforts: [] },
      ],
    },
  ],
  deepseek: null,
  selection: { provider: 'my-gateway', model: 'plain', effort: null },
}

const values = (routes: Routes, signedIn: Parameters<typeof modelChoices>[1]): string[] =>
  modelChoices(routes, signedIn).map((choice) => choice.value)

describe('dsh models', () => {
  it('offers DeepSeek’s own models under their bare ids, as sessions before stored them', () => {
    expect(values(NO_ROUTES, 'deepseek-official')).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(values(NO_ROUTES, null)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('offers every model of a configured route, after DeepSeek’s when it is signed in', () => {
    expect(values(GATEWAY, 'deepseek-account')).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'my-gateway/auto/fast',
      'my-gateway/plain',
    ])
  })

  it('leaves DeepSeek’s models out of a home that has another route and no DeepSeek sign-in', () => {
    expect(values(GATEWAY, null)).toEqual(['my-gateway/auto/fast', 'my-gateway/plain'])
  })

  it('takes the catalog a file gives the key route, which the account route does not follow', () => {
    const routes: Routes = {
      ...NO_ROUTES,
      deepseek: { effort: 'max', models: [{ id: 'mine', name: 'Mine', efforts: null }] },
    }
    expect(modelChoices(routes, 'deepseek-official')).toEqual([
      {
        value: 'mine',
        provider: null,
        model: 'mine',
        name: 'Mine',
        group: 'DeepSeek',
        efforts: ['off', 'low', 'high', 'max'],
        effort: 'max',
      },
    ])
    expect(values(routes, 'deepseek-account')).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('names the route and model a choice stands for', () => {
    const [fast, plain] = modelChoices(GATEWAY, null)
    expect(fast).toMatchObject({ provider: 'my-gateway', model: 'auto/fast' })
    expect(fast?.name).toBe('My Gateway/Fast')
    expect(plain).toMatchObject({ provider: 'my-gateway', model: 'plain', effort: null })
  })

  it('starts a model on its route’s level, and offers sending none', () => {
    const [fast] = modelChoices(GATEWAY, null)
    expect(fast).toMatchObject({ efforts: ['default', 'off', 'high'], effort: 'high' })
    const unset = modelChoices(
      { ...GATEWAY, groups: [{ ...GATEWAY.groups[0]!, effort: 'max' }] },
      null,
    )
    expect(unset[0]?.effort).toBe('default')
  })

  it('starts the model chosen in dsh’s own pages on the level saved with it', () => {
    const saved = (provider: string, model: string): Routes => ({
      ...GATEWAY,
      selection: { provider, model, effort: 'off' },
    })
    const levels = (routes: Routes) =>
      modelChoices(routes, 'deepseek-official').map((choice) => choice.effort)
    expect(levels(saved('my-gateway', 'auto/fast'))).toEqual(['high', 'high', 'off', null])
    expect(levels(saved('deepseek-official', 'deepseek-v4-pro'))).toEqual([
      'high',
      'off',
      'high',
      null,
    ])
    expect(levels(saved('my-gateway', 'plain'))).toEqual(['high', 'high', 'high', null])
  })

  it('starts a session on the model dsh’s own pages chose, else on the first', () => {
    const choices = modelChoices(GATEWAY, 'deepseek-official')
    expect(startChoice(choices, GATEWAY)?.value).toBe('my-gateway/plain')
    expect(startChoice(choices, NO_ROUTES)?.value).toBe('deepseek-flash')
    const gone = { ...GATEWAY, selection: { provider: 'removed', model: 'x', effort: null } }
    expect(startChoice(choices, gone)?.value).toBe('deepseek-flash')
  })

  it('reads either of DeepSeek’s routes in an event as its own models', () => {
    const choices = modelChoices(GATEWAY, 'deepseek-official')
    expect(choiceOf(choices, 'deepseek-account', 'deepseek-v4-pro')?.value).toBe('deepseek-v4-pro')
    expect(choiceOf(choices, 'my-gateway', 'auto/fast')?.value).toBe('my-gateway/auto/fast')
    expect(choiceOf(choices, 'other', 'auto/fast')).toBeUndefined()
  })
})

describe('dsh listed models', () => {
  const DEEPSEEK = [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  const LISTED: ListedModel[] = [
    {
      provider: 'deepseek-official',
      group: 'DeepSeek',
      model: 'deepseek-v5',
      name: 'DeepSeek-V5',
      efforts: DEEPSEEK,
      effort: 'high',
    },
    {
      provider: 'deepseek-account',
      group: 'DeepSeek Account',
      model: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      efforts: DEEPSEEK,
      effort: 'high',
    },
    {
      provider: 'openai',
      group: 'openai',
      model: 'gpt-x',
      name: 'GPT X',
      efforts: [
        { id: '', name: 'Provider default' },
        { id: 'ultra', name: 'Ultra' },
      ],
      effort: '',
    },
    {
      provider: 'my-gateway',
      group: 'My Gateway',
      model: 'plain',
      name: 'plain',
      efforts: [],
      effort: null,
    },
  ]

  it('offers every model dsh lists under dsh’s names, the signed-in DeepSeek route’s by bare id', () => {
    expect(
      listedModelChoices(LISTED, NO_ROUTES, 'deepseek-official').map((choice) => [
        choice.value,
        choice.provider,
        choice.name,
      ]),
    ).toEqual([
      ['deepseek-v5', 'deepseek-official', 'DeepSeek-V5'],
      [
        'deepseek-account/deepseek-flash',
        'deepseek-account',
        'DeepSeek Account/DeepSeek-V4.1-Flash',
      ],
      ['openai/gpt-x', 'openai', 'openai/GPT X'],
      ['my-gateway/plain', 'my-gateway', 'My Gateway/plain'],
    ])
    expect(
      listedModelChoices(LISTED, NO_ROUTES, 'deepseek-account').map((choice) => choice.value),
    ).toEqual([
      'deepseek-official/deepseek-v5',
      'deepseek-flash',
      'openai/gpt-x',
      'my-gateway/plain',
    ])
  })

  it('offers each model the levels dsh gives it, the provider’s own as Default', () => {
    const choices = listedModelChoices(LISTED, NO_ROUTES, 'deepseek-official')
    expect(choices.map((choice) => [choice.efforts, choice.effort])).toEqual([
      [['off', 'low', 'high', 'max'], 'high'],
      [['off', 'low', 'high', 'max'], 'high'],
      [['default', 'ultra'], 'default'],
      [[], null],
    ])
    const effort = configOptions(
      { model: 'openai/gpt-x', effort: 'ultra', preset: 'workspace-write', plan: false },
      choices,
    ).find((candidate) => candidate.id === CONFIG.effort)
    expect(effort?.choices).toEqual([
      { value: 'default', name: 'Default' },
      { value: 'ultra', name: 'Ultra' },
    ])
  })

  it('starts the model chosen in dsh’s own pages on the level saved with it', () => {
    const saved: Routes = {
      ...NO_ROUTES,
      selection: { provider: 'openai', model: 'gpt-x', effort: 'ultra' },
    }
    const choices = listedModelChoices(LISTED, saved, 'deepseek-official')
    expect(startChoice(choices, saved)).toMatchObject({ value: 'openai/gpt-x', effort: 'ultra' })
  })

  it('reads the route and model an event names as the choice that stands for them', () => {
    const choices = listedModelChoices(LISTED, NO_ROUTES, 'deepseek-official')
    expect(choiceOf(choices, 'deepseek-official', 'deepseek-v5')?.value).toBe('deepseek-v5')
    expect(choiceOf(choices, 'deepseek-account', 'deepseek-flash')?.value).toBe(
      'deepseek-account/deepseek-flash',
    )
    expect(choiceOf(choices, 'deepseek-account', 'deepseek-v5')).toBeUndefined()
  })
})

describe('dsh options', () => {
  const choices = modelChoices(GATEWAY, null)
  const option = (model: string, effort: string | null, id: string) =>
    configOptions({ model, effort, preset: 'workspace-write', plan: false }, choices).find(
      (candidate) => candidate.id === id,
    )

  it('offers a model’s own levels, and no level menu for a model without any', () => {
    expect(option('my-gateway/auto/fast', 'high', CONFIG.effort)).toMatchObject({
      value: 'high',
      choices: [{ value: 'default' }, { value: 'off' }, { value: 'high' }],
    })
    expect(option('my-gateway/plain', null, CONFIG.effort)).toBeUndefined()
  })

  it('gives each model its id, which usage is counted under', () => {
    expect(option('my-gateway/plain', null, CONFIG.model)?.choices).toEqual([
      { value: 'my-gateway/auto/fast', name: 'My Gateway/Fast', modelId: 'auto/fast' },
      { value: 'my-gateway/plain', name: 'My Gateway/plain', modelId: 'plain' },
    ])
  })
})
