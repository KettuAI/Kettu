// Antigravity (agy) 本地会话数据库 Protobuf Wire 只读解码器与 pbtxt 标题解析器。
// 仅按需提取 Kettu 所需的用量、上下文构成、原生耗时、重试与父子关系字段，
// 对超大 prompt 文本与工具定义载荷以 O(1) 游标跳过，无外部依赖。

export interface AgyProtoModelUsage {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingOutputTokens: number | null
  responseOutputTokens: number | null
  apiProvider: string | null
  requestId: string | null
}

export interface AgyProtoRetryInfo {
  error: string | null
  reasonCode: number | null
  delayMs: number | null
  usage: AgyProtoModelUsage | null
}

export interface AgyProtoStepMetadata {
  createdAtMs: number | null
  viewableAtMs: number | null
  finishedGeneratingAtMs: number | null
  completedAtMs: number | null
  modelUsage: AgyProtoModelUsage | null
  generatorModel: string | null
  stepIndex: number
  genMetadataIdx: number | null
  originCascadeId: string | null
  retries: AgyProtoRetryInfo[]
}

export interface AgyContextTokenChild {
  name: string
  tokens: number
}

export interface AgyContextTokenGroup {
  name: string
  type: number
  source: number
  tokens: number
  children: AgyContextTokenChild[]
}

export interface AgyContextWindowMetadata {
  estimatedTokensUsed: number
  maxContextTokens: number
  totalTokens: number
  groups: AgyContextTokenGroup[]
}

export interface AgyProtoGenMetadata {
  model: string | null
  responseModel: string | null
  modelDisplayName: string | null
  usage: AgyProtoModelUsage | null
  ttftMs: number | null
  streamingDurationMs: number | null
  extraMeta: Record<string, string>
  retries: AgyProtoRetryInfo[]
  contextWindow: AgyContextWindowMetadata | null
}

/** 已知静态模型枚举到标准模型名的映射（优先使用 gen_metadata 内的 responseModel）。 */
const KNOWN_MODEL_ENUMS: Readonly<Record<number, string>> = {
  246: 'gemini-2.5-pro',
  281: 'claude-4-sonnet',
  282: 'claude-4-sonnet-thinking',
  290: 'claude-4-opus',
  291: 'claude-4-opus-thinking',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  333: 'claude-sonnet-4-5',
  334: 'claude-sonnet-4-5-thinking',
  340: 'claude-haiku-4-5',
  341: 'claude-haiku-4-5-thinking',
  342: 'gpt-oss-120b-medium',
}

const KNOWN_API_PROVIDERS: Readonly<Record<number, string>> = {
  1: 'internal',
  3: 'google-vertex',
  24: 'google-gemini',
  26: 'anthropic-vertex',
  30: 'google-evergreen',
  31: 'openai-vertex',
}

