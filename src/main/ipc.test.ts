import { EventEmitter } from 'node:events'
import type { IpcMainEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [] },
  dialog: {},
  ipcMain: {},
  nativeTheme: {},
  Notification: class {},
  screen: {},
  shell: {},
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

const { isTrusted, whenSettled } = await import('./ipc')
const { watchSubframes } = await import('./subframes')

const ARTIFACT = 'overbench-artifact://0123456789abcdef0123456789/'

interface FakeFrame {
  parent: FakeFrame | null
  url: string
  origin?: string
  frames: FakeFrame[]
  framesInSubtree: FakeFrame[]
  frameTreeNodeId: number
  processId: number
  routingId: number
}

class FakeContents extends EventEmitter {
  id = 1
  mainFrame: FakeFrame = {
    parent: null,
    url: 'http://localhost:5173/',
    frames: [],
    framesInSubtree: [],
    frameTreeNodeId: 1,
    processId: 1,
    routingId: 1,
  }

  isDestroyed(): boolean {
    return false
  }

  addFrame(): FakeFrame {
    const frame = { ...this.mainFrame, parent: this.mainFrame, url: '', frames: [] }
    frame.frameTreeNodeId = frame.routingId = 2
    this.mainFrame.frames.push(frame)
    this.mainFrame.framesInSubtree = [this.mainFrame, frame]
    this.emit('frame-created', {}, { frame })
    return frame
  }

  commit(frame: FakeFrame, url: string): void {
    frame.origin = url.startsWith(ARTIFACT) ? ARTIFACT.slice(0, -1) : 'http://localhost:5173'
    this.emit('did-frame-navigate', {}, url, 200, 'OK', false, frame.processId, frame.routingId)
  }
}

function eventFrom(contents: FakeContents): IpcMainEvent {
  return { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent
}

function watch(contents: FakeContents): void {
  watchSubframes(contents as unknown as WebContents, {
    isOpenedArtifact: (origin) => origin === ARTIFACT.slice(0, -1),
    onRevoked: () => {},
  })
}

describe('isTrusted', () => {
  it("refuses the app's own page once a frame of it was refused, until it loads again", () => {
    const contents = new FakeContents()
    watch(contents)
    expect(isTrusted(eventFrom(contents))).toBe(true)

    contents.commit(contents.addFrame(), 'about:srcdoc')
    expect(isTrusted(eventFrom(contents))).toBe(false)

    contents.mainFrame.frames = []
    contents.emit('did-navigate', {}, contents.mainFrame.url, -1, '')
    expect(isTrusted(eventFrom(contents))).toBe(true)
  })
})

describe('whenSettled', () => {
  it('runs at once, with whether the sender is trusted, while no frame is pending', () => {
    const contents = new FakeContents()
    watch(contents)
    expect(whenSettled(eventFrom(contents), (trusted) => trusted)).toBe(true)
  })

  it("holds a call while a frame is pending and runs it once the frame is an artifact's", async () => {
    const contents = new FakeContents()
    watch(contents)
    const frame = contents.addFrame()
    let answer: boolean | null = null
    const call = whenSettled(eventFrom(contents), (trusted) => (answer = trusted))
    await Promise.resolve()
    expect(answer).toBeNull()
    contents.commit(frame, ARTIFACT)
    await call
    expect(answer).toBe(true)
  })

  it('refuses a held call once the frame turns out to be something else', async () => {
    const contents = new FakeContents()
    watch(contents)
    const frame = contents.addFrame()
    const call = whenSettled(eventFrom(contents), (trusted) => trusted)
    contents.commit(frame, 'http://localhost:5173/')
    expect(await call).toBe(false)
  })

  it('runs held calls and messages in the order they came', async () => {
    const contents = new FakeContents()
    watch(contents)
    const frame = contents.addFrame()
    const order: string[] = []
    const call = whenSettled(eventFrom(contents), async () => {
      order.push('call')
      await Promise.resolve()
      order.push('call answered')
    })
    void whenSettled(eventFrom(contents), () => order.push('message'))
    contents.commit(frame, ARTIFACT)
    await call
    expect(order).toEqual(['call', 'message', 'call answered'])
  })
})
