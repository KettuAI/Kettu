import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '@shared/remote/channel'
import { Outbox, type OutboxConnection, type OutboxWriteTiming } from './outbox'

/** 构造可控写入完成时机的模拟连接，便于验证最后一帧写完时刻与前方积压字节。 */
function fakeConnection(buffered = 0) {
  const sent: { message: ChannelMessage; resolve: () => void; reject: (err: Error) => void }[] = []
  let currentBuffered = buffered
  const connection: OutboxConnection = {
    channel: {
      send: (message) =>
        new Promise<void>((resolve, reject) => {
          sent.push({ message, resolve, reject })
        }),
    },
    transport: {
      buffered: () => currentBuffered,
      drained: () => Promise.resolve(),
    },
  }
  return {
    connection,
    sent,
    setBuffered: (bytes: number) => {
      currentBuffered = bytes
    },
  }
}

describe('Outbox 送达计时与前方队列字节统计', () => {
  it('统计排在回答前面的队列字节、在写字节与传输缓冲字节，并在最后一帧写出时上报一次', async () => {
    let clock = 1000
    const timings: OutboxWriteTiming[] = []
    const conn = fakeConnection(100)
    const outbox = new Outbox({
      acks: true,
      limits: { inFlight: 1 },
      now: () => clock,
      dropped: () => {},
      overflowed: () => {},
      onWritten: (timing) => timings.push(timing),
    })
    outbox.attach(conn.connection, 0)

    // 先发送一条较大的响应占满 inFlight 窗口
    const bigPayload = { type: 'response', id: 1, result: { data: 'x'.repeat(500) } }
    const bigSize = Buffer.byteLength(JSON.stringify(bigPayload))
    await outbox.push(
      { kind: 'json', value: bigPayload },
      { kind: 'answer', method: 'sessions.open', startedAt: 950 },
    )
    expect(conn.sent).toHaveLength(1)

    // 在第一条尚未写完时再入队第二条回答，前方应包含第一条在写字节 + 传输缓冲字节
    clock = 1040
    const smallPayload = { type: 'response', id: 2, result: { ok: true } }
    const smallSize = Buffer.byteLength(JSON.stringify(smallPayload))
    await outbox.push(
      { kind: 'json', value: smallPayload },
      { kind: 'answer', method: 'sessions.list', startedAt: 1020 },
    )
    expect(conn.sent).toHaveLength(1)

    // 第一条最后一帧在 t=1060 写出完成
    clock = 1060
    conn.sent[0]!.resolve()
    await Promise.resolve()

    expect(timings).toHaveLength(1)
    expect(timings[0]).toEqual({
      trace: { kind: 'answer', method: 'sessions.open', startedAt: 950 },
      enqueuedAt: 1000,
      sendStartedAt: 1000,
      writtenAt: 1060,
      queuedBytes: 100,
      bytes: bigSize,
      merged: 1,
    })

    // 设备确认第 1 条后，第 2 条在 t=1120 开始写出、t=1135 写完最后一帧
    clock = 1120
    outbox.ack(1)
    expect(conn.sent).toHaveLength(2)
    clock = 1135
    conn.sent[1]!.resolve()
    await Promise.resolve()

    expect(timings).toHaveLength(2)
    expect(timings[1]).toEqual({
      trace: { kind: 'answer', method: 'sessions.list', startedAt: 1020 },
      enqueuedAt: 1040,
      sendStartedAt: 1120,
      writtenAt: 1135,
      queuedBytes: bigSize + 100,
      bytes: smallSize,
      merged: 1,
    })

    // 断线重连重传未确认的第 2 条时，不再重复触发 onWritten
    const conn2 = fakeConnection(0)
    outbox.detach()
    outbox.attach(conn2.connection, 1)
    expect(conn2.sent).toHaveLength(1)
    clock = 1200
    conn2.sent[0]!.resolve()
    await Promise.resolve()
    expect(timings).toHaveLength(2)
  })

  it('合并排队中的 session.patches 批次时保留最早刷出时刻与合并计数', async () => {
    let clock = 2000
    const timings: OutboxWriteTiming[] = []
    const conn = fakeConnection(0)
    const outbox = new Outbox({
      acks: true,
      limits: { inFlight: 1 },
      now: () => clock,
      dropped: () => {},
      overflowed: () => {},
      onWritten: (timing) => timings.push(timing),
    })
    outbox.attach(conn.connection, 0)

    // 先占满 inFlight 窗口
    await outbox.push({ kind: 'json', value: { type: 'response', id: 1, result: null } })
    conn.sent[0]!.resolve()
    await Promise.resolve()

    // 连续入队两批待合并的补丁
    clock = 2050
    await outbox.push(
      {
        kind: 'json',
        value: {
          type: 'event',
          event: {
            type: 'session.patches',
            batch: {
              sessionId: 's-1',
              seq: 1,
              patches: [{ op: 'entry.appendText', id: 'e1', text: 'a' }],
            },
          },
        },
      },
      { kind: 'live', eventType: 'session.patches', sessionId: 's-1', startedAt: 2050 },
    )
    clock = 2090
    await outbox.push(
      {
        kind: 'json',
        value: {
          type: 'event',
          event: {
            type: 'session.patches',
            batch: {
              sessionId: 's-1',
              seq: 2,
              patches: [{ op: 'entry.appendText', id: 'e1', text: 'b' }],
            },
          },
        },
      },
      { kind: 'live', eventType: 'session.patches', sessionId: 's-1', startedAt: 2090 },
    )

    // 确认第 1 条并写出合并后的补丁
    clock = 2150
    outbox.ack(1)
    expect(conn.sent).toHaveLength(2)
    clock = 2165
    conn.sent[1]!.resolve()
    await Promise.resolve()

    expect(timings).toHaveLength(1)
    expect(timings[0]!.trace).toEqual({
      kind: 'live',
      eventType: 'session.patches',
      sessionId: 's-1',
      startedAt: 2050,
    })
    expect(timings[0]!.enqueuedAt).toBe(2050)
    expect(timings[0]!.sendStartedAt).toBe(2150)
    expect(timings[0]!.writtenAt).toBe(2165)
    expect(timings[0]!.merged).toBe(2)
  })

  it('无 ack 模式下同样记录前方缓冲字节与写出耗时', async () => {
    let clock = 3000
    const timings: OutboxWriteTiming[] = []
    const conn = fakeConnection(256)
    const outbox = new Outbox({
      acks: false,
      now: () => clock,
      dropped: () => {},
      overflowed: () => {},
      onWritten: (timing) => timings.push(timing),
    })
    outbox.attach(conn.connection, 0)

    const payload = { type: 'response', id: 7, result: { ok: true } }
    const sending = outbox.push(
      { kind: 'json', value: payload },
      { kind: 'answer', method: 'sessions.list', startedAt: 2980 },
    )
    clock = 3030
    conn.sent[0]!.resolve()
    await sending

    expect(timings).toHaveLength(1)
    expect(timings[0]).toMatchObject({
      enqueuedAt: 3000,
      writtenAt: 3030,
      queuedBytes: 256,
      bytes: Buffer.byteLength(JSON.stringify(payload)),
      merged: 1,
    })
  })
})
