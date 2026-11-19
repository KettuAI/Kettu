// The models and reasoning levels Kettu offers for a DeepSeek Harness session, and the route and
// model each stands for when its process starts.

import { describe, expect, it } from 'vitest'
import { CONFIG, choiceOf, configOptions, modelChoices, startChoice } from './options'
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
