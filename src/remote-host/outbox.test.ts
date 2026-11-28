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

describe('Outbox 按字节流控与高优插队调度', () => {
  it('按 inFlightBytes 限流，允许高优小消息越过排队大快照且严守同会话补丁不越过自身回答', async () => {
    const conn = fakeConnection(0)
    const outbox = new Outbox({
      acks: true,
      limits: {
        inFlight: 16,
        inFlightBytes: 1024,
        highPriorityReserveBytes: 2048,
        smallMessageBytes: 512,
      },
      dropped: () => {},
      overflowed: () => {},
    })
    outbox.attach(conn.connection, 0)

    // 1. 通道空闲时单条超限大块流消息仍可立即发出，占满普通字节窗口
    await outbox.push({ kind: 'bytes', stream: 1, data: new Uint8Array(2048) })
    expect(conn.sent).toHaveLength(1)

    // 2. 此时普通窗口已满：入队会话 s-A 的大快照回答（> smallMessageBytes）应留在队列中等待 ack
    const bigSnapshotA = { type: 'response', id: 10, result: { blob: 'x'.repeat(2000) } }
    await outbox.push(
      { kind: 'json', value: bigSnapshotA },
      { kind: 'answer', method: 'sessions.open', sessionId: 's-A', startedAt: 100 },
    )
    expect(conn.sent).toHaveLength(1)

    // 3. 入队会话 s-A 自己的小补丁：虽然是高优小消息，但绝不能越过队列前面尚未发出的 s-A 回答
    const patchA = {
      type: 'event',
      event: {
        type: 'session.patches',
        batch: {
          sessionId: 's-A',
          seq: 1,
          patches: [{ op: 'entry.appendText', id: 'a1', text: 'A' }],
        },
      },
    }
    await outbox.push(
      { kind: 'json', value: patchA },
      { kind: 'live', eventType: 'session.patches', sessionId: 's-A', startedAt: 110 },
    )
    expect(conn.sent).toHaveLength(1)

    // 4. 入队会话 s-B 的小补丁、权限等待摘要和小 RPC 回答：必须立即越过 s-A 大快照借高优预留窗口发出
    const patchB = {
      type: 'event',
      event: {
        type: 'session.patches',
        batch: {
          sessionId: 's-B',
          seq: 1,
          patches: [{ op: 'entry.appendText', id: 'b1', text: 'B' }],
        },
      },
    }
    const permSummary = {
      type: 'event',
      event: {
        type: 'session.summary',
        summary: { id: 's-C', permissionCount: 1, attention: 'permission' },
      },
    }
    const fastAnswer = { type: 'response', id: 11, result: { ok: true } }

    await outbox.push(
      { kind: 'json', value: patchB },
      { kind: 'live', eventType: 'session.patches', sessionId: 's-B', startedAt: 120 },
    )
    await outbox.push({ kind: 'json', value: permSummary })
    await outbox.push(
      { kind: 'json', value: fastAnswer },
      { kind: 'answer', method: 'permissions.respond', sessionId: 's-C', startedAt: 130 },
    )

    expect(conn.sent).toHaveLength(4)
    expect(conn.sent.slice(1).map((item) => item.message)).toEqual([
      { kind: 'json', value: patchB },
      { kind: 'json', value: permSummary },
      { kind: 'json', value: fastAnswer },
    ])

    // 5. 设备确认前 4 条释放普通字节窗口后，s-A 大快照先发出，紧接着才是 s-A 的补丁
    outbox.ack(4)
    expect(conn.sent).toHaveLength(6)
    expect(conn.sent[4]!.message).toEqual({ kind: 'json', value: bigSnapshotA })
    expect(conn.sent[5]!.message).toEqual({ kind: 'json', value: patchA })
  })

  it('排队总字节超出 queuedBytes 上限时丢弃积压补丁并下发 resync', async () => {
    const conn = fakeConnection(0)
    const droppedCounts: number[] = []
    const outbox = new Outbox({
      acks: true,
      limits: {
        inFlight: 1,
        inFlightBytes: 256,
        queued: 100,
        queuedBytes: 500,
        mergedBytes: 128,
      },
      dropped: (count) => droppedCounts.push(count),
      overflowed: () => {},
    })
    outbox.attach(conn.connection, 0)

    // 先占满 inFlight 窗口
    await outbox.push({ kind: 'json', value: { type: 'response', id: 1, result: null } })
    expect(conn.sent).toHaveLength(1)

    // 连续推入多条不同会话补丁触发按字节溢出（条数远低于 queued=100）
    for (let i = 1; i <= 4; i++) {
      await outbox.push({
        kind: 'json',
        value: {
          type: 'event',
          event: {
            type: 'session.patches',
            batch: {
              sessionId: `s-${i}`,
              seq: 1,
              patches: [{ op: 'entry.appendText', id: 'e1', text: 'z'.repeat(180) }],
            },
          },
        },
      })
    }

    expect(droppedCounts.length).toBeGreaterThan(0)
    expect(droppedCounts.reduce((sum, count) => sum + count, 0)).toBe(4)
    outbox.ack(1)
    expect(conn.sent).toHaveLength(2)
    expect(conn.sent[1]!.message).toEqual({ kind: 'json', value: { type: 'resync' } })
  })
})
