// agy 的模式托管与完全访问（`--dangerously-skip-permissions`）：
// 1. 完全访问通过会话路由器带参数重启进程实现，底层 agy 保持 default；
// 2. Auto 模式同样由 Kettu 托管：底层 agy 保持 default，使所有文件修改、命令执行与 MCP 调用
//    均经过 Kettu 的风险引擎（agy-auto-policy），既消除高频误拦，又能真正拦截工作区内删核心文件与改 .env。

import { ANTIGRAVITY_FULL_ACCESS } from '@shared/agents'
import { isConfigValue, type ConfigOption, type PendingConfig } from '@shared/thread'
import { t } from '../i18n'
import { compareVersions } from '../versions'
import { MODE_OPTION } from './agy-plan'

export const FULL_ACCESS = ANTIGRAVITY_FULL_ACCESS
export const FULL_ACCESS_VERSION = '1.5.9'
/** Kettu 托管 Auto 模式的对外模式值。 */
export const AUTO_MODE = 'auto'
/** 托管 Auto 与完全访问时 agy 底层保持的模式：确保 Plan 模式不会继续只做计划，且 Auto 下每次操作均发给 Kettu 评估。 */
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

export interface AgyModeOptions {
  /** 当前是否处于完全访问（`--dangerously-skip-permissions`）。 */
  full: boolean
  /** 当前是否处于 Kettu 托管的 Auto 模式（底层 agy 运行在 default）。 */
  managedAuto?: boolean
  /** 是否在模式菜单末尾附加完全访问选项。 */
  includeFull?: boolean
  /** 挂起的模式切换状态（等待回合/后台命令结束或重启中）。 */
  pending?: PendingConfig | null
}

/**
 * 按当前托管状态生成展示给界面的 agy 配置列表：
 * - 若底层支持完全访问，则在模式列表末尾附加完全访问选项；
 * - 若当前为完全访问或 Kettu 托管 Auto，覆盖展示值为对应模式，避免被底层 default 冲掉；
 * - 同步附加或清除挂起切换状态。
 */
export function withAgyModes(
  config: readonly ConfigOption[],
  state: AgyModeOptions,
): ConfigOption[] {
  const { full, managedAuto = false, includeFull = true, pending = null } = state
  return config.map((option) => {
    if (option.id !== MODE_OPTION || option.type !== 'select') return option
    const choices = (option.choices ?? []).filter((choice) => choice.value !== FULL_ACCESS)
    // 若 agy 本身未列出 auto（如企业账号或无终端沙箱环境），由 Kettu 托管补齐 auto 选项。
    if (!choices.some((choice) => choice.value === AUTO_MODE)) {
      const insertAt = choices.findIndex((choice) => choice.value === 'plan')
      const autoChoice = {
        value: AUTO_MODE,
        name: t('antigravity.mode.auto.name'),
        description: t('antigravity.mode.auto.description'),
      }
      if (insertAt >= 0) choices.splice(insertAt, 0, autoChoice)
      else choices.push(autoChoice)
    }
    if (includeFull) {
      choices.push({
        value: FULL_ACCESS,
        name: t('antigravity.mode.fullAccess.name'),
        description: t('antigravity.mode.fullAccess.description'),
      })
    }
    const overrideValue = full ? FULL_ACCESS : managedAuto ? AUTO_MODE : undefined
    const next: ConfigOption = {
      ...option,
      choices,
      ...(overrideValue !== undefined ? { value: overrideValue } : {}),
    }
    if (pending) next.pending = pending
    else delete next.pending
    return next
  })
}

/** 构造带完全访问选项的配置列表，并同步附加或清除挂起切换状态（兼容旧调用签名）。 */
export function withFullAccess(
  config: readonly ConfigOption[],
  full: boolean,
  pending: PendingConfig | null = null,
): ConfigOption[] {
  return withAgyModes(config, { full, includeFull: true, pending })
}

const RESTORE_ORDER: readonly ConfigOption['category'][] = [
  'model',
  'model_config',
  'thought_level',
  'other',
]

/**
 * The session's values to set again on a new process, in order: the model first, then model
 * config and thought level (whose choices follow the model), then the rest; never the mode,
 * which the switch sets itself.
 */
export function restoreOrder(before: readonly ConfigOption[]): ConfigOption[] {
  const rank = (option: ConfigOption): number => {
    const index = RESTORE_ORDER.indexOf(option.category)
    return index >= 0 ? index : RESTORE_ORDER.length
  }
  return before.filter((option) => option.id !== MODE_OPTION).toSorted((a, b) => rank(a) - rank(b))
}

/** Whether `config` lacks `option`'s value and offers it. */
export function lacks(config: readonly ConfigOption[], option: ConfigOption): boolean {
  const now = config.find((candidate) => candidate.id === option.id)
  return !!now && now.value !== option.value && isConfigValue(now, option.value)
}
