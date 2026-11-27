import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import type { ModelPickerProps } from '@renderer/components/affect/model-picker'

let capturedPickerProps: ModelPickerProps | null = null
let mockPinned: string[] | undefined = undefined

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/components/affect/model-picker', () => ({
  ModelPicker: (props: ModelPickerProps) => {
    capturedPickerProps = props
    return createElement('div', { 'data-testid': 'model-picker', 'data-value': props.value })
  },
}))

vi.mock('@renderer/components/affect/gradient-floor', () => ({
  GradientFloor: () => null,
}))

vi.mock('@renderer/components/affect/shimmer-loader', () => ({
  ShimmerText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => createElement('span', { 'data-mark': 'agent' }),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => null,
}))

vi.mock('@renderer/features/settings/host-sections', () => ({
  FAVORITE_MODELS_ROW: 'favorites',
  openHostSettingsRow: vi.fn(),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => null,
}))

vi.mock('@renderer/lib/platform', () => ({
  formatShortcut: (shortcut: string) => shortcut,
  isMac: true,
}))

vi.mock('@renderer/stores/agent-options', () => ({
  optionsOn: () => ({ pi: { pinned: mockPinned } }),
  useAgentOptionsStore: <T>(selector: (state: unknown) => T) =>
    selector({ local: { pi: { pinned: mockPinned } } }),
}))

vi.mock('@renderer/stores/overlays', () => ({
  useOverlayPresence: () => undefined,
}))

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: <T>(
    selector: (state: { settings: { appearance: { effortControl: string } } }) => T,
  ) => selector({ settings: { appearance: { effortControl: 'segments' } } }),
}))

const PI_MULTI_CONFIG: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: 'provider1/gpt-6.3-sol',
    choices: [
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
    ],
  },
]

const PI_SINGLE_NESTED_CONFIG: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: 'openrouter/openai/gpt-6.3-sol',
    choices: [
      {
        value: 'openrouter/openai/gpt-6.3-sol',
        name: 'openrouter/openai/gpt-6.3-sol',
        modelId: 'openai/gpt-6.3-sol',
      },
      {
        value: 'openrouter/openai/gpt-6.2-sol',
        name: 'openrouter/openai/gpt-6.2-sol',
        modelId: 'openai/gpt-6.2-sol',
      },
      {
        value: 'openrouter/anthropic/claude-opus-4-8',
        name: 'openrouter/anthropic/claude-opus-4-8',
        modelId: 'anthropic/claude-opus-4-8',
      },
      {
        value: 'openrouter/anthropic/claude-sonnet-5-5',
        name: 'openrouter/anthropic/claude-sonnet-5-5',
        modelId: 'anthropic/claude-sonnet-5-5',
      },
      {
        value: 'openrouter/google/gemini-2.5-pro',
        name: 'openrouter/google/gemini-2.5-pro',
        modelId: 'google/gemini-2.5-pro',
      },
    ],
  },
]

const CODEX_SINGLE_CONFIG: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: 'gpt-6.3-sol',
    choices: [
      { value: 'gpt-6.3-sol', name: '6.3 Sol' },
      { value: 'gpt-6.2-sol', name: '6.2 Sol', older: true },
      { value: 'gpt-6.1-sol', name: '6.1 Sol', older: true },
      { value: 'gpt-6-luna', name: '6 Luna' },
      { value: 'gpt-5.6-luna', name: '5.6 Luna', older: true },
    ],
  },
]

beforeEach(() => {
  capturedPickerProps = null
  mockPinned = undefined
})

