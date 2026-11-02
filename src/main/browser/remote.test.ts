import { describe, expect, it } from 'vitest'
import type { BrowserCallAnswer } from '@shared/browser'
import { forwardedUrl, onHost, parseDeviceCall, RemoteBrowser, unmapped } from './remote'

const devBox = 'a'.repeat(32)
const mini = 'b'.repeat(32)

describe('forwardedUrl', () => {
  it('puts the address at the forward’s port, keeping its name, path and scheme', () => {
    expect(forwardedUrl('http://localhost:5173/app?x=1#top', 50123)).toEqual({
      url: 'http://localhost:50123/app?x=1#top',
      mapping: { local: 'http://localhost:50123', remote: 'http://localhost:5173' },
    })
    expect(forwardedUrl('https://shop.localhost/', 50124).mapping).toEqual({
      local: 'https://shop.localhost:50124',
      remote: 'https://shop.localhost',
    })
    // The forward listens on 127.0.0.1 alone.
    expect(forwardedUrl('http://[::1]:8080/', 50125).url).toBe('http://127.0.0.1:50125/')
  })
})

describe('unmapped', () => {
  it('names the page’s addresses as the host does, everywhere but a longer port', () => {
    const mappings = [{ local: 'http://localhost:5012', remote: 'http://localhost:3000' }]
    expect(
      unmapped(
        {
          url: 'http://localhost:5012/a',
          snapshot: '- link "Home" [ref=e1] -> http://localhost:5012/',
          requests: [{ url: 'http://localhost:50123/b' }],
          size: 3,
        },
        mappings,
      ),
    ).toEqual({
      url: 'http://localhost:3000/a',
      snapshot: '- link "Home" [ref=e1] -> http://localhost:3000/',
      requests: [{ url: 'http://localhost:50123/b' }],
      size: 3,
    })
  })
})

describe('parseDeviceCall', () => {
  it('keeps a call and refuses what is not one', () => {
    const call = {
      callId: 3,
      sessionId: 's1',
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3000/' },
      projectPath: '/work/app',
      forward: { host: 'localhost', port: 3000 },
    }
    expect(parseDeviceCall(call)).toEqual(call)
    expect(parseDeviceCall({ ...call, tool: 'shell_run' })).toBeNull()
    expect(parseDeviceCall({ ...call, forward: { host: 'example.com', port: 80 } })).toBeNull()
    expect(parseDeviceCall({ ...call, callId: 0 })).toBeNull()
    expect(parseDeviceCall({ ...call, args: [] })).toBeNull()
  })
})

function setup(answer: BrowserCallAnswer = { result: { text: 'Done.', value: {} } }) {
  const runs: { sessionId: string; tool: string; args: unknown; projectPath: string }[] = []
  const requests: { hostId: string; method: string; params: unknown }[] = []
  const forwards: { hostId: string; sessionId: string; port: number }[] = []
  const closed: string[] = []
  const answers: { sessionId: string; requestId: number; decision: string }[] = []
  let waiting: ((on: boolean) => void) | null = null
  let localPort: number | null = 50123
  const browser = new RemoteBrowser({
    run: async (_callId, sessionId, tool, args, projectPath, wait) => {
      runs.push({ sessionId, tool, args, projectPath })
      waiting = wait
      return answer
    },
    forward: async (hostId, sessionId, forward) => {
      forwards.push({ hostId, sessionId, port: forward.port })
      return localPort
    },
    closeForwards: (hostId, sessionId) => closed.push(`${hostId}/${sessionId}`),
    answerOrigin: (sessionId, requestId, decision) =>
      answers.push({ sessionId, requestId, decision }),
    request: (hostId, method, params) => {
      requests.push({ hostId, method, params })
      return true
    },
    log: () => {},
  })
  return {
    browser,
    runs,
    requests,
    forwards,
    closed,
    answers,
    wait: (on: boolean) => waiting?.(on),
    noPort: () => (localPort = null),
  }
}

const navigate = (url: string, port = 3000) => ({
  callId: 5,
  sessionId: 's1',
  tool: 'browser_navigate',
  args: { url },
  projectPath: '/work/app',
  forward: { host: 'localhost', port },
})

