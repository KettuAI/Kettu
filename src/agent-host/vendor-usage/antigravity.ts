// Google Antigravity's plan and plan limits.
//
// The plan: agy's ACP mode names it in the `_meta` of its answers to `authenticate`,
// `session/new`, `session/load` and `session/resume` when signed in with Google, and declares
// `_meta.antigravity.tier` in `initialize`:
// `{ antigravity: { tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri } } }`.
//
// The limits: `agy acp` has no `/usage` command, so it would send one to the model. agy's print
// mode answers its read-only `/usage` and `/credits` itself, with its own sign-in, in no
// conversation and with no model request (1.5.9): `agy -p "/usage" --output-format json` gives
// `command.data.groups[]`, each `{ name, description: 'Models within this group: ...', buckets }`
// with `{ window: 'weekly' | '5h', remaining_fraction, reset_time }`, and `/credits` gives
// `command.data.remaining_credits`.

import path from 'node:path'
import type { PlanLimit, ProviderBalance } from '@shared/agent-host'
import { balance, number, object, percentLimit, time, type VendorUsage } from './common'

/** The version the plan was checked on, as agy names it in `initialize`; later ones keep it. */
export const ANTIGRAVITY_TIER_VERSION = '1.5.9'

/** The version agy's `/usage` and `/credits` replies were checked on; later ones keep them. */
export const ANTIGRAVITY_USAGE_VERSION = '1.5.9'

const answerTier = (meta: unknown) => object(object(object(meta)?.antigravity)?.tier)

/** The plan's name in an answer's `_meta`, or null when it names none. */
export function antigravityTier(meta: unknown): string | null {
  const tier = answerTier(meta)
  const name = typeof tier?.name === 'string' ? tier.name.trim() : ''
  return name || null
}

/**
 * 从套餐元数据中识别 Ultra 档位倍率（`5x` / `20x`），未命中时返回 null。
 * 用于填充账户卡片与账号菜单的 `AgentAccount.tier` 徽标。
 */
export function antigravityTierMultiple(meta: unknown): string | null {
  const tier = answerTier(meta)
  if (!tier) return null
  const id = typeof tier.id === 'string' ? tier.id.trim().toLowerCase() : ''
  const name = typeof tier.name === 'string' ? tier.name.trim() : ''
  const description = typeof tier.description === 'string' ? tier.description.trim() : ''
  const text = `${id} ${name} ${description}`
  if (/(?:^|[-_\s])5x(?:$|[-_\s])|ultra[-_]?lite/i.test(text)) return '5x'
  if (
    /(?:^|[-_\s])20x(?:$|[-_\s])/i.test(text) ||
    id === 'g1-ultra-tier' ||
    (/^g1-ultra(?:-[a-z0-9]+)?-tier$/i.test(id) && !/lite|5x/i.test(id))
  ) {
    return '20x'
  }
  return null
}

/**
 * The sign-in the plan in an answer's `_meta` shows, by its id: Google's personal plans (the free
 * tier and Google One's `g1-` AI plans) or Gemini Enterprise and Google Cloud ones (`gcp-`,
 * `business-`), the ids agy 1.5.9 knows. Null for an answer with no plan, which an API key or a
 * cloud project gives, or with one of an id Kettu does not know.
 */
export function antigravityTierSignIn(meta: unknown): 'oauth-personal' | 'oauth-business' | null {
  const id = answerTier(meta)?.id
  if (typeof id !== 'string') return null
  if (id === 'free-tier' || id.startsWith('g1-')) return 'oauth-personal'
  if (id.startsWith('gcp-') || id.startsWith('business-')) return 'oauth-business'
  return null
}

/** The sign-ins agy reads plan limits for: Google and Gemini Enterprise. */
export const ANTIGRAVITY_PLAN_SIGN_INS: readonly string[] = ['oauth-personal', 'oauth-business']

/**
 * What a plan limits read does for a sign-in: run agy's `/usage` on a Google or Gemini Enterprise
 * sign-in; nothing on an API key or a cloud project, whose usage is in Google AI Studio or Google
 * Cloud; and on one Kettu does not know, find it out first, since a signed-out agy answers
 * `/usage` by opening a browser to sign in.
 */
export function antigravityLimitsRead(method: string | null): 'read' | 'none' | 'unknown' {
  if (method === null) return 'unknown'
  return ANTIGRAVITY_PLAN_SIGN_INS.includes(method) ? 'read' : 'none'
}

/** Where agy 1.5.9 keeps the sign-in method its ACP mode uses, under the home folder. */
export function antigravityAuthStateFile(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'cache', 'acp-auth-state.json')
}