describe('ModelMenu provider grouping for Pi and Codex', () => {
  it('passes provider-grouped More models, provider descriptions on main rows, and exact values for multi-provider Pi', async () => {
    const { ModelMenu } = await import('./model-menu')
    const onSelect = vi.fn().mockResolvedValue(true)

    renderToStaticMarkup(
      createElement(ModelMenu, {
        agentId: 'pi',
        hostId: null,
        harness: 'Pi',
        config: PI_MULTI_CONFIG,
        onSelect,
        source: 'Pi 1.5.2',
      }),
    )

    expect(capturedPickerProps).not.toBeNull()
    expect(capturedPickerProps!.value).toBe('provider1/gpt-6.3-sol')
    expect(
      capturedPickerProps!.models.map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
      })),
    ).toEqual([
      { id: 'provider1/gpt-6.3-sol', name: 'gpt-6.3-sol', description: 'provider1' },
      { id: 'provider2/gpt-6.3-sol', name: 'gpt-6.3-sol', description: 'provider2' },
    ])
    expect(
      capturedPickerProps!.more!.map((model) => ({
        id: model.id,
        name: model.name,
        group: model.group,
      })),
    ).toEqual([
      { id: 'provider1/gpt-6.2-sol', name: 'gpt-6.2-sol', group: 'provider1' },
      { id: 'provider1/gpt-6.1-sol', name: 'gpt-6.1-sol', group: 'provider1' },
      { id: 'provider2/gpt-6.2-sol', name: 'gpt-6.2-sol', group: 'provider2' },
      { id: 'provider2/gpt-6.1-sol', name: 'gpt-6.1-sol', group: 'provider2' },
    ])

    // Search matches by provider name or model name while preserving provider group metadata.
    const filter = capturedPickerProps!.moreFilter!
    const byProvider = capturedPickerProps!.more!.filter((model) => filter(model, 'provider2'))
    expect(byProvider.map((model) => [model.group, model.id])).toEqual([
      ['provider2', 'provider2/gpt-6.2-sol'],
      ['provider2', 'provider2/gpt-6.1-sol'],
    ])
    const byModel = capturedPickerProps!.more!.filter((model) => filter(model, 'gpt-6.1'))
    expect(byModel.map((model) => [model.group, model.id])).toEqual([
      ['provider1', 'provider1/gpt-6.1-sol'],
      ['provider2', 'provider2/gpt-6.1-sol'],
    ])

    // Picking a model sends the exact `provider/id` value back unchanged.
    capturedPickerProps!.onChange!('provider2/gpt-6.1-sol')
    expect(onSelect).toHaveBeenCalledWith('model', 'provider2/gpt-6.1-sol')
  })

  it('omits group headers for single-provider Pi (even with nested slashes) and for providerless Codex models', async () => {
    const { ModelMenu } = await import('./model-menu')
    const onSelect = vi.fn().mockResolvedValue(true)

    renderToStaticMarkup(
      createElement(ModelMenu, {
        agentId: 'pi',
        hostId: null,
        harness: 'Pi',
        config: PI_SINGLE_NESTED_CONFIG,
        onSelect,
        source: 'Pi 1.5.2',
      }),
    )

    expect(capturedPickerProps!.models.every((model) => model.description === undefined)).toBe(true)
    expect(capturedPickerProps!.more!.every((model) => model.group === undefined)).toBe(true)
    expect(capturedPickerProps!.more!.map((model) => [model.id, model.name])).toEqual([
      ['openrouter/openai/gpt-6.2-sol', 'openai/gpt-6.2-sol'],
    ])

    capturedPickerProps = null
    renderToStaticMarkup(
      createElement(ModelMenu, {
        agentId: 'codex',
        hostId: null,
        harness: 'Codex',
        config: CODEX_SINGLE_CONFIG,
        onSelect,
        source: 'Codex 0.166.0',
      }),
    )
    expect(capturedPickerProps!.more!.every((model) => model.group === undefined)).toBe(true)
    expect(capturedPickerProps!.more!.map((model) => model.id)).toEqual([
      'gpt-6.2-sol',
      'gpt-6.1-sol',
      'gpt-5.6-luna',
    ])
  })

  it('preserves selected model echo when the active Pi model is outside the pinned favorites', async () => {
    const { ModelMenu } = await import('./model-menu')
    mockPinned = ['provider1/gpt-6.3-sol']

    renderToStaticMarkup(
      createElement(ModelMenu, {
        agentId: 'pi',
        hostId: null,
        harness: 'Pi',
        config: [{ ...PI_MULTI_CONFIG[0]!, value: 'provider2/gpt-6.1-sol' }],
        onSelect: vi.fn().mockResolvedValue(true),
        source: 'Pi 1.5.2',
      }),
    )

    expect(capturedPickerProps!.value).toBe('provider2/gpt-6.1-sol')
    expect(capturedPickerProps!.models.map((model) => [model.id, model.description])).toEqual([
      ['provider1/gpt-6.3-sol', 'provider1'],
      ['provider2/gpt-6.1-sol', 'provider2'],
    ])
    expect(capturedPickerProps!.more!.map((model) => [model.group, model.id])).toEqual([
      ['provider1', 'provider1/gpt-6.2-sol'],
      ['provider1', 'provider1/gpt-6.1-sol'],
      ['provider2', 'provider2/gpt-6.3-sol'],
      ['provider2', 'provider2/gpt-6.2-sol'],
    ])
  })
})
