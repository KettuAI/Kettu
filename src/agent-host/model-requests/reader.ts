// What each agent's reader of its own session records answers, and the pieces they share.

import {
  foldLongStrings,
  type ModelRequestRaw,
  type ModelRequestsOverview,
  type ModelRequestsPage,
} from '@shared/model-requests'
import { harnessOf, type AgentId, type HarnessId } from '@shared/thread'
import type { ByteSource } from '../usage/lines'
import { decodeRanges } from './claude-transcript'

/** Which session's record to read. */
export interface RequestsTarget {
  agentId: AgentId
  cwd: string
  acpSessionId: string
  configDir: string | null
  /** A sub-agent's parent, whose session folder keeps the sub-agent's file. */
  parentAcpSessionId: string | null
}

export interface ModelRequestsReader {
  /** Null when the agent keeps no record Kettu can read. */
  page(target: RequestsTarget, before: string | null): Promise<ModelRequestsPage | null>
  summary(target: RequestsTarget): Promise<ModelRequestsOverview | null>
  raw(target: RequestsTarget, raw: string, full: boolean): Promise<ModelRequestRaw>
}

/** The most Raw reads for one request, folded or not. */
const RAW_LIMIT = 64 << 20

/** Each harness's reader, and `others` for the agents that have none of their own. */
export function byHarness(
  readers: Partial<Record<HarnessId, ModelRequestsReader>>,
  others: ModelRequestsReader | null = null,
): ModelRequestsReader {
  const of = (target: RequestsTarget) => readers[harnessOf(target.agentId)] ?? others
  return {
    page: async (target, before) => (await of(target)?.page(target, before)) ?? null,
    summary: async (target) => (await of(target)?.summary(target)) ?? null,
    raw: (target, raw, full) => {
      const reader = of(target)
      if (!reader) return Promise.reject(new Error('This agent keeps no record Kettu reads'))
      return reader.raw(target, raw, full)
    },
  }
}

export function foldAll(records: unknown[], full: boolean): ModelRequestRaw {
  if (full) return { records, folded: false }
  const { value, folded } = foldLongStrings(records)
  return { records: value as unknown[], folded }
}

/** The records a page's `raw` handle names, read again from the source. */
export async function readRanges(
  source: ByteSource,
  raw: string,
  full: boolean,
): Promise<ModelRequestRaw> {
  const ranges = decodeRanges(raw)
  if (!ranges) throw new Error('Not a request of this session')
  const size = source.length ?? 0
  let total = 0
  for (const [start, end] of ranges) {
    if (end > size) throw new Error('The session file changed; open the request again')
    total += end - start
  }
  if (total > RAW_LIMIT) throw new Error('These records are too large to show')
  const records: unknown[] = []
  try {
    for (const [start, end] of ranges) {
      records.push(JSON.parse((await source.read(start, end - start)).toString('utf8')))
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('The session file changed; open the request again', { cause: error })
    }
    throw error
  }
  return foldAll(records, full)
}
