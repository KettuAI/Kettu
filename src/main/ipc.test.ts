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

const { isTrusted } = await import('./ipc')
const { watchSubframes } = await import('./subframes')

class FakeContents extends EventEmitter {
  id = 1
  mainFrame = { parent: null, url: 'http://localhost:5173/', frames: [] as unknown[] }
}

function eventFrom(contents: FakeContents): IpcMainEvent {
  return { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent
}

describe('isTrusted', () => {
  it("refuses the app's own page once it has had a subframe, until it loads again", () => {
    const contents = new FakeContents()
    watchSubframes(contents as unknown as WebContents, () => {})
    expect(isTrusted(eventFrom(contents))).toBe(true)

    const frame = { parent: contents.mainFrame, url: 'about:srcdoc', frames: [] }
    contents.mainFrame.frames.push(frame)
    contents.emit('frame-created', {}, { frame })
    expect(isTrusted(eventFrom(contents))).toBe(false)

    contents.mainFrame.frames = []
    contents.emit('did-navigate', {}, contents.mainFrame.url, -1, '')
    expect(isTrusted(eventFrom(contents))).toBe(true)
  })
})
