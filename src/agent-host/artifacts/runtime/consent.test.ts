import { describe, expect, it } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import type { DeclaredArtifact, RuntimeCallName, RuntimeCalls } from './calls'
import { ArtifactConsents } from './consent'
import { DESKTOP_CLIENT } from './dispatcher'

const ID = 'art_01J9Z3K4V5W6X7Y8Z9A0B1C2D3'
const ARTIFACT: DeclaredArtifact = {
  id: ID,
  project: '/work/app',
  title: 'Board',
  head: 2,
  deleted: false,
  capabilities: ['files', 'sample'],
  runtime: 1,
}

function setup(watching: string[] = ['window-1', 'window-2', 'device-1']) {
  const granted = new Set<string>()
  const sent: { ports: readonly string[]; event: HostEvent }[] = []
  const broadcasts: HostEvent[] = []
  const store = {
    watchers: () => watching,
    runtime: async <K extends RuntimeCallName>(
      name: K,
      params: RuntimeCalls[K]['params'],
    ): Promise<RuntimeCalls[K]['result']> => {
      const p = params as { capability?: string }
      if (name === 'consentOf') return [...granted] as RuntimeCalls[K]['result']
      if (name === 'consentGrant') {
        granted.add(p.capability!)
        return null as RuntimeCalls[K]['result']
      }
      if (name === 'consentRevoke') {
        const changed = granted.size > 0
        granted.clear()
        return { changed } as RuntimeCalls[K]['result']
      }
      throw new Error(`unexpected ${name}`)
    },
  }
  const consents = new ArtifactConsents({
    store,
    isDevice: (portId) => portId.startsWith('device-'),
    send: (ports, event) => sent.push({ ports, event }),
    broadcast: (event) => broadcasts.push(event),
    agentName: async () => 'Fake Agent',
  })
  const asked = () =>
    sent.flatMap(({ ports, event }) =>
      event.type === 'artifacts.consentAsked' ? [{ ports, ask: event.ask }] : [],
    )
  const settled = () =>
    sent.flatMap(({ ports, event }) =>
      event.type === 'artifacts.consentSettled' ? [{ ports, ...event }] : [],
    )
  return { consents, granted, sent, broadcasts, asked, settled }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("an artifact's consents", () => {
  it("asks the desktop's windows that show the artifact, never a device's", async () => {
    const { consents, asked } = setup()
    void consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)
    await tick()
    expect(asked()).toEqual([
      {
        ports: ['window-1', 'window-2'],
        ask: {
          requestId: expect.any(String),
          artifactId: ID,
          title: 'Board',
          project: '/work/app',
          capability: 'files',
          agent: null,
        },
      },
    ])
  })

  it('asks a device only on the port its page came from, naming the agent for sample', async () => {
    const { consents, asked } = setup(['window-1', 'device-1', 'device-2'])
    void consents.ask(ARTIFACT, 'sample', 'device-2', 1000)
    await tick()
    expect(asked()).toMatchObject([{ ports: ['device-2'], ask: { agent: 'Fake Agent' } }])
  })

  it('refuses at once when nobody shows the artifact, or for what needs no consent', async () => {
    const { consents, asked } = setup([])
    expect(await consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)).toBe('denied')
    const shown = setup()
    expect(await shown.consents.ask(ARTIFACT, 'db', DESKTOP_CLIENT, 1000)).toBe('denied')
    expect(asked()).toEqual([])
    expect(shown.asked()).toEqual([])
  })

  it('remembers an Allow, settles every page waiting, and tells every window', async () => {
    const { consents, asked, settled, broadcasts, granted } = setup()
    const first = consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)
    const second = consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)
    await tick()
    // A second page joins the open question instead of asking again.
    expect(asked()).toHaveLength(1)
    const { requestId } = asked()[0]!.ask
    await consents.answer(requestId, true, 'window-2')
    expect(await first).toBe('allowed')
    expect(await second).toBe('allowed')
    expect([...granted]).toEqual(['files'])
    expect(await consents.allowed(ID, 'files')).toBe(true)
    expect(broadcasts).toEqual([{ type: 'artifacts.consentsChanged' }])
    expect(settled()).toEqual([
      {
        ports: ['window-1', 'window-2'],
        type: 'artifacts.consentSettled',
        requestId,
        artifactId: ID,
        reload: false,
      },
    ])
    await expect(consents.answer(requestId, true, 'window-1')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('takes an answer only from a port that was asked', async () => {
    const { consents, asked, granted } = setup()
    void consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)
    await tick()
    const { requestId } = asked()[0]!.ask
    await expect(consents.answer(requestId, true, 'device-1')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(granted.size).toBe(0)
  })

  it('reloads the page when the Allow came after it stopped waiting', async () => {
    const { consents, asked, settled } = setup()
    expect(await consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 5)).toBe('waiting')
    const { requestId } = asked()[0]!.ask
    await consents.answer(requestId, true, 'window-1')
    expect(settled()).toMatchObject([{ requestId, reload: true }])
  })

  it("holds a Don't allow for the client until nothing shows the artifact", async () => {
    const { consents, asked, granted } = setup()
    const page = consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)
    await tick()
    await consents.answer(asked()[0]!.ask.requestId, false, 'window-1')
    expect(await page).toBe('denied')
    expect(granted.size).toBe(0)
    expect(await consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)).toBe('denied')
    expect(asked()).toHaveLength(1)
    // Another client's user is still asked.
    void consents.ask(ARTIFACT, 'files', 'device-1', 1000)
    await tick()
    expect(asked()).toHaveLength(2)
    consents.unwatched(ID)
    void consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)
    await tick()
    expect(asked()).toHaveLength(3)
  })

  it('ends a question when every port asked has closed', async () => {
    const { consents, settled } = setup()
    const page = consents.ask(ARTIFACT, 'files', DESKTOP_CLIENT, 1000)
    await tick()
    consents.portClosed('window-1')
    expect(settled()).toEqual([])
    consents.portClosed('window-2')
    expect(await page).toBe('denied')
    expect(settled()).toMatchObject([{ reload: false }])
  })

  it('takes back everything allowed on revoke', async () => {
    const { consents, granted, broadcasts } = setup()
    granted.add('files').add('sample')
    await consents.revoke(ID)
    expect(await consents.allowed(ID, 'files')).toBe(false)
    expect(broadcasts).toEqual([{ type: 'artifacts.consentsChanged' }])
    await consents.revoke(ID)
    expect(broadcasts).toHaveLength(1)
  })
})