/**
 * The sign-in method agy last used, from the `methodId` of its
 * `~/.gemini/antigravity-cli/cache/acp-auth-state.json` (1.5.9); null when the file names none.
 * Only that field is read: the file holds no credential, and nothing else of it is kept.
 */
export function antigravitySignInMethod(text: string): string | null {
  try {
    const method = object(JSON.parse(text))?.methodId
    return typeof method === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(method) ? method : null
  } catch {
    return null
  }
}

/**
 * The method agy is signed in with: the Google sign-in its last answer's plan showed, since agy
 * names a plan only while signed in with Google; else Kettu's API key, which Kettu signs agy in
 * with; else the method its auth state file names, which only an ACP client's `authenticate`
 * writes. Null when none of them tells.
 */
export function antigravitySignIn(input: {
  answered: string | null
  file: string | null
  key: boolean
}): string | null {
  return input.answered ?? (input.key ? 'gemini-api-key' : input.file)
}

const WINDOWS: Readonly<Record<string, { window: string; label: string }>> = {
  '5h': { window: 'five_hour', label: '5-hour' },
  five_hour: { window: 'five_hour', label: '5-hour' },
  weekly: { window: 'seven_day', label: 'Weekly' },
  '7d': { window: 'seven_day', label: 'Weekly' },
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

const slug = (name: string): string =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('_')

/** The `command.data` of a successful print-mode reply to `command`; null for any other reply. */
function commandData(reply: unknown, command: string): Record<string, unknown> | null {
  const body = object(reply)
  const ran = object(body?.command)
  if (body?.status !== 'SUCCESS' || ran?.name !== command) return null
  return object(ran.data)
}

/** The error of a failed print-mode reply, as agy words it; null for any other reply. */
export function replyError(reply: unknown): string | null {
  const body = object(reply)
  if (body?.status !== 'ERROR') return null
  return typeof body.error === 'string' && body.error.trim() ? body.error.trim() : 'failed'
}

/**
 * The quota groups' windows in agy's `/usage` reply, each window per group as
 * `five_hour_<group>` or `seven_day_<group>` with the group's models; null for a reply that is not
 * a successful `/usage`. No groups is no limits; a window or value Kettu does not know gives none.
 */
export function parseAntigravityUsage(reply: unknown, now: number): VendorUsage | null {
  const data = commandData(reply, 'usage')
  if (!data) return null
  const groups = Array.isArray(data.groups) ? data.groups : []
  const limits: PlanLimit[] = []
  for (const value of groups) {
    const group = object(value)
    const name = typeof group?.name === 'string' ? group.name.trim() : ''
    if (!group || !name) continue
    const listed =
      typeof group.description === 'string'
        ? /^Models within this group:\s*(.+)$/i.exec(group.description.trim())
        : null
    const models = (listed?.[1] ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean)
    for (const item of Array.isArray(group.buckets) ? group.buckets : []) {
      const bucket = object(item)
      if (!bucket) continue
      const resetsAt = typeof bucket.reset_time === 'string' ? time(bucket.reset_time) : null
      const rawWindow = typeof bucket.window === 'string' ? bucket.window.trim().toLowerCase() : ''
      const kind =
        rawWindow !== ''
          ? WINDOWS[rawWindow]
          : resetsAt !== null
            ? resetsAt <= now + SIX_HOURS_MS
              ? WINDOWS['5h']
              : WINDOWS.weekly
            : undefined
      if (!kind) continue

      const rawLeft = bucket.remaining_fraction
      let left = number(rawLeft)
      // Proto3 序列化在剩余配额为 0 时可能省略默认值字段；当显式 disabled 或仅有未来重置时间时按 0% 剩余处理。
      if (left === null) {
        const omitted = rawLeft === undefined || rawLeft === null
        if (bucket.disabled === true || (omitted && resetsAt !== null && resetsAt > now)) {
          left = 0
        }
      }
      if (left === null || left < 0 || left > 1) continue

      const limit = percentLimit(
        `${kind.window}_${slug(name)}`,
        `${kind.label} · ${name}`,
        100 - left * 100,
        now,
        resetsAt,
      )
      limits.push(models.length > 0 ? { ...limit, models: [...models] } : limit)
    }
  }
  return { limits, balances: [] }
}

/** The G1 credits left in agy's `/credits` reply; null for a reply that is not one. */
export function parseAntigravityCredits(reply: unknown): ProviderBalance | null {
  const left = number(commandData(reply, 'credits')?.remaining_credits)
  return left === null || left < 0 ? null : balance('G1 credits', left, 'credits')
}
