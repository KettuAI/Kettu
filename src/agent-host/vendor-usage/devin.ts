// Devin's plan usage (3000.11.228), as its CLI's /usage asks `GetUserStatus`: the daily and weekly
// quota windows and the overage balance, with the key `devin auth login` keeps in
// `credentials.toml`.
// Follows Magpie's Devin plugin,
// https://github.com/magpie-community/plugins/blob/b35d4b3/packages/devin/index.mjs
// Copyright (c) 2026 magpie-community contributors. MIT License.

import path from 'node:path'
import type { PlanLimit } from '@shared/agent-host'
import { t } from '../i18n'
import { balance, number, object, percentLimit, time, type VendorUsage } from './common'
import {
  askVendor,
  readSignInFile,
  UsageReadError,
  variable,
  type SignInPlace,
} from './stored-sign-in'

const VENDOR = 'Devin'

export const DEVIN_ORIGINS = ['https://server.codeium.com'] as const

const CLIENT_VERSION = '3000.11.228'

/** The `key = "value"` lines of `credentials.toml`, which `devin auth login` writes. */
export function readCredentialLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(
      line,
    )
    if (match)
      out[match[1]!] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]!
  }
  return out
}

/**
 * The daily and weekly windows and the overage balance of a `GetUserStatus` reply; null when it
 * is not one. Its JSON leaves zeros out, so on a quota plan a window with a reset and no share
 * left is used up.
 */
export function parseDevinStatus(value: unknown, now: number): VendorUsage | null {
  const status = object(object(value)?.userStatus)
  if (!status) return null
  const plan = object(status.planStatus)
  const info = object(plan?.planInfo)
  const quota = info?.billingStrategy === 'BILLING_STRATEGY_QUOTA'
  const limits: PlanLimit[] = []
  for (const [id, label, left, reset, hidden] of [
    ['1_day', 'Daily', 'dailyQuotaRemainingPercent', 'dailyQuotaResetAtUnix', 'hideDailyQuota'],
    [
      'seven_day',
      'Weekly',
      'weeklyQuotaRemainingPercent',
      'weeklyQuotaResetAtUnix',
      'hideWeeklyQuota',
    ],
  ] as const) {
    if (info?.[hidden] === true) continue
    const resetsAt = time(plan?.[reset])
    const remaining = number(plan?.[left])
    if (remaining === null && !(quota && resetsAt !== null)) continue
    limits.push(percentLimit(id, label, 100 - (remaining ?? 0), now, resetsAt))
  }
  const micros = number(plan?.overageBalanceMicros)
  const balances =
    micros !== null && micros > 0 ? [balance('Extra usage', micros / 1e6, 'USD')] : []
  const name = info?.planName
  return {
    ...(typeof name === 'string' && name.trim() ? { tier: name.trim() } : {}),
    limits,
    balances,
  }
}

function credentialsFile(place: SignInPlace): string {
  const appData = place.platform === 'win32' ? variable(place, 'APPDATA') : undefined
  if (appData) return path.join(appData, 'devin', 'credentials.toml')
  const data = variable(place, 'XDG_DATA_HOME') ?? path.join(place.home, '.local', 'share')
  return path.join(data, 'devin', 'credentials.toml')
}

/** Reads the plan usage with the CLI's key, only from Devin's own server. */
export async function readDevinUsage(place: SignInPlace): Promise<VendorUsage> {
  const text = await readSignInFile(credentialsFile(place))
  const credentials = text === null ? {} : readCredentialLines(text)
  const key = credentials.windsurf_api_key?.trim()
  if (!key) throw new UsageReadError(t('usageRead.notSignedIn', { vendor: VENDOR }))
  const server = (
    variable(place, 'WINDSURF_API_SERVER_URL') ??
    credentials.api_server_url ??
    DEVIN_ORIGINS[0]
  ).replace(/\/+$/, '')
  // A sign-in to another server is not sent anywhere: that server is not a listed endpoint.
  if (server !== DEVIN_ORIGINS[0]) {
    throw new UsageReadError(t('usageRead.otherServer', { vendor: VENDOR }))
  }
  const reply = await askVendor(
    {
      vendor: VENDOR,
      origins: DEVIN_ORIGINS,
      url: `${server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: JSON.stringify({
        metadata: {
          ideName: 'devin-cli',
          ideVersion: CLIENT_VERSION,
          extensionName: 'devin-cli',
          extensionVersion: CLIENT_VERSION,
          apiKey: key,
          locale: 'en',
          os: place.platform === 'win32' ? 'windows' : place.platform,
        },
      }),
    },
    place,
  )
  const usage = parseDevinStatus(reply, place.now)
  if (!usage || (usage.limits.length === 0 && usage.balances.length === 0 && !usage.tier)) {
    throw new UsageReadError(t('usageRead.noPlanUsage', { vendor: VENDOR }))
  }
  return usage
}
