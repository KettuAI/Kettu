// An agent's auto-compact setting as its page shows it: the value for every model and, for a
// harness that sets one per model, a row for each model it lists or its file names.

import type { AutoCompactChange, AutoCompactRow, AutoCompactSettings } from '@shared/agent-host'
import { compactSpec, inCompactRange, type CompactSpec } from '@shared/auto-compact'
import type { ConfigOption, HarnessId } from '@shared/thread'
import {
  listedModels,
  readClaudeSettings,
  writeClaudeSetting,
  type ListedModel,
} from '../claude/user-settings'
import { t } from '../i18n'
import type { CodexRequest } from '../marketplace/codex-plugins'
import { versionAtLeast } from '../versions'
import {
  FILE_TARGETS,
  readDshThreshold,
  readFileTarget,
  writeDshThreshold,
  writeFileTarget,
  type HeldValue,
} from './targets'

const MAX_MODEL_CHARS = 256
const CODEX_KEY = 'model_auto_compact_token_limit'

export interface CompactPlace {
  harness: HarnessId
  /** The file the setting is kept in; unused for Codex, which writes its own. */
  file: string
  version: string | null
  config: readonly ConfigOption[] | undefined
  codex?: () => Promise<CodexRequest>
}

function specOf(harness: HarnessId): CompactSpec {
  const spec = compactSpec(harness)
  if (!spec) throw new Error(t('agentConfig.noAutoCompact'))
  return spec
}

function perModel(spec: CompactSpec, version: string | null): boolean {
  if (!spec.perModel) return false
  return spec.perModel.since === undefined || versionAtLeast(version, spec.perModel.since)
}

/** The models a harness other than Claude Code lists, by the option value its file keys them by. */
function optionModels(config: readonly ConfigOption[] | undefined): ListedModel[] {
  const option = config?.find((o) => o.category === 'model' && o.type === 'select')
  const seen = new Set<string>()
  const models: ListedModel[] = []
  for (const choice of option?.choices ?? []) {
    if (choice.shownAs || seen.has(choice.value)) continue
    seen.add(choice.value)
    models.push({ id: choice.value, name: choice.name })
  }
  return models
}

function split(held: HeldValue): { value: number | null; other: string | null } {
  if (!held) return { value: null, other: null }
  return 'value' in held ? { value: held.value, other: null } : { value: null, other: held.other }
}

function settings(
  spec: CompactSpec,
  file: string | null,
  all: HeldValue,
  models: AutoCompactRow[] | null,
): AutoCompactSettings {
  const { value, other } = split(all)
  return {
    unit: spec.unit,
    min: spec.min,
    max: spec.max,
    all: value,
    allOther: other,
    models,
    file,
  }
}

export async function readAutoCompact(place: CompactPlace): Promise<AutoCompactSettings> {
  const spec = specOf(place.harness)
  if (place.harness === 'claude-code') {
    const read = await readClaudeSettings(place.file, listedModels(place.config))
    return settings(
      spec,
      place.file,
      read.defaultWindow === null ? null : { value: read.defaultWindow },
      read.compact.map((row) => ({
        model: row.model,
        name: row.name,
        value: row.window,
        other: null,
      })),
    )
  }
  if (place.harness === 'codex') {
    const request = await place.codex!()
    const read = await request<{ config: Record<string, unknown> }>('config/read', {})
    const raw = read.config[CODEX_KEY]
    return settings(spec, null, typeof raw === 'number' ? { value: raw } : null, null)
  }
  if (place.harness === 'deepseek') {
    return settings(spec, place.file, await readDshThreshold(place.file), null)
  }
  const target = FILE_TARGETS[place.harness]!
  const read = await readFileTarget(place.file, target)
  if (!perModel(spec, place.version) || !read.models) {
    return settings(spec, place.file, read.all, null)
  }
  const listed = optionModels(place.config)
  const rows: AutoCompactRow[] = listed.map((model) => ({
    model: model.id,
    name: model.name,
    ...split(read.models?.get(model.id) ?? null),
  }))
  for (const [model, held] of read.models) {
    if (!listed.some((item) => item.id === model)) rows.push({ model, name: null, ...split(held) })
  }
  return settings(spec, place.file, read.all, rows)
}

/** Checks a change before anything is written, so only a model name and a value in range are. */
export function checkAutoCompact(
  harness: HarnessId,
  version: string | null,
  change: AutoCompactChange,
): AutoCompactChange {
  const spec = specOf(harness)
  const model = change.model === null ? null : change.model.trim()
  if (model !== null) {
    if (!perModel(spec, version)) throw new Error(t('agentConfig.oneValue'))
    if (model.length === 0 || model.length > MAX_MODEL_CHARS || /\s/.test(model)) {
      throw new Error(t('agentConfig.modelOneWord'))
    }
  }
  if (change.value !== null && !inCompactRange(spec, change.value)) {
    throw new Error(t('agentConfig.wholeNumber', { min: spec.min, max: spec.max }))
  }
  return { model, value: change.value }
}

export async function writeAutoCompact(
  place: CompactPlace,
  input: AutoCompactChange,
): Promise<void> {
  const change = checkAutoCompact(place.harness, place.version, input)
  if (place.harness === 'claude-code') {
    await writeClaudeSetting(place.file, { setting: 'autoCompactWindow', ...change })
  } else if (place.harness === 'codex') {
    const request = await place.codex!()
    await request('config/value/write', {
      keyPath: CODEX_KEY,
      value: change.value,
      mergeStrategy: 'replace',
    })
  } else if (place.harness === 'deepseek') {
    await writeDshThreshold(place.file, change.value)
  } else {
    await writeFileTarget(place.file, FILE_TARGETS[place.harness]!, change.model, change.value)
  }
}
