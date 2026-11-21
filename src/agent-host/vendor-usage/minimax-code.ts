// MiniMax Code's plan usage (0.7.0 to 0.7.7): an API key asks MiniMax's documented
// `/v1/token_plan/remains`, the account sign-in the `coding_plan/remains` MiniMax Code asks
// itself; both answer the same 5-hour and weekly windows. OpenCode's MiniMax plans read the first.
// The reply's reading follows Magpie,
// https://github.com/yetone/magpie/blob/3b643f3/internal/provider/planquota.go
// Copyright (c) 2026 yetone. MIT License.

import path from 'node:path'
import { parse } from 'yaml'
import type { PlanLimit } from '@shared/agent-host'
import { t } from '../i18n'
import { number, object, percentLimit, time, type VendorUsage } from './common'
import {
  askVendor,
  parseSignIn,
  readSignInFile,
  UsageReadError,
  variable,
  type SignInPlace,
} from './stored-sign-in'

const VENDOR = 'MiniMax Code'

const KEY_ORIGINS = { cn: 'https://api.minimaxi.com', en: 'https://api.minimax.io' } as const
const ACCOUNT_ORIGINS = {
  cn: 'https://www.minimaxi.com',
  en: 'https://platform.minimax.io',
} as const
/** The account's plan request as MiniMax Code 0.7 sends it, with a Bearer token. */
const ACCOUNT_REMAINS =
  '/v1/api/openplatform/coding_plan/remains?business=Agent&device_platform=mcode'

export const MINIMAX_CODE_ORIGINS = [
  ...Object.values(KEY_ORIGINS),
  ...Object.values(ACCOUNT_ORIGINS),
] as const

/**
 * The 5-hour and weekly windows of the plan's text and coding pool, told as what remains; null
 * when the reply is a refusal or has no such pool. Other pools, such as video, are metered apart.
 */
export function parseMiniMaxRemains(value: unknown, now: number): VendorUsage | null {
  const root = object(value)
  if (!root) return null
  const code = number(object(root.base_resp)?.status_code)
  if (code !== null && code !== 0) return null
  if (!Array.isArray(root.model_remains)) return null
  const rows = root.model_remains.flatMap((item) => {
    const row = object(item)
    return row ? [row] : []
  })
  // The token plan names its pool "general"; MiniMax Code takes the account's first.
  const pool =
    rows.find((row) => row.model_name === 'general') ??
    rows.find((row) => typeof row.model_name !== 'string' || !/video/i.test(row.model_name))
  if (!pool) return null
  const limits: PlanLimit[] = []
  const remaining = number(pool.current_interval_remaining_percent)
  if (remaining !== null) {
    limits.push(percentLimit('five_hour', '5-hour', 100 - remaining, now, time(pool.end_time)))
  }
  const weeklyRemaining = number(pool.current_weekly_remaining_percent)
  if (weeklyRemaining !== null) {
    limits.push(
      percentLimit('weekly', 'Weekly', 100 - weeklyRemaining, now, time(pool.weekly_end_time)),
    )
  }
  return limits.length > 0 ? { limits, balances: [] } : null
}

function regionOf(value: string | undefined): 'cn' | 'en' | null {
  if (!value) return null
  let host: string
  try {
    host = new URL(value).hostname
  } catch {
    return null
  }
  if (host === 'api.minimax.io') return 'en'
  if (host === 'api.minimaxi.com') return 'cn'
  return null
}

/** The API key in its `config.yaml`, with the region its base URL names. */
async function storedKey(dataDir: string): Promise<{ key: string; region: 'cn' | 'en' | null }> {
  const text = await readSignInFile(path.join(dataDir, 'config.yaml'))
  if (text === null) return { key: '', region: null }
  let config: unknown
  try {
    config = parse(text)
  } catch {
    throw new UsageReadError(t('usageRead.storedUnreadable'))
  }
  const api = object(object(config)?.minimax_api)
  const key = typeof api?.apiKey === 'string' ? api.apiKey.trim() : ''
  return { key, region: regionOf(typeof api?.baseURL === 'string' ? api.baseURL : undefined) }
}

/**
 * Reads the plan usage with what MiniMax Code keeps in its data folder (`MINIMAX_DATA_DIR`, else
 * `~/.minimax`): the API key in `config.yaml` first, else the account sign-in under `cli-auth`.
 * MiniMax Code also names the account's workspace in `X-Group-Id`, which it looks up with a further
 * request that is not a listed endpoint, so the account's read goes without it.
 */
export async function readMiniMaxCodeUsage(place: SignInPlace): Promise<VendorUsage> {
  const dataDir =
    variable(place, 'MINIMAX_DATA_DIR') ??
    variable(place, 'MAVIS_DATA_DIR') ??
    path.join(place.home, '.minimax')
  const region = variable(place, 'MAVIS_REGION') === 'en' ? 'en' : 'cn'
  const stored = await storedKey(dataDir)
  let reply: unknown
  if (stored.key) {
    reply = await askVendor(
      {
        vendor: VENDOR,
        origins: MINIMAX_CODE_ORIGINS,
        url: `${KEY_ORIGINS[stored.region ?? region]}/v1/token_plan/remains`,
        headers: { authorization: `Bearer ${stored.key}` },
      },
      place,
    )
  } else {
    const file = path.join(dataDir, 'cli-auth', 'prod', region, 'local-runtime.auth.json')
    const text = await readSignInFile(file)
    const auth = text === null ? null : object(object(parseSignIn(text))?.auth)
    const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : ''
    if (!token) throw new UsageReadError(t('usageRead.notSignedIn', { vendor: VENDOR }))
    reply = await askVendor(
      {
        vendor: VENDOR,
        origins: MINIMAX_CODE_ORIGINS,
        url: `${ACCOUNT_ORIGINS[region]}${ACCOUNT_REMAINS}`,
        headers: { authorization: `Bearer ${token}` },
      },
      place,
    )
  }
  const usage = parseMiniMaxRemains(reply, place.now)
  if (!usage) throw new UsageReadError(t('usageRead.noPlanUsage', { vendor: VENDOR }))
  return usage
}
