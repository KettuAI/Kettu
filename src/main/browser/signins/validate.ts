// The window's arguments to the sign-ins calls, checked in main before anything is read: a browser
// Kettu knows, a profile named as a short string the worker matches against what it lists, and
// sites that are site names.

import { isSignInBrowserId, type SignInChoice, type SignInRequest } from '@shared/signins'
import { siteOf } from './sites'

/** More sites than a profile plausibly has sign-ins for. */
export const MAX_REQUESTED_SITES = 10_000
const MAX_PROFILE = 1_024

export function signInChoice(value: unknown): SignInChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('A sign-in choice must be an object')
  }
  const { browser, profile } = value as Record<string, unknown>
  if (!isSignInBrowserId(browser)) throw new Error(`Unknown browser "${String(browser)}"`)
  if (typeof profile !== 'string' || profile.length === 0 || profile.length > MAX_PROFILE) {
    throw new Error(`A profile must be a string of 1 to ${MAX_PROFILE} characters`)
  }
  if (profile.includes('\0')) throw new Error('A profile must not contain a NUL character')
  return { browser, profile }
}

/** A site's name as the sign-ins list gives it: a registrable domain, lowercase. */
export function signInSite(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw new Error('A site must be a string of 1 to 253 characters')
  }
  if (siteOf(value) !== value) throw new Error('A site must be a registrable domain')
  return value
}

export function signInRequest(value: unknown): SignInRequest {
  const choice = signInChoice(value)
  const { sites } = value as Record<string, unknown>
  if (!Array.isArray(sites) || sites.length === 0 || sites.length > MAX_REQUESTED_SITES) {
    throw new Error(`Sites must be a list of 1 to ${MAX_REQUESTED_SITES} sites`)
  }
  return { ...choice, sites: [...new Set(sites.map(signInSite))] }
}

/** The address a page shows, which an offer is asked for. */
export function offerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    throw new Error('An address must be a string of 1 to 8192 characters')
  }
  return value
}
