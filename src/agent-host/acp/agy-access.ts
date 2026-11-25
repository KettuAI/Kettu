// agy's own full access, `--dangerously-skip-permissions`, as a row after agy's modes. agy 1.5.9
// takes the flag only as its process starts, and the session router runs one process for each of
// its sessions: entering full access starts the session's process again with the flag, leaving it
// starts it again without, and each resumes the same session. agy then approves everything itself;
// Kettu approves nothing in its place. A new process comes back at agy's own model and in Default,
// which full access holds, so the session's values are set again.

import { ANTIGRAVITY_FULL_ACCESS } from '@shared/agents'
import { isConfigValue, type ConfigOption, type PendingConfig } from '@shared/thread'
import { t } from '../i18n'
import { compareVersions } from '../versions'
import { MODE_OPTION } from './agy-plan'

export const FULL_ACCESS = ANTIGRAVITY_FULL_ACCESS
export const FULL_ACCESS_VERSION = '1.5.9'
/** agy's own mode while its process runs with the flag: Plan mode would still only plan. */
export const HELD_MODE = 'default'
/**
 * Where the session router names the flag `agy acp --help` lists in `initialize`'s answer, and
 * where a request asks it to start the session's process with it (`SESSION_FLAG_META` there).
 */
export const SESSION_FLAG_META = 'sh.kettu/session-flag'

/** Whether agy offers full access: a version it was checked on, behind a router that found the flag. */
export function offersFullAccess(version: string | null, meta: unknown): boolean {
  if (version === null || compareVersions(version, FULL_ACCESS_VERSION) < 0) return false
  const flag = (meta as Record<string, unknown> | null | undefined)?.[SESSION_FLAG_META]
  return typeof flag === 'string' && flag !== ''
}

/** 构造带完全访问选项的配置列表，并同步附加或清除挂起切换状态。 */
export function withFullAccess(
  config: readonly ConfigOption[],
  full: boolean,
  pending: PendingConfig | null = null,
): ConfigOption[] {
  return config.map((option) => {
    if (option.id !== MODE_OPTION || option.type !== 'select') return option
    const choices = (option.choices ?? []).filter((choice) => choice.value !== FULL_ACCESS)
    choices.push({
      value: FULL_ACCESS,
      name: t('antigravity.mode.fullAccess.name'),
      description: t('antigravity.mode.fullAccess.description'),
    })
    const next: ConfigOption = {
      ...option,
      choices,
      ...(full ? { value: FULL_ACCESS } : {}),
    }
    if (pending) next.pending = pending
    else delete next.pending
    return next
  })
}

/**
 * The session's values to set again on a new process, in order: the model first, since the levels
 * it offers follow it, then the rest; never the mode, which the switch sets itself.
 */
export function restoreOrder(before: readonly ConfigOption[]): ConfigOption[] {
  return before
    .filter((option) => option.id !== MODE_OPTION)
    .toSorted((a, b) => Number(b.category === 'model') - Number(a.category === 'model'))
}

/** Whether `config` lacks `option`'s value and offers it. */
export function lacks(config: readonly ConfigOption[], option: ConfigOption): boolean {
  const now = config.find((candidate) => candidate.id === option.id)
  return !!now && now.value !== option.value && isConfigValue(now, option.value)
}
