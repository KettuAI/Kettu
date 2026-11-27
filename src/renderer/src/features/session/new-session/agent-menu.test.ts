import { createContext, createElement, useContext, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { menuGroups, type MenuAgent } from './start-options'

const GroupItemsContext = createContext<string[]>([])

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => createElement('span', { 'data-mark': 'agent' }),
}))

vi.mock('@renderer/components/agents/agent-mark-host', () => ({
  AgentMarkHost: {
    Provider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  },
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
    createElement('div', null, render, children),
  TooltipContent: () => null,
}))

vi.mock('@renderer/components/ui/combobox', () => ({
  Combobox: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ComboboxTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('button', null, children),
  ComboboxContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ComboboxInput: () => null,
  ComboboxList: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ComboboxGroup: ({ items, children }: { items?: string[]; children?: ReactNode }) =>
    createElement(
      GroupItemsContext.Provider,
      { value: items ?? [] },
      createElement('div', { 'data-group': '' }, children),
    ),
  ComboboxLabel: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-label': '' }, children),
  ComboboxCollection: ({ children }: { children: (item: string, index: number) => ReactNode }) => {
    const items = useContext(GroupItemsContext)
    return createElement('div', { 'data-collection': '' }, items.map(children))
  },
  ComboboxItem: ({ value, children }: { value?: string; children?: ReactNode }) =>
    createElement('div', { 'data-item': value }, children),
  ComboboxSeparator: () => null,
  useComboboxFilter: () => ({
    contains: (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase()),
  }),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => null,
}))

vi.mock('@renderer/lib/platform', () => ({
  formatShortcut: (shortcut: string) => shortcut,
  isMac: true,
  isWeb: false,
  isWindows: false,
  platform: 'darwin',
  menuCollisionPadding: 8,
}))

vi.mock('@renderer/stores/agents', () => ({
  agentName: (id: string) => id,
  agentsOn: () => ({ order: [], byId: {} }),
  usableAgents: () => [],
  useAgentsStore: () => ({}),
  usePlanReadings: () => ({}),
}))

const PI_MULTI_MODEL: ConfigOption = {
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
}

const PI_SINGLE_MODEL: ConfigOption = {
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
}

const contains = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase())

describe('AgentMenu ModelGroup provider headings', () => {
  it('renders provider headings for expanded More models of multi-provider Pi sessions', async () => {
    const { ModelGroup } = await import('./agent-menu')
    const agent: MenuAgent = {
      agentId: 'pi',
      name: 'Pi',
      model: PI_MULTI_MODEL,
      choosable: true,
    }
    const [group] = menuGroups([agent], 'pi', '', contains, 'pi')
    const html = renderToStaticMarkup(
      createElement(ModelGroup, { group: group!, agent, searching: false, expanded: true }),
    )

    // Both provider group headings appear once in order under More models.
    const headingMatches = [...html.matchAll(/data-provider-group="([^"]+)"/g)].map((m) => m[1])
    expect(headingMatches).toEqual(['provider1', 'provider2'])

    // Expanded rows sit under their provider heading without repeating the `provider/` prefix,
    // while keeping the exact `pi\0provider/id` item value.
    const provider1Pos = html.indexOf('data-provider-group="provider1"')
    const provider2Pos = html.indexOf('data-provider-group="provider2"')
    expect(provider1Pos).toBeGreaterThan(-1)
    expect(provider2Pos).toBeGreaterThan(provider1Pos)
    const provider1Section = html.slice(provider1Pos, provider2Pos)
    const provider2Section = html.slice(provider2Pos)
    expect(provider1Section).toContain('gpt-6.2-sol')
    expect(provider1Section).toContain('gpt-6.1-sol')
    expect(provider1Section).not.toContain('provider1/</span>')
    expect(provider2Section).toContain('gpt-6.2-sol')
    expect(provider2Section).toContain('gpt-6.1-sol')
    expect(provider2Section).not.toContain('provider2/</span>')
  })

  it('omits provider headings for single-provider Pi sessions and keeps nested model names intact', async () => {
    const { ModelGroup } = await import('./agent-menu')
    const agent: MenuAgent = {
      agentId: 'pi',
      name: 'Pi',
      model: PI_SINGLE_MODEL,
      choosable: true,
    }
    const [group] = menuGroups([agent], 'pi', '', contains, 'pi')
    const html = renderToStaticMarkup(
      createElement(ModelGroup, { group: group!, agent, searching: false, expanded: true }),
    )

    expect(html).not.toContain('data-provider-group=')
    expect(html).toContain('openai/gpt-6.2-sol')
    expect(html).toContain('anthropic/claude-opus-4-8')
  })
})
