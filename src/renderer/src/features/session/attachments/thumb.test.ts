import { describe, expect, it, vi } from 'vitest'
import { host } from '@renderer/lib/host'
import { prepareImage } from '../composer/image-work'
import { replayThumb } from './thumb'

vi.mock('../composer/image-work', () => ({ prepareImage: vi.fn() }))
vi.mock('@renderer/lib/host', async (original) => ({
  ...(await original<typeof import('@renderer/lib/host')>()),
  host: vi.fn(),
}))

const request = vi.mocked(host)
const prepare = vi.mocked(prepareImage)

describe('replayed thumbnails', () => {
  it('asks for an image without a thumbnail once and keeps the made one', async () => {
    request.mockResolvedValue({ mimeType: 'image/png', bytes: new ArrayBuffer(4) })
    prepare.mockResolvedValue({
      thumb: 'data:image/webp;base64,AAAA',
      width: 2,
      height: 2,
      bytes: new ArrayBuffer(4),
      mimeType: 'image/png',
      scaled: null,
      ms: 1,
    })
    const attachment = { type: 'image' as const, thumb: null, blob: 'abc123' }
    const [first, second] = await Promise.all([
      replayThumb('s1', attachment),
      replayThumb('s1', attachment),
    ])
    expect(first).toBe('data:image/webp;base64,AAAA')
    expect(second).toBe(first)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('sessions.blob', { sessionId: 's1', hash: 'abc123' })
    expect(await replayThumb('s1', attachment)).toBe(first)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps a thumbnail an attachment already has', async () => {
    expect(
      await replayThumb('s1', { type: 'image', thumb: 'data:image/webp;base64,BBBB', blob: null }),
    ).toBe('data:image/webp;base64,BBBB')
    expect(request).not.toHaveBeenCalled()
  })
})