/** 已知占位符到透明模型 ID 的回退映射（仅在 responseModel 缺失时兜底）。 */
const PLACEHOLDER_MODELS: Readonly<Record<string, string>> = {
  MODEL_PLACEHOLDER_M535: 'gemini-4-neon',
  MODEL_PLACEHOLDER_M537: 'gemini-4-neon',
  MODEL_PLACEHOLDER_M417: 'gemini-4-argon',
  MODEL_PLACEHOLDER_M418: 'gemini-4-argon',
  MODEL_PLACEHOLDER_M419: 'gemini-4-argon',
  MODEL_PLACEHOLDER_M681: 'gemini-4-argon',
  MODEL_PLACEHOLDER_M406: 'claude-opus-5-5-max',
  MODEL_PLACEHOLDER_M402: 'claude-opus-5-5-high',
  MODEL_PLACEHOLDER_M401: 'claude-opus-5-5-medium',
  MODEL_PLACEHOLDER_M400: 'claude-opus-5-5-low',
  MODEL_PLACEHOLDER_M368: 'claude-opus-5-5',
  MODEL_PLACEHOLDER_M407: 'claude-sonnet-5-5-max',
  MODEL_PLACEHOLDER_M405: 'claude-sonnet-5-5-high',
  MODEL_PLACEHOLDER_M404: 'claude-sonnet-5-5-medium',
  MODEL_PLACEHOLDER_M403: 'claude-sonnet-5-5-low',
  MODEL_PLACEHOLDER_M26: 'claude-opus-4-6-thinking',
  MODEL_PLACEHOLDER_M35: 'claude-sonnet-4-6',
  MODEL_PLACEHOLDER_M12: 'claude-opus-4-5-thinking',
  MODEL_PLACEHOLDER_M11: 'claude-opus-4-5',
  MODEL_PLACEHOLDER_M37: 'gemini-3.1-pro',
  MODEL_PLACEHOLDER_M36: 'gemini-3.1-pro',
  MODEL_PLACEHOLDER_M50: 'gemini-3.1-flash-lite',
  MODEL_PLACEHOLDER_M47: 'gemini-3-flash',
  MODEL_PLACEHOLDER_M18: 'gemini-3-flash',
  MODEL_GOOGLE_GEMINI_2_5_PRO: 'gemini-2.5-pro',
  MODEL_GOOGLE_GEMINI_2_5_FLASH: 'gemini-2.5-flash',
  MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING: 'gemini-2.5-flash',
  MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE: 'gemini-2.5-flash-lite',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'gpt-oss-120b-medium',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const utf8 = new TextDecoder('utf-8')

interface Cursor {
  off: number
}

function asBytes(raw: unknown): Uint8Array | null {
  if (!raw) return null
  if (raw instanceof Uint8Array) return raw
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  return null
}

function readVarint(buf: Uint8Array, cursor: Cursor, limit: number): bigint {
  if (cursor.off >= limit) return 0n
  const first = buf[cursor.off]!
  if (first < 0x80) {
    cursor.off += 1
    return BigInt(first)
  }
  let value = 0n
  let shift = 0n
  for (let i = 0; i < 10 && cursor.off < limit; i++) {
    const byte = buf[cursor.off++]!
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return BigInt.asUintN(64, value)
    shift += 7n
  }
  while (cursor.off < limit && (buf[cursor.off++]! & 0x80) !== 0) {
    // 跳过异常超长 varint 延续字节。
  }
  return BigInt.asUintN(64, value)
}

function readSubLimit(buf: Uint8Array, cursor: Cursor, limit: number): number {
  const len = Number(BigInt.asUintN(32, readVarint(buf, cursor, limit)))
  return Math.min(limit, cursor.off + len)
}

function readString(buf: Uint8Array, cursor: Cursor, limit: number): string {
  const end = readSubLimit(buf, cursor, limit)
  const text = end > cursor.off ? utf8.decode(buf.subarray(cursor.off, end)) : ''
  cursor.off = end
  return text
}

function skipField(buf: Uint8Array, cursor: Cursor, wireType: number, limit: number): void {
  if (wireType === 0) {
    readVarint(buf, cursor, limit)
  } else if (wireType === 1) {
    cursor.off = Math.min(limit, cursor.off + 8)
  } else if (wireType === 2) {
    cursor.off = readSubLimit(buf, cursor, limit)
  } else if (wireType === 5) {
    cursor.off = Math.min(limit, cursor.off + 4)
  } else if (wireType === 3) {
    while (cursor.off < limit) {
      const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, limit)))
      if ((tag & 7) === 4) break
      skipField(buf, cursor, tag & 7, limit)
    }
  } else if (wireType !== 4) {
    cursor.off = limit
  }
}

function readTimestampMs(buf: Uint8Array, cursor: Cursor, limit: number): number | null {
  const end = readSubLimit(buf, cursor, limit)
  let seconds = 0n
  let nanos = 0
  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 1 && wt === 0) seconds = BigInt.asIntN(64, readVarint(buf, cursor, end))
    else if (fn === 2 && wt === 0) nanos = Number(BigInt.asIntN(32, readVarint(buf, cursor, end)))
    else skipField(buf, cursor, wt, end)
  }
  cursor.off = end
  if (seconds <= 0n) return null
  return Number(seconds) * 1000 + Math.floor(nanos / 1_000_000)
}

function readDurationMs(buf: Uint8Array, cursor: Cursor, limit: number): number | null {
  const end = readSubLimit(buf, cursor, limit)
  let seconds = 0n
  let nanos = 0
  let sawField = false
  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 1 && wt === 0) {
      seconds = BigInt.asIntN(64, readVarint(buf, cursor, end))
      sawField = true
    } else if (fn === 2 && wt === 0) {
      nanos = Number(BigInt.asIntN(32, readVarint(buf, cursor, end)))
      sawField = true
    } else {
      skipField(buf, cursor, wt, end)
    }
  }
  cursor.off = end
  if (!sawField) return null
  const ms = Number(seconds) * 1000 + Math.round(nanos / 1_000_000)
  return ms >= 0 ? ms : null
}

