import { describe, expect, it } from 'vitest'
import {
  decodeAgyGenMetadata,
  decodeAgyParentIds,
  decodeAgyStepMetadata,
  parsePbtxtTitle,
  resolveAgyModelName,
} from './agy-proto'

/** 测试用轻量 Protobuf Wire 编码辅助，仅用于构造单元测试样本。 */
function varint(value: number | bigint): Buffer {
  let n = typeof value === 'bigint' ? value : BigInt(value)
  const out: number[] = []
  do {
    let b = Number(n & 0x7fn)
    n >>= 7n
    if (n > 0n) b |= 0x80
    out.push(b)
  } while (n > 0n)
  return Buffer.from(out)
}

function fVarint(field: number, value: number | bigint): Buffer {
  return Buffer.concat([varint((BigInt(field) << 3n) | 0n), varint(value)])
}

function fBytes(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((BigInt(field) << 3n) | 2n), varint(payload.length), payload])
}

function fStr(field: number, text: string): Buffer {
  return fBytes(field, Buffer.from(text, 'utf8'))
}

function encodeTimestamp(sec: number, nanos = 0): Buffer {
  return Buffer.concat([fVarint(1, sec), ...(nanos > 0 ? [fVarint(2, nanos)] : [])])
}

describe('agy-proto wire decoders', () => {
  it('解码 steps.metadata 中的时间、ModelUsage、stepInfo 与 retryInfos', () => {
    const usage = Buffer.concat([
      fVarint(1, 1535),
      fVarint(2, 2896),
      fVarint(3, 261),
      fVarint(5, 371576),
      fVarint(6, 24),
      fStr(7, 'req-abc-123'),
      fVarint(9, 67),
      fVarint(10, 194),
    ])
    const stepInfo = Buffer.concat([
      fVarint(2, 42),
      fVarint(3, 19),
      fStr(4, '11111111-2222-3333-4444-555555555555'),
    ])
    const retry = Buffer.concat([
      fStr(3, 'rate limited'),
      fVarint(5, 429),
      fBytes(7, encodeTimestamp(2, 500_000_000)),
    ])
    const metaBlob = Buffer.concat([
      fBytes(1, encodeTimestamp(1_700_000_000, 250_000_000)),
      fBytes(6, encodeTimestamp(1_700_000_002, 0)),
      fBytes(7, encodeTimestamp(1_700_000_006, 500_000_000)),
      fBytes(9, usage),
      fVarint(11, 1535),
      fBytes(20, stepInfo),
      fBytes(28, retry),
    ])

    const decoded = decodeAgyStepMetadata(metaBlob, 0)
    expect(decoded).toEqual({
      createdAtMs: 1_700_000_000_250,
      viewableAtMs: 1_700_000_002_000,
      finishedGeneratingAtMs: 1_700_000_006_500,
      completedAtMs: null,
      modelUsage: {
        model: 'gemini-4-neon',
        inputTokens: 2896,
        outputTokens: 261,
        cacheReadTokens: 371576,
        thinkingOutputTokens: 67,
        responseOutputTokens: 194,
        apiProvider: 'google-gemini',
        requestId: 'req-abc-123',
      },
      generatorModel: 'gemini-4-neon',
      stepIndex: 42,
      genMetadataIdx: 19,
      originCascadeId: '11111111-2222-3333-4444-555555555555',
      retries: [
        {
          error: 'rate limited',
          reasonCode: 429,
          delayMs: 2500,
          usage: null,
        },
      ],
    })
  })

  it('解码 gen_metadata 中的原生计时、模型名与按需开关的上下文构成', () => {
    const childTool = Buffer.concat([fStr(1, 'mcp_kettu_set_plan'), fVarint(3, 520)])
    const groupTools = Buffer.concat([
      fStr(1, 'Tools'),
      fVarint(2, 2),
      fVarint(3, 1),
      fVarint(4, 1520),
      fBytes(5, childTool),
    ])
    const groupMsgs = Buffer.concat([fStr(1, 'Chat Messages'), fVarint(2, 7), fVarint(4, 8000)])
    const tokenBreakdown = Buffer.concat([
      fBytes(1, groupTools),
      fBytes(1, groupMsgs),
      fVarint(2, 9520),
    ])
    const cwMeta = Buffer.concat([fVarint(1, 9520), fBytes(3, tokenBreakdown), fVarint(4, 512_000)])
    const contextStats = fBytes(10, cwMeta)
    const extraEntry = Buffer.concat([fStr(1, 'model_enum'), fStr(2, 'MODEL_PLACEHOLDER_M535')])
    const chatModel = Buffer.concat([
      fBytes(1, Buffer.alloc(2048, 0x78)), // 模拟大体积 prompt 载荷应被 O(1) 跳过。
      fVarint(3, 1535),
      fBytes(9, contextStats),
      fBytes(11, encodeTimestamp(1, 250_000_000)),
      fBytes(12, encodeTimestamp(4, 800_000_000)),
      fStr(19, 'gemini-4-neon'),
      fBytes(20, extraEntry),
      fStr(21, 'Gemini 4 Neon (XHigh)'),
    ])
    const genBlob = fBytes(1, chatModel)

    // 默认跳过上下文构成。
    const lite = decodeAgyGenMetadata(genBlob)
    expect(lite?.responseModel).toBe('gemini-4-neon')
    expect(lite?.modelDisplayName).toBe('Gemini 4 Neon (XHigh)')
    expect(lite?.ttftMs).toBe(1250)
    expect(lite?.streamingDurationMs).toBe(4800)
    expect(lite?.extraMeta.model_enum).toBe('MODEL_PLACEHOLDER_M535')
    expect(lite?.contextWindow).toBeNull()

    // 启用 includeContext 后精确解码分组与子项。
    const full = decodeAgyGenMetadata(genBlob, { includeContext: true })
    expect(full?.contextWindow).toEqual({
      estimatedTokensUsed: 9520,
      maxContextTokens: 512_000,
      totalTokens: 9520,
      groups: [
        {
          name: 'Tools',
          type: 2,
          source: 1,
          tokens: 1520,
          children: [{ name: 'mcp_kettu_set_plan', tokens: 520 }],
        },
        {
          name: 'Chat Messages',
          type: 7,
          source: 0,
          tokens: 8000,
          children: [],
        },
      ],
    })
  })

  it('解析 parent_references UUID、模型名规范化与 pbtxt 标题（含八进制中文转义）', () => {
    const parentBlob = Buffer.concat([
      fStr(1, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      fStr(2, 'not-a-uuid'),
    ])
    expect(decodeAgyParentIds(parentBlob)).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])

    expect(
      resolveAgyModelName({
        responseModel: 'gemini-4-neon',
        model: 'MODEL_PLACEHOLDER_M535',
      }),
    ).toBe('gemini-4-neon')
    expect(
      resolveAgyModelName({
        model: 'MODEL_PLACEHOLDER_M402',
      }),
    ).toBe('claude-opus-5-5-high')
    expect(
      resolveAgyModelName({
        displayName: 'Gemini 4 Carbon (High)',
      }),
    ).toBe('gemini-4-carbon')

    expect(parsePbtxtTitle('title: "Fix Relay Switch"')).toBe('Fix Relay Switch')
    // "中文" 的 UTF-8 八进制转义：\344\270\255\346\226\207
    expect(parsePbtxtTitle('title: "\\344\\270\\255\\346\\226\\207标题"')).toBe('中文标题')
    expect(parsePbtxtTitle('other: "ignored"')).toBeNull()
  })
})
