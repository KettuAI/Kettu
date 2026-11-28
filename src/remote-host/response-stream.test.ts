import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPair } from '@shared/remote/noise'
import { PROTOCOL_VERSION, RESPONSE_STREAM_FEATURE } from '@shared/remote/protocol'
import { STREAMED_RESPONSE_BYTES } from '@shared/remote/streams'
import { ActivityLog } from './activity'
import { DeviceStore } from './devices'
import { LinkRequests, type RequestWire } from './link-requests'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { connectDevice } from './testing/device'
import { memoryPorts, memoryTransports } from './testing/memory'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function setupServer(handler: (method: string, params: unknown) => unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-resp-stream-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const log = (): void => {}
  const devices = await DeviceStore.load(dir, log)
  const activity = await ActivityLog.load(dir, log)
  const hostKey = await generateKeyPair()
  const phoneKey = await generateKeyPair()
  const phone = (await devices.add({
    publicKey: Buffer.from(phoneKey.publicKey).toString('base64'),
    name: 'Phone',
    kind: 'ios',
    platform: 'ios',
    model: 'iPhone 17 Pro',
  }))!
  const server = new RemoteServer({
    staticKey: hostKey,
    host: { name: 'Studio', platform: process.platform, version: '0.1.33-test' },
    devices,
    activity,
    pairing: new PairingCodes({
      hostKey: hostKey.publicKey,
      addresses: () => [],
      send: () => {},
    }),
    uploads: path.join(dir, 'uploads'),
    openAgentPort: async () => {
      const [serverSide, agentSide] = memoryPorts()
      agentSide.onMessage((msg) => {
        const req = msg as { type?: string; id?: number; method?: string; params?: unknown }
        if (req.type !== 'request' || typeof req.id !== 'number') return
        const result = handler(req.method ?? '', req.params)
        agentSide.send({ type: 'response', id: req.id, result })
      })
      return serverSide
    },
    changed: () => {},
    log,
  })
  cleanups.push(() => server.stop('stopping'))

  const connect = async (features: string[] = []) => {
    const [a, b] = memoryTransports()
    server.accept(a, 'direct')
    const device = await connectDevice({
      transport: b,
      hostKey: hostKey.publicKey,
      key: phoneKey,
      hello: {
        protocol: { min: 1, max: PROTOCOL_VERSION },
        features,
      },
    })
    cleanups.push(async () => device.close())
    await device.first
    return device
  }

  return { server, phone, connect }
}

