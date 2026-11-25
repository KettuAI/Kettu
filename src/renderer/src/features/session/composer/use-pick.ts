import { useState } from 'react'
import { booleanConfigValue, type ConfigOption } from '@shared/thread'

/** Asks the agent to change an option; resolves to whether it did. */
export type Select = (optionId: string, value: string | boolean) => Promise<boolean>

// How long a pick may stand in for the agent's value when no new value arrives.
const SETTLE_MS = 1500

/**
 * 下拉选项当前显示值：点击后立即乐观展示所选值，待服务端真实值生效、确认挂起、请求失败或超时后再同步。
 */
export function useSelectPick(
  option: ConfigOption | undefined,
  onSelect: Select,
): [string | undefined, (value: string) => void] {
  const actual = option === undefined ? undefined : String(option.value)
  const serverPending = option?.pending?.value ?? null
  const [pending, setPending] = useState<string | null>(null)
  const [seenPending, setSeenPending] = useState<string | null>(serverPending)
  if (pending !== null && pending === actual) setPending(null)
  if (seenPending !== serverPending) {
    setSeenPending(serverPending)
    // 服务端已明确接受为挂起/重启态，清掉本地乐观态，由提示条展示目标模式、按钮继续显示当前实际模式。
    if (pending !== null && pending === serverPending) setPending(null)
  }
  const shown = pending ?? actual
  const pick = (value: string) => {
    // 若存在服务端挂起态，重新点击当前已生效模式用于取消挂起，不能被拦截。
    if (!option || (value === shown && serverPending === null)) return
    const clear = () => setPending((p) => (p === value ? null : p))
    // 再次点击已经在挂起中的同一目标值时，短暂同步一次以重置底层组件内部状态，无需重复发请求。
    if (serverPending === value) {
      setPending(value)
      setTimeout(clear, 0)
      return
    }
    const optimistic = value !== actual
    if (optimistic) setPending(value)
    void onSelect(option.id, value).then((ok) => {
      if (!optimistic) return
      if (ok) setTimeout(clear, SETTLE_MS)
      else clear()
    })
  }
  return [shown, pick]
}

/**
 * The switches' values in effect, each flip shown at once until the agent's own value lands or
 * `SETTLE_MS` passes.
 */
export function useSwitchPicks(onSelect: Select) {
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const valueOf = (option: ConfigOption): boolean => {
    const actual = booleanConfigValue(option) === true
    return option.id in pending ? pending[option.id]! : actual
  }
  const settle = (id: string, value: boolean) =>
    setPending((p) => {
      if (p[id] !== value) return p
      const rest = { ...p }
      delete rest[id]
      return rest
    })
  const pick = (option: ConfigOption, value: boolean) => {
    setPending((p) => ({ ...p, [option.id]: value }))
    void onSelect(option.id, value).then((ok) => {
      if (ok) setTimeout(() => settle(option.id, value), SETTLE_MS)
      else settle(option.id, value)
    })
  }
  return { valueOf, pick }
}