function decodeModelEnum(raw: bigint): string | null {
  const num = Number(BigInt.asUintN(32, raw))
  if (!Number.isFinite(num) || num <= 0) return null
  if (KNOWN_MODEL_ENUMS[num]) return KNOWN_MODEL_ENUMS[num]!
  // Antigravity 新模型占位符枚举（>= 1000，如 1535 对应 MODEL_PLACEHOLDER_M535）。
  if (num >= 1000) {
    const key = `MODEL_PLACEHOLDER_M${num - 1000}`
    return PLACEHOLDER_MODELS[key] ?? key
  }
  return `MODEL_PLACEHOLDER_M${num}`
}

function decodeModelUsage(buf: Uint8Array, cursor: Cursor, limit: number): AgyProtoModelUsage {
  const end = readSubLimit(buf, cursor, limit)
  let model: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let thinkingOutputTokens: number | null = null
  let responseOutputTokens: number | null = null
  let apiProvider: string | null = null
  let requestId: string | null = null

  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 1 && wt === 0) {
      model = decodeModelEnum(readVarint(buf, cursor, end))
    } else if (fn === 1 && wt === 2) {
      const text = readString(buf, cursor, end).trim()
      if (text) model = text
    } else if (fn === 2 && wt === 0) {
      inputTokens = Number(BigInt.asUintN(64, readVarint(buf, cursor, end)))
    } else if (fn === 3 && wt === 0) {
      outputTokens = Number(BigInt.asUintN(64, readVarint(buf, cursor, end)))
    } else if (fn === 5 && wt === 0) {
      cacheReadTokens = Number(BigInt.asUintN(64, readVarint(buf, cursor, end)))
    } else if (fn === 6 && wt === 0) {
      const code = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
      apiProvider = KNOWN_API_PROVIDERS[code] ?? null
    } else if ((fn === 7 || fn === 11) && wt === 2) {
      const text = readString(buf, cursor, end).trim()
      if (text && !requestId) requestId = text
    } else if (fn === 9 && wt === 0) {
      const val = Number(BigInt.asUintN(64, readVarint(buf, cursor, end)))
      if (val > 0) thinkingOutputTokens = val
    } else if (fn === 10 && wt === 0) {
      const val = Number(BigInt.asUintN(64, readVarint(buf, cursor, end)))
      if (val > 0) responseOutputTokens = val
    } else {
      skipField(buf, cursor, wt, end)
    }
  }
  cursor.off = end

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingOutputTokens,
    responseOutputTokens,
    apiProvider,
    requestId,
  }
}

function decodeRetryInfo(buf: Uint8Array, cursor: Cursor, limit: number): AgyProtoRetryInfo {
  const end = readSubLimit(buf, cursor, limit)
  let error: string | null = null
  let reasonCode: number | null = null
  let delayMs: number | null = null
  let usage: AgyProtoModelUsage | null = null

  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 2 && wt === 2) {
      usage = decodeModelUsage(buf, cursor, end)
    } else if (fn === 3 && wt === 2) {
      const text = readString(buf, cursor, end).trim()
      if (text) error = text.length > 240 ? `${text.slice(0, 239)}…` : text
    } else if (fn === 5 && wt === 0) {
      const code = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
      if (code > 0) reasonCode = code
    } else if (fn === 7 && wt === 2) {
      delayMs = readDurationMs(buf, cursor, end)
    } else {
      skipField(buf, cursor, wt, end)
    }
  }
  cursor.off = end

  return { error, reasonCode, delayMs, usage }
}