describe('超过 64 KiB 的大响应流式分块传输（response-stream）', () => {
  it('客户端声明 response-stream 时，超过 64 KiB 的纯 JSON 回答走 response.stream + bytes + stream.end，小回答仍走普通 response', async () => {
    const bigText = 'alpha-beta-gamma-0123456789\n'.repeat(4000) // ~112 KiB
    const smallResult = { ok: true, text: 'short' }
    const bigResult = { ok: true, content: bigText, count: 4000 }
    expect(Buffer.byteLength(JSON.stringify(bigResult), 'utf8')).toBeGreaterThan(
      STREAMED_RESPONSE_BYTES,
    )

    const t = await setupServer((method) =>
      method === 'big.read' ? bigResult : smallResult,
    )
    const device = await t.connect([RESPONSE_STREAM_FEATURE])

    // 1. 小回答走常规 response
    await device.send({ type: 'request', id: 1, method: 'small.read' })
    await expect.poll(() =>
      device.messages.find((m) => (m as { id?: number }).id === 1),
    ).toEqual({ type: 'response', id: 1, result: smallResult })

    // 2. 超过 64 KiB 的回答走 response.stream 控制头 + bytes 帧 + stream.end
    await device.send({ type: 'request', id: 2, method: 'big.read' })

    let header: { type: string; id: number; stream: number; size: number; encoding?: string } | undefined
    await expect.poll(() => {
      header = device.messages.find(
        (m) => (m as { type?: string; id?: number }).type === 'response.stream' && (m as { id?: number }).id === 2,
      ) as typeof header
      return header !== undefined
    }).toBe(true)

    expect(header!.encoding).toBe('deflate')
    expect(header!.size).toBeLessThan(Buffer.byteLength(JSON.stringify(bigResult), 'utf8'))

    const total = await device.download(header!.stream)
    expect(total.length).toBe(header!.size)
    const decoded = JSON.parse(inflateRawSync(total).toString('utf8'))
    expect(decoded).toEqual(bigResult)
  })

  it('未声明 response-stream 的旧客户端仍收到常规单条 response，完全向后兼容', async () => {
    const bigResult = { content: 'legacy-client-line\n'.repeat(5000) }
    const t = await setupServer(() => bigResult)
    const legacy = await t.connect([])

    await legacy.send({ type: 'request', id: 1, method: 'big.read' })
    await expect.poll(() =>
      legacy.messages.find((m) => (m as { id?: number }).id === 1),
    ).toEqual({ type: 'response', id: 1, result: bigResult })
    expect(
      legacy.messages.some((m) => (m as { type?: string }).type === 'response.stream'),
    ).toBe(false)
  })

  it('LinkRequests 正确接收、解压并还原压缩和未压缩的 response.stream，并在流损坏或取消时返回错误', () => {
    const delivered: unknown[] = []
    const sent: unknown[] = []
    let nextStream = 1
    const links = new LinkRequests({
      toMain: (msg) => delivered.push(msg),
      nextStream: () => {
        const s = nextStream
        nextStream += 2
        return s
      },
      log: () => {},
    })
    const wire: RequestWire = {
      send: (value) => sent.push(value),
      sendBytes: async () => {},
      buffered: () => 0,
      drained: async () => {},
      bytes: true,
    }
    links.attach(wire, 0)

    // 1. raw deflate 压缩流分片重组
    links.request({ type: 'request', id: 10, method: 'sessions.open', params: {} })
    const wireId1 = (sent.at(-1) as { id: number }).id
    const expected1 = { ok: true, payload: 'hello-stream-'.repeat(2000) }
    const deflated = deflateRawSync(Buffer.from(JSON.stringify(expected1), 'utf8'))
    links.received({ type: 'response.stream', id: wireId1, stream: 2, size: deflated.length, encoding: 'deflate' })
    links.bytes(2, deflated.subarray(0, 20))
    links.bytes(2, deflated.subarray(20))
    links.received({ type: 'stream.end', stream: 2 })
    expect(delivered.at(-1)).toEqual({ type: 'response', id: 10, result: expected1 })

    // 2. 未压缩 UTF-8 JSON 流
    links.request({ type: 'request', id: 11, method: 'files.read', params: {} })
    const wireId2 = (sent.at(-1) as { id: number }).id
    const expected2 = { raw: 'plain-utf8-text' }
    const raw = Buffer.from(JSON.stringify(expected2), 'utf8')
    links.received({ type: 'response.stream', id: wireId2, stream: 4, size: raw.length })
    links.bytes(4, raw)
    links.received({ type: 'stream.end', stream: 4 })
    expect(delivered.at(-1)).toEqual({ type: 'response', id: 11, result: expected2 })

    // 3. 流被对端取消时透传 error，不挂起调用方
    links.request({ type: 'request', id: 12, method: 'files.read', params: {} })
    const wireId3 = (sent.at(-1) as { id: number }).id
    links.received({ type: 'response.stream', id: wireId3, stream: 6, size: 100, encoding: 'deflate' })
    links.received({ type: 'stream.cancel', stream: 6, error: { code: 'internal', message: 'cancelled' } })
    expect(delivered.at(-1)).toEqual({
      type: 'error',
      id: 12,
      error: { code: 'internal', message: 'cancelled' },
    })
  })
})
