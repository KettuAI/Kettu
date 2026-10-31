// A download the host gives up: the device hears why, and the log hears it without the file.

import { describe, expect, it } from 'vitest'
import type { StreamCancel, StreamEnd } from '@shared/remote/streams'
import { Downloads, type DownloadSource } from './downloads'

function downloads() {
  const sent: (StreamEnd | StreamCancel)[] = []
  const failed: string[] = []
  const list = new Downloads({
    channel: { send: async () => {} },
    transport: { buffered: () => 0, drained: () => Promise.resolve() },
    send: (message) => sent.push(message),
    failed: (reason) => failed.push(reason),
  })
  return { list, sent, failed }
}

describe('Downloads', () => {
  it('gives a source that cannot be read up, saying why without its path', async () => {
    const { list, sent, failed } = downloads()
    const error = Object.assign(new Error("EIO: i/o error, read '/Users/ada/secret/clip.mp4'"), {
      code: 'EIO',
      syscall: 'read',
      path: '/Users/ada/secret/clip.mp4',
    })
    const source: DownloadSource = {
      size: 10,
      read: () => Promise.reject(error),
      close: async () => {},
    }
    const { stream, finished } = list.open(source)
    list.start(stream)
    await finished
    expect(sent).toEqual([
      {
        type: 'stream.cancel',
        stream,
        error: { code: 'internal', message: 'The bytes could not be read' },
      },
    ])
    expect(failed).toEqual(['The bytes could not be read (EIO)'])
  })

  it('says nothing of one the device cancelled before its read failed', async () => {
    const { list, sent, failed } = downloads()
    let fail!: (error: Error) => void
    const source: DownloadSource = {
      size: 10,
      read: () => new Promise((_, reject) => (fail = reject)),
      close: async () => {},
    }
    const { stream, finished } = list.open(source)
    list.start(stream)
    list.cancel(stream)
    fail(new Error('EIO: i/o error, read'))
    await finished
    expect(sent).toEqual([])
    expect(failed).toEqual([])
  })
})