/** 解码 `steps.metadata` 二进制块。 */
export function decodeAgyStepMetadata(raw: unknown, fallbackIdx: number): AgyProtoStepMetadata {
  const buf = asBytes(raw)
  if (!buf || buf.length === 0) {
    return {
      createdAtMs: null,
      viewableAtMs: null,
      finishedGeneratingAtMs: null,
      completedAtMs: null,
      modelUsage: null,
      generatorModel: null,
      stepIndex: fallbackIdx,
      genMetadataIdx: null,
      originCascadeId: null,
      retries: [],
    }
  }

  const cursor: Cursor = { off: 0 }
  const limit = buf.length
  let createdAtMs: number | null = null
  let viewableAtMs: number | null = null
  let finishedGeneratingAtMs: number | null = null
  let completedAtMs: number | null = null
  let modelUsage: AgyProtoModelUsage | null = null
  let generatorModel: string | null = null
  let stepIndex = fallbackIdx
  let genMetadataIdx: number | null = null
  let originCascadeId: string | null = null
  const retries: AgyProtoRetryInfo[] = []

  while (cursor.off < limit) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, limit)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 0) break
    if (fn === 1 && wt === 2) {
      createdAtMs = readTimestampMs(buf, cursor, limit)
    } else if (fn === 6 && wt === 2) {
      viewableAtMs = readTimestampMs(buf, cursor, limit)
    } else if (fn === 7 && wt === 2) {
      finishedGeneratingAtMs = readTimestampMs(buf, cursor, limit)
    } else if (fn === 8 && wt === 2) {
      completedAtMs = readTimestampMs(buf, cursor, limit)
    } else if (fn === 9 && wt === 2) {
      modelUsage = decodeModelUsage(buf, cursor, limit)
    } else if (fn === 11 && wt === 0) {
      generatorModel = decodeModelEnum(readVarint(buf, cursor, limit))
    } else if (fn === 20 && wt === 2) {
      const subEnd = readSubLimit(buf, cursor, limit)
      while (cursor.off < subEnd) {
        const sTag = Number(BigInt.asUintN(32, readVarint(buf, cursor, subEnd)))
        const sFn = sTag >>> 3
        const sWt = sTag & 7
        if (sFn === 2 && sWt === 0) {
          stepIndex = Number(BigInt.asUintN(32, readVarint(buf, cursor, subEnd)))
        } else if (sFn === 3 && sWt === 0) {
          genMetadataIdx = Number(BigInt.asUintN(32, readVarint(buf, cursor, subEnd)))
        } else if (sFn === 4 && sWt === 2) {
          const cid = readString(buf, cursor, subEnd).trim().toLowerCase()
          if (cid) originCascadeId = cid
        } else {
          skipField(buf, cursor, sWt, subEnd)
        }
      }
      cursor.off = subEnd
    } else if (fn === 28 && wt === 2) {
      retries.push(decodeRetryInfo(buf, cursor, limit))
    } else {
      skipField(buf, cursor, wt, limit)
    }
  }

  return {
    createdAtMs,
    viewableAtMs,
    finishedGeneratingAtMs,
    completedAtMs,
    modelUsage,
    generatorModel,
    stepIndex,
    genMetadataIdx,
    originCascadeId,
    retries,
  }
}

function decodeContextChild(buf: Uint8Array, cursor: Cursor, limit: number): AgyContextTokenChild {
  const end = readSubLimit(buf, cursor, limit)
  let name = ''
  let tokens = 0
  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 1 && wt === 2) {
      name = readString(buf, cursor, end)
    } else if ((fn === 3 || fn === 4) && wt === 0) {
      tokens = Number(BigInt.asIntN(32, readVarint(buf, cursor, end)))
    } else {
      skipField(buf, cursor, wt, end)
    }
  }
  cursor.off = end
  return { name, tokens: Math.max(0, tokens) }
}

function decodeContextGroup(buf: Uint8Array, cursor: Cursor, limit: number): AgyContextTokenGroup {
  const end = readSubLimit(buf, cursor, limit)
  let name = ''
  let type = 0
  let source = 0
  let tokens = 0
  const children: AgyContextTokenChild[] = []

  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 1 && wt === 2) {
      name = readString(buf, cursor, end)
    } else if (fn === 2 && wt === 0) {
      type = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    } else if (fn === 3 && wt === 0) {
      source = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    } else if (fn === 4 && wt === 0) {
      tokens = Number(BigInt.asIntN(32, readVarint(buf, cursor, end)))
    } else if (fn === 5 && wt === 2) {
      children.push(decodeContextChild(buf, cursor, end))
    } else {
      skipField(buf, cursor, wt, end)
    }
  }
  cursor.off = end
  return { name, type, source, tokens: Math.max(0, tokens), children }
}

