// Where each harness keeps when it compacts, and how the value is held there: tokens or a whole
// percent as is, or a fraction of the window. Claude Code's per-model windows and Codex's config
// go through their own paths; DeepSeek Harness keeps it in a row of its Cordis patch.

import { Document, isMap, isSeq, parseDocument, type YAMLMap } from 'yaml'
import type { HarnessId } from '@shared/thread'
import { t } from '../i18n'
import { isObject, writeTextAtomic } from '../settings-file'
import {
  readConfig,
  setConfigValue,
  valueAt,
  type ConfigFormat,
  type KeyPath,
} from './config-files'
import { readFile } from 'node:fs/promises'

export interface FileTarget {
  format: ConfigFormat
  key: KeyPath
  /** `fraction` when the file holds 0.85 for 85%. */
  stored?: 'fraction'
  /** The key of one model's value, for a harness that sets one per model. */
  modelKey?: (model: string) => KeyPath
  /** The object of per-model entries `modelKey` reads under, to list the models the file names. */
  modelsAt?: KeyPath
}

export const FILE_TARGETS: Readonly<Partial<Record<HarnessId, FileTarget>>> = {
  codebuddy: { format: 'json', key: ['autoCompactWindow'] },
  droid: { format: 'json', key: ['compactionTokenLimit'] },
  'mistral-vibe': { format: 'toml', key: ['auto_compact_threshold'] },
  vtcode: { format: 'toml', key: ['agent', 'harness', 'auto_compaction_threshold_tokens'] },
  devin: { format: 'json', key: ['agent', 'compaction_threshold_tokens'] },
  'crow-cli': { format: 'yaml', key: ['MAX_COMPACT_TOKENS'] },
  omp: { format: 'yaml', key: ['compaction', 'thresholdTokens'] },
  gemini: { format: 'json', key: ['model', 'compressionThreshold'], stored: 'fraction' },
  qwen: { format: 'json', key: ['context', 'autoCompactThreshold'], stored: 'fraction' },
  kimi: { format: 'toml', key: ['loop_control', 'compaction_trigger_ratio'], stored: 'fraction' },
  grok: { format: 'toml', key: ['session', 'auto_compact_threshold_percent'] },
  hermes: { format: 'yaml', key: ['compression', 'threshold'], stored: 'fraction' },
  goose: { format: 'yaml', key: ['GOOSE_AUTO_COMPACT_THRESHOLD'], stored: 'fraction' },
  kilo: { format: 'json', key: ['compaction', 'threshold_percent'] },
  codewhale: { format: 'toml', key: ['auto_compact_threshold_percent'] },
  opencode: { format: 'json', key: ['compaction', 'buffer'] },
  pi: {
    format: 'json',
    key: ['compaction', 'reserveTokens'],
    modelKey: (model) => ['compaction', 'modelOverrides', model, 'reserveTokens'],
    modelsAt: ['compaction', 'modelOverrides'],
  },
}

/** A value as the file holds it: a number in the setting's unit, or text Kettu shows as written. */
export type HeldValue = { value: number } | { other: string } | null

/** The unit's value from what the file holds; text such as OpenCode's `"15%"` is shown as is. */
export function heldValue(raw: unknown, stored: FileTarget['stored']): HeldValue {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { value: stored === 'fraction' ? Math.round(raw * 1000) / 10 : raw }
  }
  if (typeof raw === 'bigint') return { value: Number(raw) }
  if (typeof raw === 'string' && raw.trim() !== '') return { other: raw.trim() }
  return null
}

/** What the file is given for a value of the unit. */
export function storedValue(value: number, stored: FileTarget['stored']): number {
  return stored === 'fraction' ? Math.round(value) / 100 : value
}

export interface FileRead {
  all: HeldValue
  /** Each model the file names and what it holds for it; absent for a harness without models. */
  models?: Map<string, HeldValue>
}

export async function readFileTarget(file: string, target: FileTarget): Promise<FileRead> {
  const config = await readConfig(file, target.format)
  const read: FileRead = { all: heldValue(valueAt(config, target.key), target.stored) }
  if (target.modelKey && target.modelsAt) {
    const models = new Map<string, HeldValue>()
    const entries = valueAt(config, target.modelsAt)
    if (isObject(entries)) {
      for (const model of Object.keys(entries)) {
        const held = heldValue(valueAt(config, target.modelKey(model)), target.stored)
        if (held) models.set(model, held)
      }
    }
    read.models = models
  }
  return read
}

export async function writeFileTarget(
  file: string,
  target: FileTarget,
  model: string | null,
  value: number | null,
): Promise<void> {
  const key = model === null ? target.key : target.modelKey?.(model)
  if (!key) throw new Error(t('agentConfig.oneValue'))
  await setConfigValue(
    file,
    target.format,
    key,
    value === null ? undefined : storedValue(value, target.stored),
  )
}

// DeepSeek Harness: a row of its Cordis patch, `- id: compaction-basic` with a `config` of its own.

const DSH_ROW = 'compaction-basic'

function dshRow(doc: Document): YAMLMap | null {
  if (!isSeq(doc.contents)) return null
  for (const item of doc.contents.items) {
    if (isMap(item) && item.get('id') === DSH_ROW) return item
  }
  return null
}

async function readDshDocument(file: string): Promise<{ doc: Document; empty: boolean }> {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (text.trim() === '') return { doc: new Document([]), empty: true }
  const doc = parseDocument(text)
  if (doc.errors.length > 0 || !isSeq(doc.contents)) {
    throw new Error(t('agentConfig.pluginRows', { file }))
  }
  return { doc, empty: false }
}

export async function readDshThreshold(file: string): Promise<HeldValue> {
  const { doc } = await readDshDocument(file)
  const row = dshRow(doc)
  return row ? heldValue(row.getIn(['config', 'thresholdRatio']), 'fraction') : null
}

/**
 * A patch replaces the row's whole config, so only `thresholdRatio` is added or removed there and
 * the row's other keys stay; a row left with only its id goes.
 */
export async function writeDshThreshold(file: string, value: number | null): Promise<void> {
  const { doc } = await readDshDocument(file)
  const row = dshRow(doc)
  if (value === null) {
    if (!row || !row.hasIn(['config', 'thresholdRatio'])) return
    row.deleteIn(['config', 'thresholdRatio'])
    const config = row.get('config')
    if (isMap(config) && config.items.length === 0) row.delete('config')
    if (row.items.length === 1 && isSeq(doc.contents)) {
      doc.contents.items = doc.contents.items.filter((item) => item !== row)
    }
  } else if (row) {
    const config = row.get('config')
    if (config !== undefined && !isMap(config)) {
      throw new Error(t('agentConfig.rowNotMap', { row: DSH_ROW, file }))
    }
    row.setIn(['config', 'thresholdRatio'], storedValue(value, 'fraction'))
  } else {
    doc.add(
      doc.createNode({ id: DSH_ROW, config: { thresholdRatio: storedValue(value, 'fraction') } }),
    )
  }
  await writeTextAtomic(file, String(doc))
}