describe('RemoteBrowser', () => {
  it('opens a host’s dev server at its forward, and answers in the host’s addresses', async () => {
    const t = setup({
      result: {
        text: 'Opened http://localhost:50123/login',
        value: { url: 'http://localhost:50123/login', title: 'Log in' },
      },
    })
    await t.browser.call(devBox, navigate('http://localhost:3000/'))
    expect(t.forwards).toEqual([{ hostId: devBox, sessionId: 's1', port: 3000 }])
    expect(t.runs).toEqual([
      {
        sessionId: 's1',
        tool: 'browser_navigate',
        args: { url: 'http://localhost:50123/' },
        projectPath: onHost(devBox, '/work/app'),
      },
    ])
    expect(t.requests).toEqual([
      {
        hostId: devBox,
        method: 'browser.answer',
        params: {
          callId: 5,
          answer: {
            result: {
              text: 'Opened http://localhost:3000/login',
              value: { url: 'http://localhost:3000/login', title: 'Log in' },
            },
          },
        },
      },
    ])
    expect(t.browser.hostOf('s1')).toBe(devBox)
  })

  it('says so when the port cannot be forwarded, and runs nothing', async () => {
    const t = setup()
    t.noPort()
    await t.browser.call(devBox, navigate('http://localhost:3000/'))
    expect(t.runs).toEqual([])
    expect(t.requests[0]!.params).toMatchObject({
      answer: { error: { code: 'navigation_failed' } },
    })
  })

  it('refuses a forward that is not the address’s', async () => {
    const t = setup()
    await t.browser.call(devBox, navigate('http://localhost:3000/', 4000))
    expect(t.forwards).toEqual([])
    expect(t.requests[0]!.params).toMatchObject({ answer: { error: { code: 'invalid' } } })
  })

  it('keeps each page to the host or the agent host that drove it first', async () => {
    const t = setup()
    await t.browser.call(devBox, { ...navigate('http://localhost:3000/'), sessionId: 's2' })
    await t.browser.call(mini, { ...navigate('http://localhost:3000/'), sessionId: 's2' })
    expect(t.requests.at(-1)).toMatchObject({
      hostId: mini,
      params: { answer: { error: { code: 'no_page' } } },
    })
    expect(t.browser.claimLocal('s2')).toBe(false)
    expect(t.browser.claimLocal('s3')).toBe(true)
    await t.browser.call(devBox, { ...navigate('http://localhost:3000/'), sessionId: 's3' })
    expect(t.requests.at(-1)).toMatchObject({ params: { answer: { error: { code: 'no_page' } } } })
  })

  it('sends the page’s site questions and waits to its host, and none of this computer’s', async () => {
    const t = setup()
    await t.browser.call(devBox, navigate('http://localhost:3000/'))
    t.wait(true)
    expect(t.browser.originAsked({ id: 2, sessionId: 's1', origin: 'https://example.com' })).toBe(
      true,
    )
    expect(t.browser.originAnswered({ id: 2, sessionId: 's1', decision: 'deny' })).toBe(true)
    expect(t.browser.originAsked({ id: 3, sessionId: 'mine', origin: 'https://a.example' })).toBe(
      false,
    )
    expect(t.requests.slice(1)).toEqual([
      { hostId: devBox, method: 'browser.waiting', params: { callId: 5, waiting: true } },
      {
        hostId: devBox,
        method: 'browser.origin',
        params: { sessionId: 's1', requestId: 2, origin: 'https://example.com' },
      },
      {
        hostId: devBox,
        method: 'browser.originSettled',
        params: { requestId: 2, decision: 'deny' },
      },
    ])
  })

  it('gives its page the answer to a new site from that page’s host alone', async () => {
    const t = setup()
    await t.browser.call(devBox, navigate('http://localhost:3000/'))
    t.browser.originDecided(devBox, { sessionId: 's1', requestId: 2, decision: 'project' })
    t.browser.originDecided(mini, { sessionId: 's1', requestId: 3, decision: 'deny' })
    t.browser.originDecided(devBox, { sessionId: 'mine', requestId: 4, decision: 'deny' })
    t.browser.originDecided(devBox, { sessionId: 's1', requestId: 5, decision: 'timeout' })
    t.browser.originDecided(devBox, { sessionId: 's1', requestId: '6', decision: 'deny' })
    expect(t.answers).toEqual([{ sessionId: 's1', requestId: 2, decision: 'project' }])
  })

  it('closes the forwards of a page that went with its session', async () => {
    const t = setup()
    await t.browser.call(devBox, navigate('http://localhost:3000/'))
    t.browser.pageRemoved('s1')
    t.browser.pageRemoved('mine')
    expect(t.closed).toEqual([`${devBox}/s1`])
    expect(t.browser.hostOf('s1')).toBeNull()
  })
})
