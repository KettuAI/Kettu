// The user's consents to what an artifact's pages may use: asked once per artifact and
// capability on the client showing it, outside the page, and remembered on the host until taken
// back in Settings › Artifacts. A "Don't allow" holds until the artifact is next opened.

import { randomBytes } from 'node:crypto'
import type { HostEvent } from '@shared/agent-host'
import {
  isConsentCapability,
  type ArtifactConsentRow,
  type ConsentCapability,
} from '@shared/artifact-capabilities'
import { HostError } from '../../errors'
import type { ArtifactStore } from '../store'
import type { DeclaredArtifact } from './calls'
import { DESKTOP_CLIENT, type ConsentOutcome } from './dispatcher'

export interface ConsentDeps {
  store: Pick<ArtifactStore, 'runtime' | 'watchers'>
  /** Whether a port serves a paired device rather than one of the host's windows. */
  isDevice(portId: string): boolean
  send(portIds: readonly string[], event: HostEvent): void
  broadcast(event: HostEvent): void
  /** The agent `sample` asks for the artifacts of `project`, by name; null when none can. */
  agentName(project: string): Promise<string | null>
  now?: () => number
}

interface Pending {
  requestId: string
  artifactId: string
  capability: ConsentCapability
  client: string
  ports: Set<string>
  waiters: Set<(outcome: ConsentOutcome) => void>
}

export class ArtifactConsents {
  private readonly pending = new Map<string, Pending>()
  /** Each artifact's refusals, by capability and client, until it is opened again. */
  private readonly denied = new Map<string, Set<string>>()

  constructor(private readonly deps: ConsentDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  async allowed(artifactId: string, capability: string): Promise<boolean> {
    const granted = await this.deps.store.runtime('consentOf', { id: artifactId })
    return granted.includes(capability)
  }

  /** The ports of `client` showing the artifact, which a question goes to. */
  private portsOf(artifactId: string, client: string): string[] {
    const watching = this.deps.store.watchers(artifactId)
    return client === DESKTOP_CLIENT
      ? watching.filter((portId) => !this.deps.isDevice(portId))
      : watching.filter((portId) => portId === client)
  }

  /** Asks the client's user, or joins the question already open; `waiting` after `waitMs`. */
  async ask(
    artifact: DeclaredArtifact,
    capability: string,
    client: string,
    waitMs: number,
  ): Promise<ConsentOutcome> {
    if (!isConsentCapability(capability)) return 'denied'
    if (this.denied.get(artifact.id)?.has(`${capability}\0${client}`)) return 'denied'
    let pending = [...this.pending.values()].find(
      (p) => p.artifactId === artifact.id && p.capability === capability && p.client === client,
    )
    if (!pending) {
      const ports = this.portsOf(artifact.id, client)
      // No window shows it, as for a thumbnail: nobody can answer.
      if (ports.length === 0) return 'denied'
      const agent = capability === 'sample' ? await this.deps.agentName(artifact.project) : null
      pending = {
        requestId: randomBytes(16).toString('base64url'),
        artifactId: artifact.id,
        capability,
        client,
        ports: new Set(ports),
        waiters: new Set(),
      }
      this.pending.set(pending.requestId, pending)
      this.deps.send(ports, {
        type: 'artifacts.consentAsked',
        ask: {
          requestId: pending.requestId,
          artifactId: artifact.id,
          title: artifact.title,
          project: artifact.project,
          capability,
          agent,
        },
      })
    }
    const open = pending
    return new Promise<ConsentOutcome>((resolve) => {
      const timer = setTimeout(() => {
        open.waiters.delete(settle)
        resolve('waiting')
      }, waitMs)
      const settle = (outcome: ConsentOutcome): void => {
        clearTimeout(timer)
        resolve(outcome)
      }
      open.waiters.add(settle)
    })
  }

  /** A port's answer to a question it was asked; the first answer settles it everywhere. */
  async answer(requestId: string, allow: boolean, portId: string): Promise<void> {
    const pending = this.pending.get(requestId)
    if (!pending || !pending.ports.has(portId)) {
      throw new HostError('not_found', 'No such question is open for this port')
    }
    this.pending.delete(requestId)
    let outcome: ConsentOutcome = 'denied'
    try {
      if (allow) {
        await this.deps.store.runtime('consentGrant', {
          id: pending.artifactId,
          capability: pending.capability,
          at: this.now(),
        })
        outcome = 'allowed'
        this.deps.broadcast({ type: 'artifacts.consentsChanged' })
      } else {
        let refused = this.denied.get(pending.artifactId)
        if (!refused) this.denied.set(pending.artifactId, (refused = new Set()))
        refused.add(`${pending.capability}\0${pending.client}`)
      }
    } finally {
      this.settle(pending, outcome)
    }
  }

  private settle(pending: Pending, outcome: ConsentOutcome): void {
    this.pending.delete(pending.requestId)
    // A page that stopped waiting loads again to use what it may now.
    const reload = outcome === 'allowed' && pending.waiters.size === 0
    for (const settle of pending.waiters) settle(outcome)
    pending.waiters.clear()
    this.deps.send([...pending.ports], {
      type: 'artifacts.consentSettled',
      requestId: pending.requestId,
      artifactId: pending.artifactId,
      reload,
    })
  }

  /** Nothing shows the artifact now: its open questions end, and its refusals with them. */
  unwatched(artifactId: string): void {
    this.denied.delete(artifactId)
    for (const pending of [...this.pending.values()]) {
      if (pending.artifactId === artifactId) this.settle(pending, 'denied')
    }
  }

  portClosed(portId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (!pending.ports.delete(portId)) continue
      if (pending.ports.size === 0) this.settle(pending, 'denied')
    }
  }

  async list(): Promise<ArtifactConsentRow[]> {
    const rows = await this.deps.store.runtime('consents', undefined)
    return Promise.all(
      rows.map(async (row) => {
        const capabilities = row.capabilities.filter(isConsentCapability)
        return {
          artifactId: row.id,
          title: row.title,
          project: row.project,
          capabilities,
          agent: capabilities.includes('sample') ? await this.deps.agentName(row.project) : null,
        }
      }),
    )
  }

  async revoke(artifactId: string): Promise<void> {
    const { changed } = await this.deps.store.runtime('consentRevoke', { id: artifactId })
    if (changed) this.deps.broadcast({ type: 'artifacts.consentsChanged' })
  }
}
