import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '@shared/agent-host'
import { HARNESS_CAPABILITY_IDS } from '@shared/harness-capabilities'
import enSettings from '@shared/locales/en/settings.json'
import zhSettings from '@shared/locales/zh-CN/settings.json'

let activeCatalog: typeof enSettings | typeof zhSettings = enSettings

vi.mock('@renderer/lib/platform', () => ({
  isWeb: false,
  isHosted: false,
  isMac: true,
  isWindows: false,
  platform: 'darwin',
  formatShortcut: (s: string) => s,
}))

vi.mock('@renderer/features/session/entries/helpers', () => ({
  PANEL: 'k-panel',
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => createElement('span', { 'data-testid': 'icon' }),
}))

vi.mock('@renderer/components/ui/collapsible', () => ({
  Collapsible: ({
    children,
    defaultOpen,
    ...rest
  }: {
    children?: ReactNode
    defaultOpen?: boolean
  }) =>
    createElement(
      'div',
      { 'data-testid': 'collapsible', 'data-default-open': String(Boolean(defaultOpen)), ...rest },
      children,
    ),
  CollapsibleTrigger: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('button', { type: 'button', className }, children),
  CollapsibleContent: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('div', { className }, children),
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const parts = key.split('.')
      let cur: unknown = activeCatalog
      for (const part of parts) {
        if (typeof cur !== 'object' || cur === null || !(part in cur)) return key
        cur = (cur as Record<string, unknown>)[part]
      }
      if (typeof cur !== 'string') return key
      if (!params) return cur
      return cur.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        Object.hasOwn(params, name) ? String(params[name]) : `{{${name}}}`,
      )
    },
  }),
}))

import { AgentCapabilitiesGroup } from './agent-capabilities'

function makeStatus(
  id: AgentStatus['id'],
  overrides: Partial<AgentStatus['capabilities']> = {},
): Pick<AgentStatus, 'id' | 'capabilities'> {
  return {
    id,
    capabilities: {
      loadSession: false,
      listSessions: false,
      resumeSession: false,
      closeSession: false,
      deleteSession: false,
      forkSession: false,
      forkAtMessage: false,
      steering: false,
      reports: false,
      context: false,
      liveContext: false,
      account: false,
      mcpHttp: null,
      prompt: null,
      ...overrides,
    },
  }
}

describe('AgentCapabilitiesGroup', () => {
  beforeEach(() => {
    activeCatalog = enSettings
  })

  it('renders all capabilities, all three statuses, and summary counts for Codex', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCapabilitiesGroup, { status: makeStatus('codex') }),
    )

    expect(html).toContain('Integration capabilities')
    expect(html).toContain('8 supported · 2 partial · 1 unavailable')
    expect(html).toContain('data-status="supported"')
    expect(html).toContain('data-status="partial"')
    expect(html).toContain('data-status="unavailable"')
    expect(html).toContain('Supported')
    expect(html).toContain('Partial')
    expect(html).toContain('Unavailable')

    // Verified upstream reasons and details are rendered.
    expect(html).toContain('data-reason="upstream"')
    expect(html).toContain('Upstream limit')
    expect(html).toContain('Paginated threads only; legacy rollout threads cannot revert')

    for (const id of HARNESS_CAPABILITY_IDS) {
      expect(html).toContain(`data-capability="${id}"`)
    }
  })

  it('distinguishes verified kettu gaps from upstream limits and omits unverified reasons', () => {
    const openCodeHtml = renderToStaticMarkup(
      createElement(AgentCapabilitiesGroup, { status: makeStatus('opencode') }),
    )
    expect(openCodeHtml).toContain('data-reason="kettu"')
    expect(openCodeHtml).toContain('Not yet in Kettu')
    expect(openCodeHtml).toContain(
      'Routine permission modes are mapped; workflow steps are not enabled yet',
    )

    // Claude Code's fileRewind is unavailable without a verified gapReason: no reason tag appears.
    const claudeHtml = renderToStaticMarkup(
      createElement(AgentCapabilitiesGroup, { status: makeStatus('claude-code~work') }),
    )
    expect(claudeHtml).toContain('10 supported · 0 partial · 1 unavailable')
    expect(claudeHtml).not.toContain('data-reason=')
    expect(claudeHtml).not.toContain('Upstream limit')
    expect(claudeHtml).not.toContain('Not yet in Kettu')
  })

  it('renders verified zh-CN copy for title, summary, statuses, reasons, and notes', () => {
    activeCatalog = zhSettings
    const html = renderToStaticMarkup(
      createElement(AgentCapabilitiesGroup, { status: makeStatus('cline') }),
    )

    expect(html).toContain('接入能力')
    expect(html).toContain('3 项支持 · 3 项部分支持 · 5 项不可用')
    expect(html).toContain('支持')
    expect(html).toContain('部分支持')
    expect(html).toContain('不可用')
    expect(html).toContain('上游限制')
    expect(html).toContain('Kettu 尚未接入')
    expect(html).toContain('仅在 Cline SDK 模式下可用（ACP 回退或已压缩会话不支持）')
  })

  it('refines runtime-negotiated ACP capabilities in the rendered checklist', () => {
    const html = renderToStaticMarkup(
      createElement(AgentCapabilitiesGroup, {
        status: makeStatus('cursor', {
          forkSession: true,
          forkAtMessage: false,
          mcpHttp: true,
          prompt: { image: true, audio: false, embeddedContext: false },
        }),
      }),
    )

    expect(html).toContain('data-capability="imageInput" data-status="supported"')
    expect(html).toContain('data-capability="mcp" data-status="supported"')
    expect(html).toContain('data-capability="fork" data-status="partial"')
    expect(html).toContain('Full-session fork only; ACP does not carry a message fork point')
  })
})
