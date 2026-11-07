// The Kettu account a client signs in to for the project's cloud services. Signing in is optional:
// everything else works without it.

/** Why the client is signed out although nobody signed it out here. */
export type SignedOutReason =
  /** This computer was signed out from the account page. */
  | 'account-page'
  /** Kettu's support team ended this computer's sign-in. */
  | 'admin'
  | 'disabled'
  /** A token was used twice, so the service signed the client out to protect the account. */
  | 'reused'
  | 'expired'
  /** The service no longer knows the sign-in, as after the account was deleted. */
  | 'invalid'

/** Why a sign-in through the browser did not finish. */
export type SignInFailure =
  /** Nobody finished it in the browser within the time the sign-in waits. */
  | 'timeout'
  /** The account service could not be reached. */
  | 'network'
  /** The account service refused the sign-in or answered with an error. */
  | 'service'
  | 'disabled'
  /** The account already has as many clients signed in as its plan allows. */
  | 'device-limit'
  /** This computer could not start it: no loopback port, or no browser. */
  | 'local'

export interface AccountProfile {
  id: string
  email: string
  name: string | null
  /** The picture main read, as a data: URL; null when there is none or it has not loaded. */
  avatar: string | null
}

/** The account's plan, with the limits the service checks. */
export interface AccountPlan {
  id: string
  /** In the app's language. */
  name: string
  /** How many clients may be signed in at once. */
  maxDevices: number
  storageBytes: number
}

/** What the account uses of its plan. */
export interface AccountUsage {
  /** Clients signed in now, this one included. */
  devices: number
  storageBytes: number
}

export type AccountStatus =
  | {
      state: 'signed-out'
      reason: SignedOutReason | null
      failure: SignInFailure | null
      /** The website's devices page, after a sign-in refused as `device-limit`. */
      devicesUrl?: string
    }
  /** The browser is open at the sign-in page, and main waits for it to hand back. */
  | { state: 'signing-in' }
  | {
      state: 'signed-in'
      account: AccountProfile
      /** The subscription's status as the service names it: `none` without one. */
      subscription: string
      /** Null until read, or from a service that does not report them. */
      plan: AccountPlan | null
      usage: AccountUsage | null
      /** The account page on the website, in the app's language. */
      manageUrl: string
      /** The sign-in is kept without the system's encryption, as on Linux without a keyring. */
      plainText: boolean
    }

export const SIGNED_OUT: AccountStatus = { state: 'signed-out', reason: null, failure: null }