function decodeContextWindowMeta(
  buf: Uint8Array,
  cursor: Cursor,
  limit: number,
): AgyContextWindowMetadata | null {
  const end = readSubLimit(buf, cursor, limit)
  let estimatedTokensUsed = 0
  let maxContextTokens = 0
  let totalTokens = 0
  const groups: AgyContextTokenGroup[] = []

  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 1 && wt === 0) {
      estimatedTokensUsed = Math.max(0, Number(BigInt.asIntN(32, readVarint(buf, cursor, end))))
    } else if (fn === 4 && wt === 0) {
      maxContextTokens = Math.max(0, Number(BigInt.asIntN(32, readVarint(buf, cursor, end))))
    } else if (fn === 3 && wt === 2) {
      const tbEnd = readSubLimit(buf, cursor, end)
      while (cursor.off < tbEnd) {
        const tbTag = Number(BigInt.asUintN(32, readVarint(buf, cursor, tbEnd)))
        const tbFn = tbTag >>> 3
        const tbWt = tbTag & 7
        if (tbFn === 1 && tbWt === 2) {
          groups.push(decodeContextGroup(buf, cursor, tbEnd))
        } else if (tbFn === 2 && tbWt === 0) {
          totalTokens = Math.max(0, Number(BigInt.asIntN(32, readVarint(buf, cursor, tbEnd))))
        } else {
          skipField(buf, cursor, tbWt, tbEnd)
        }
      }
      cursor.off = tbEnd
    } else {
      skipField(buf, cursor, wt, end)
    }
  }
  cursor.off = end

  if (groups.length === 0 && estimatedTokensUsed === 0 && maxContextTokens === 0) return null
  return {
    estimatedTokensUsed,
    maxContextTokens,
    totalTokens: totalTokens > 0 ? totalTokens : estimatedTokensUsed,
    groups,
  }
}

function decodeStringMapEntry(buf: Uint8Array, cursor: Cursor, limit: number): [string, string] {
  const end = readSubLimit(buf, cursor, limit)
  let key = ''
  let val = ''
  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 1 && wt === 2) key = readString(buf, cursor, end)
    else if (fn === 2 && wt === 2) val = readString(buf, cursor, end)
    else skipField(buf, cursor, wt, end)
  }
  cursor.off = end
  return [key, val]
}

function decodeChatModel(
  buf: Uint8Array,
  cursor: Cursor,
  limit: number,
  includeContext: boolean,
): AgyProtoGenMetadata {
  const end = readSubLimit(buf, cursor, limit)
  let model: string | null = null
  let responseModel: string | null = null
  let modelDisplayName: string | null = null
  let usage: AgyProtoModelUsage | null = null
  let ttftMs: number | null = null
  let streamingDurationMs: number | null = null
  const extraMeta: Record<string, string> = {}
  const retries: AgyProtoRetryInfo[] = []
  let contextWindow: AgyContextWindowMetadata | null = null

  while (cursor.off < end) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, end)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 0) break
    if (fn === 3 && wt === 0) {
      model = decodeModelEnum(readVarint(buf, cursor, end))
    } else if (fn === 4 && wt === 2) {
      usage = decodeModelUsage(buf, cursor, end)
    } else if (fn === 9 && wt === 2 && includeContext) {
      const csEnd = readSubLimit(buf, cursor, end)
      while (cursor.off < csEnd) {
        const csTag = Number(BigInt.asUintN(32, readVarint(buf, cursor, csEnd)))
        const csFn = csTag >>> 3
        const csWt = csTag & 7
        if (csFn === 10 && csWt === 2) {
          contextWindow = decodeContextWindowMeta(buf, cursor, csEnd)
        } else {
          skipField(buf, cursor, csWt, csEnd)
        }
      }
      cursor.off = csEnd
    } else if (fn === 11 && wt === 2) {
      ttftMs = readDurationMs(buf, cursor, end)
    } else if (fn === 12 && wt === 2) {
      streamingDurationMs = readDurationMs(buf, cursor, end)
    } else if (fn === 17 && wt === 2) {
      retries.push(decodeRetryInfo(buf, cursor, end))
    } else if (fn === 19 && wt === 2) {
      const text = readString(buf, cursor, end).trim()
      if (text) responseModel = text
    } else if (fn === 20 && wt === 2) {
      const [k, v] = decodeStringMapEntry(buf, cursor, end)
      if (k) extraMeta[k] = v
    } else if (fn === 21 && wt === 2) {
      const text = readString(buf, cursor, end).trim()
      if (text) modelDisplayName = text
    } else {
      skipField(buf, cursor, wt, end)
    }
  }
  cursor.off = end

  return {
    model,
    responseModel,
    modelDisplayName,
    usage,
    ttftMs,
    streamingDurationMs,
    extraMeta,
    retries,
    contextWindow,
  }
}

