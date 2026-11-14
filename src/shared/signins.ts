// Bringing sign-ins from the user's own browsers into Kettu's: the browsers and profiles found on
// this computer, the sites that have sign-ins there, and what was brought. Only names, hosts and
// times cross to the window; cookie values stay in main.

/** A browser Kettu knows how to read, or lists to say why it cannot. */
export type SignInBrowserId = 'chrome' | 'edge' | 'brave' | 'arc' | 'firefox' | 'safari'

export const SIGN_IN_BROWSERS: readonly SignInBrowserId[] = [
  'chrome',
  'edge',
  'brave',
  'arc',
  'firefox',
  'safari',
]

export function isSignInBrowserId(value: unknown): value is SignInBrowserId {
  return typeof value === 'string' && (SIGN_IN_BROWSERS as readonly string[]).includes(value)
}

/**
 * Why a browser is listed but cannot be chosen: Safari keeps its cookies where only apps with
 * Full Disk Access read them, Chrome and Edge on Windows lock theirs to themselves, and on Linux
 * their key is in the system keyring.
 */
export type SignInUnavailable = 'safari' | 'windows-locked' | 'linux-keyring'

/** One profile of a browser and how many sites have sign-ins in it. */
export interface SignInProfile {
  /** The profile's folder as the browser names it; main only accepts one it listed. */
  id: string
  name: string
  /** The account the profile is signed in to, when the browser records one. */
  email: string | null
  sites: number
}

export interface SignInSource {
  browser: SignInBrowserId
  /** The browser's own name, such as "Google Chrome". */
  name: string
  /** The browser's icon from the system, as a PNG data URL; null where there is none. */
  icon: string | null
  /** Most recently used first; empty for a browser listed as unavailable. */
  profiles: SignInProfile[]
  unavailable: SignInUnavailable | null
  /** Whether macOS asks for the browser's key in the keychain before its sign-ins can be read. */
  keychain: boolean
}

/**
 * Where a site sits in the list: used in the last 30 days and picked for the user; email, banking
 * and single sign-on, left out unless picked; Google's, which cannot be brought; and the rest.
 */
export type SignInSiteGroup = 'recent' | 'held' | 'google' | 'other'

/** Why a site is held back: what it is. */
export type SignInSiteKind = 'email' | 'banking' | 'sso'

/** A site with sign-ins in a profile: its registrable domain and when it was last used. */
export interface SignInSite {
  site: string
  /** When a cookie of the site was last sent or set, in ms since the epoch. */
  lastUsed: number
  group: SignInSiteGroup
  kind: SignInSiteKind | null
}

/** A browser and profile to read, as the window names them. */
export interface SignInChoice {
  browser: SignInBrowserId
  profile: string
}

/** The sites chosen to bring from one profile. */
export interface SignInRequest extends SignInChoice {
  sites: string[]
}

/** What bringing sign-ins ended in. */
export type SignInResult =
  | { ok: true; sites: string[] }
  | {
      ok: false
      /**
       * `denied`: macOS was told Deny, or no answer came; `cancelled`: the user stopped it;
       * `unreadable`: the browser's cookies could not be read or decrypted.
       */
      reason: 'denied' | 'cancelled' | 'unreadable'
    }

/** A site brought from another browser, as Settings lists it. */
export interface BroughtSite {
  site: string
  browser: SignInBrowserId
  /** The profile's name when it was brought. */
  profile: string
  /** When it was brought, in ms since the epoch. */
  at: number
}

/** The sign-in one of the user's browsers has for the site a page shows, which Kettu's lacks. */
export interface SignInOffer {
  site: string
  browser: SignInBrowserId
  browserName: string
  profile: string
  profileName: string
  keychain: boolean
}
