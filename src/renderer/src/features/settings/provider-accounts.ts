// What the provider accounts in Settings > Agents say and offer, without the drawing.

import type { AgentProvider, AgentProviderAction } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'

/** An account as OpenCode reports it. */
export type ProviderAccount = AgentProvider['accounts'][number]

/** The providers with at least one account saved, which the page lists by default. */
export function connectedProviders(providers: readonly AgentProvider[]): AgentProvider[] {
  return providers.filter((provider) => provider.accounts.length > 0)
}

/** The providers a search names, by name, id, method or account label. */
export function filterProviders(
  providers: readonly AgentProvider[],
  query: string,
): AgentProvider[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return [...providers]
  return providers.filter((provider) => {
    const text = [
      provider.name,
      provider.id,
      ...provider.methods.map((method) => `${method.type} ${method.label}`),
      ...provider.accounts.map((account) => account.label),
    ]
      .join(' ')
      .toLowerCase()
    return text.includes(wanted)
  })
}

/**
 * The account the provider uses, when the host marks one. A host that marks none leaves every
 * account switchable rather than guessing which is current.
 */
export function activeProviderAccount(provider: AgentProvider): ProviderAccount | null {
  return provider.accounts.find((account) => account.active === true) ?? null
}

/** Adding a key makes a new credential; the action takes no credential id. */
export function providerKeyAction(input: {
  agentId: AgentId
  providerId: string
  key: string
}): AgentProviderAction {
  return {
    agentId: input.agentId,
    providerId: input.providerId,
    action: 'set-key',
    key: input.key,
  }
}