/** 解码 `gen_metadata.data` 二进制块；默认跳过上下文与消息大载荷。 */
export function decodeAgyGenMetadata(
  raw: unknown,
  options: { includeContext?: boolean } = {},
): AgyProtoGenMetadata | null {
  const buf = asBytes(raw)
  if (!buf || buf.length === 0) return null
  const cursor: Cursor = { off: 0 }
  const limit = buf.length
  const includeContext = options.includeContext === true

  while (cursor.off < limit) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, limit)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 0) break
    if (fn === 1 && wt === 2) {
      return decodeChatModel(buf, cursor, limit, includeContext)
    }
    skipField(buf, cursor, wt, limit)
  }
  return null
}

/** 从 `parent_references.data` 中提取引用的父会话 UUID 列表。 */
export function decodeAgyParentIds(raw: unknown): string[] {
  const buf = asBytes(raw)
  if (!buf || buf.length === 0) return []
  const cursor: Cursor = { off: 0 }
  const limit = buf.length
  const ids = new Set<string>()

  while (cursor.off < limit) {
    const tag = Number(BigInt.asUintN(32, readVarint(buf, cursor, limit)))
    const fn = tag >>> 3
    const wt = tag & 7
    if (fn === 0) break
    if (wt === 2) {
      const text = readString(buf, cursor, limit).trim().toLowerCase()
      if (UUID_RE.test(text)) ids.add(text)
    } else {
      skipField(buf, cursor, wt, limit)
    }
  }
  return [...ids]
}

/** 综合 responseModel、枚举占位符与展示名称，解析可用于统计与计价的模型 ID。 */
export function resolveAgyModelName(input: {
  responseModel?: string | null
  model?: string | null
  extraModelEnum?: string | null
  displayName?: string | null
}): string | null {
  const clean = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')
  const response = clean(input.responseModel)
  if (response && !response.startsWith('MODEL_PLACEHOLDER_')) return response

  const candidates = [clean(input.model), clean(input.extraModelEnum), response]
  for (const cand of candidates) {
    if (!cand) continue
    if (PLACEHOLDER_MODELS[cand]) return PLACEHOLDER_MODELS[cand]!
    if (!cand.startsWith('MODEL_PLACEHOLDER_') && !cand.startsWith('MODEL_')) return cand
  }

  // 当只有可读展示名（如 "Gemini 4 Neon (XHigh)"）时规整为可读 slug。
  const display = clean(input.displayName)
  if (display) {
    const base = display.replace(/\s*\([^)]*\)\s*$/, '').trim()
    if (base) {
      return base
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, '')
    }
  }
  return candidates.find(Boolean) ?? null
}

/** 反转义 prototext 字符串字面量（支持 UTF-8 原文与 \ddd 八进制 / \xHH 字节转义）。 */
function unescapePbtxt(raw: string): string {
  if (!raw.includes('\\')) return raw
  const bytes: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch !== '\\' || i + 1 >= raw.length) {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      continue
    }
    const next = raw[++i]!
    if (next >= '0' && next <= '7') {
      let oct = next
      if (i + 1 < raw.length && raw[i + 1]! >= '0' && raw[i + 1]! <= '7') oct += raw[++i]!
      if (i + 1 < raw.length && raw[i + 1]! >= '0' && raw[i + 1]! <= '7') oct += raw[++i]!
      bytes.push(parseInt(oct, 8) & 0xff)
    } else if ((next === 'x' || next === 'X') && i + 2 < raw.length) {
      const hex = raw.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        i += 2
      } else {
        bytes.push(next.charCodeAt(0))
      }
    } else if (next === 'n') {
      bytes.push(0x0a)
    } else if (next === 'r') {
      bytes.push(0x0d)
    } else if (next === 't') {
      bytes.push(0x09)
    } else {
      for (const b of Buffer.from(next, 'utf8')) bytes.push(b)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 解析 `annotations/<sessionId>.pbtxt` 中的会话标题。 */
export function parsePbtxtTitle(text: string): string | null {
  if (!text) return null
  const match = /(?:^|\r?\n)\s*title\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text)
  if (match?.[1] !== undefined) {
    const title = unescapePbtxt(match[1]).trim()
    return title || null
  }
  const single = /(?:^|\r?\n)\s*title\s*:\s*'((?:\\.|[^'\\])*)'/.exec(text)
  if (single?.[1] !== undefined) {
    const title = unescapePbtxt(single[1]).trim()
    return title || null
  }
  return null
}
