// Cline's balance and plan (3.0.74), as its account service in `@cline/core` reads them: the
// user's credit balance and the current plan's period, with the account token Cline keeps in its
// provider settings. The balance endpoint follows Magpie,
// https://github.com/yetone/magpie/blob/3b643f3/internal/provider/cline_usage.go
// Copyright (c) 2026 yetone. MIT License.

import path from 'node:path'
import type { PlanLimit } from '@shared/agent-host'
import { t } from '../i18n'
import { balance, number, object, time, type VendorUsage } from './common'
import {
  askVendor,
  parseSignIn,
  readSignInFile,
  UsageReadError,
  variable,
  type SignInPlace,
} from './stored-sign-in'

const VENDOR = 'Cline'

export const CLINE_ORIGINS = ['https://api.cline.bot'] as const

/** What a reply of Cline's account service holds: its `data`, or the reply itself. */
function data(value: unknown): unknown {
  const root = object(value)
  if (root && typeof root.success === 'boolean') {
    if (!root.success) throw new UsageReadError(t('usageRead.refusedAccount', { vendor: VENDOR }))
    return root.data
  }
  return value
}

/** The credit balance, in millionths of a dollar. */
export function parseClineBalance(value: unknown): number | null {
  const amount = number(object(data(value))?.balance)
  return amount === null || amount < 0 ? null : amount / 1e6
}

export interface ClinePlan {
  tier?: string
  period: PlanLimit | null
}

/** The plan's name and its current period, which shows when it renews; no usage is told. */
export function parseClinePlan(value: unknown, now: number): ClinePlan {
  const current = object(data(value))
  const plan = object(current?.plan)
  const name = [plan?.displayName, plan?.name].find(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  )
  const end = time(current?.currentPeriodEnd)
  const yearly = typeof plan?.interval === 'string' && /^year/i.test(plan.interval)
  const period: PlanLimit | null =
    end === null
      ? null
      : {
          window: yearly ? 'annual' : 'monthly',
          label: yearly ? 'Annual' : 'Monthly',
          usedPercent: null,
          resetsAt: end,
          state: 'ok',
          observedAt: now,
        }
  return { ...(name ? { tier: name.trim() } : {}), period }
}

/** The account token in `providers.json`, with the `workos:` prefix Cline sends it with. */
async function storedToken(place: SignInPlace): Promise<string> {
  const dataDir =
    variable(place, 'CLINE_DATA_DIR') ??
    path.join(variable(place, 'CLINE_DIR') ?? path.join(place.home, '.cline'), 'data')
  const file =
    variable(place, 'CLINE_PROVIDER_SETTINGS_PATH') ??
    path.join(dataDir, 'settings', 'providers.json')
  const text = await readSignInFile(file)
  const settings =
    text === null ? null : object(object(object(parseSignIn(text))?.providers)?.cline)
  const auth = object(object(settings?.settings)?.auth)
  const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : ''
  if (!token) throw new UsageReadError(t('usageRead.notSignedIn', { vendor: VENDOR }))
  const expiresAt = number(auth?.expiresAt)
  if (expiresAt !== null && expiresAt > 0 && expiresAt <= place.now) {
    throw new UsageReadError(t('usageRead.signInExpired', { vendor: VENDOR }))
  }
  return token.toLowerCase().startsWith('workos:') ? token : `workos:${token}`
}

export async function readClineUsage(place: SignInPlace): Promise<VendorUsage> {
  const token = await storedToken(place)
  const ask = (route: string) =>
    askVendor(
      {
        vendor: VENDOR,
        origins: CLINE_ORIGINS,
        url: `${CLINE_ORIGINS[0]}/api/v1${route}`,
        headers: { authorization: `Bearer ${token}` },
      },
      place,
    )
  const me = object(data(await ask('/users/me')))
  const id = typeof me?.id === 'string' ? me.id.trim() : ''
  if (!id) throw new UsageReadError(t('usageRead.noAccount', { vendor: VENDOR }))
  const [credits, plan] = await Promise.all([
    ask(`/users/${encodeURIComponent(id)}/balance`).then(parseClineBalance),
    ask('/users/me/plan').then(
      (reply) => parseClinePlan(reply, place.now),
      (error: unknown): ClinePlan => {
        // An account without a plan has none to tell, only its credits.
        if (error instanceof UsageReadError && error.status === 404) return { period: null }
        throw error
      },
    ),
  ])
  if (credits === null && !plan.tier && !plan.period) {
    throw new UsageReadError(t('usageRead.noBalanceOrPlan', { vendor: VENDOR }))
  }
  return {
    ...(plan.tier ? { tier: plan.tier } : {}),
    limits: plan.period ? [plan.period] : [],
    balances: credits === null ? [] : [balance('Prepaid balance', credits, 'USD')],
  }
}
