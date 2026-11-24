// Publishing to the Kettu Marketplace: the shapes of the account service's Marketplace API, the
// calls the agent host makes through main or the daemon, which alone hold the access token, and
// the drafts a host keeps of what was not published.

/** What a listing is: a skill, a workflow, a plugin of one harness, or an MCP server. */
// `plugin` is a harness's own plugin; `agent-plugin` a Kettu plugin, in the Agent Plugins format.
export type PublishKind = 'skill' | 'workflow' | 'plugin' | 'mcp-server' | 'agent-plugin'
export type PublishHarness = 'claude-code' | 'codex'
/** `unlisted`: taken out by its publisher; people who have it keep it and its updates. */
export type ListingVisibility = 'public' | 'private' | 'unlisted'
export type PublishVisibility = Exclude<ListingVisibility, 'unlisted'>

/** A version's limits, the same as the service's. */
export const PUBLISH_LIMITS = { files: 400, bytes: 10 * 1024 * 1024 } as const
export const LISTING_NAME_CHARS = 80
export const LISTING_DESCRIPTION_CHARS = 120
export const LISTING_ABOUT_CHARS = 4000
export const LISTING_NOTES_CHARS = 4000
/** How long a publish or unlisting card waits before what it asked is put off. */
export const MARKET_WAIT_MS = 10 * 60_000

/** A publisher's handle, and a listing's slug, which has the same shape. */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** A listing's opaque id, 10 base32 characters as a share's. */
export const LISTING_ID = /^[a-z2-7]{10}$/
/** A directory page's cursor as the service gives it, base64; passed on only as it came. */
export const DIRECTORY_CURSOR = /^[A-Za-z0-9+/=_-]{1,256}$/
export const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

export interface MarketPublisher {
  handle: string
  since: string
}

/**
 * One group of what an install adds, by a key the clients translate: `skills`, `commands`,
 * `agents`, `hooks` or `servers`; a workflow's are `steps`, `waits` and the `servers` and `skills`
 * its steps name; a plugin's are `skills`, `servers`, `commands`, `roles`, `workflows`, `themes`
 * and `templates`, each with the names of what it holds, and `script`, the permissions of a
 * script it runs, present only when it runs one.
 */
export interface PublishAdds {
  label: string
  items: string[]
}

/** The `manifest` part of a published version. */
export interface PublishManifest {
  slug: string
  name: string
  kind: PublishKind
  harness?: PublishHarness
  description: string
  about?: string
  version: string
  notes?: string
  visibility?: PublishVisibility
  /** For an MCP server, its `server.json`. */
  server?: Record<string, unknown>
  adds?: PublishAdds[]
  /** The harness of the agent that asked to publish, and its session's title. */
  agent?: string
  session?: string
}

/** One check the service ran on a version, kept with it for its publisher. */
export interface VersionCheck {
  /** Such as `paths`, `skill`, `plugin`, `secrets`, `package` or `remote`. */
  check: string
  /** What it checked, such as `SKILL.md` or `npm name@1.0.0`. */
  target?: string
  result: 'passed' | 'skipped'
  /** Why it was skipped. */
  note?: string
}

/**
 * A version's state: `held` is stored but listed only after a review, `refused` was not approved,
 * and `unknown` is any state this app does not know, treated as not live.
 */
export type VersionStatus = 'live' | 'withdrawn' | 'held' | 'refused' | 'unknown'

export interface MineVersion {
  version: string
  notes: string
  status: VersionStatus
  bytes: number
  files: number
  checks: VersionCheck[]
  agent?: string
  session?: string
  /** For a Kettu plugin: whether the version runs a script, and the permissions it declares. */
  script?: boolean
  permissions?: string[]
  /** Why a `refused` version was not approved, and when. */
  refusal?: { reason: string; at: string }
  publishedAt: string
}

/** A listing of the signed-in account's own. */
export interface MineListing {
  id: string
  handle: string
  slug: string
  name: string
  kind: PublishKind
  harness?: PublishHarness
  /** False for a Claude Code or Codex plugin, which takes no new versions and cannot be installed. */
  installable?: false
  description: string
  about?: string
  visibility: ListingVisibility
  /** Published by Kettu's own publisher. */
  official: boolean
  /** The version installs get. */
  current: string | null
  versions: MineVersion[]
  /** `days`: the last 30, oldest first. */
  installs: { total: number; week: number; days: number[] }
  takenDown: { reason: string; at: string } | null
  createdAt: string
  updatedAt: string
}

/** What a publish answers: the listing, and the version held for review when it is not listed yet. */
export type PublishResult = MineListing & { held?: string }

/**
 * The versions of a listing that wait for review or were not approved, which its publisher still
 * has to look at: a version not approved is left out once a later one is live or held.
 */
export function reviewVersions(listing: Pick<MineListing, 'versions'>): MineVersion[] {
  const { versions } = listing
  return versions.filter((version) => {
    if (version.status === 'held') return true
    if (version.status !== 'refused') return false
    return !versions.some(
      (other) =>
        (other.status === 'live' || other.status === 'held') &&
        compareVersions(other.version, version.version) > 0,
    )
  })
}

export interface MarketMine {
  publisher: MarketPublisher | null
  listings: MineListing[]
  storage: { bytes: number; limit: number }
}

/** A listing as anyone who may see it reads it. */
export interface MarketListing {
  id: string
  handle: string
  slug: string
  name: string
  kind: PublishKind
  harness?: PublishHarness
  installable?: false
  description: string
  about?: string
  visibility: ListingVisibility
  /** Published by Kettu's own publisher. */
  official: boolean
  version: string
  versions: string[]
  adds?: PublishAdds[]
  server?: Record<string, unknown>
  installs: number
  updatedAt: string
  mine: boolean
}

export interface MarketDirectory {
  items: MarketListing[]
  next: string | null
}

export interface VersionFile {
  path: string
  size: number
  sha256: string
}

export interface MarketVersionFiles {
  files: VersionFile[]
  server?: Record<string, unknown>
}

export interface ListingChange {
  name?: string
  description?: string
  about?: string
  visibility?: ListingVisibility
}

/** A problem a check found, the service's or the host's, with the file it is in. */
export interface MarketProblem {
  path?: string
  /** In English, as agents read it. */
  message: string
  /** The same in the user's language when that is not English; the interface shows it first. */
  text?: string
}

/**
 * Why a call failed: the service's error code, or `signed_out`, `network` or `unexpected`, with
 * what the service added to it.
 */
export interface MarketFailure {
  code: string
  status: number | null
  message: string
  problems?: MarketProblem[]
  bytes?: number
  limit?: number
}

/** A file of a version to publish, base64 since a forked host's messages are JSON. */
export interface PublishFileData {
  path: string
  data: string
}

/** A call of the Marketplace API that the agent host asks main or the daemon to make. */
export type MarketCall =
  | { kind: 'publisher' }
  | { kind: 'set-publisher'; handle: string }
  | { kind: 'mine' }
  | { kind: 'publish'; manifest: PublishManifest; files: PublishFileData[] }
  | { kind: 'update'; id: string; change: ListingChange }
  | { kind: 'withdraw'; id: string; version: string }
  | { kind: 'delete'; id: string }
  | { kind: 'directory'; q?: string; listingKind?: PublishKind; cursor?: string }
  | { kind: 'listing'; id: string }
  | { kind: 'version'; id: string; version: string }
  | { kind: 'file'; id: string; version: string; path: string }
  | { kind: 'install'; id: string; version: string; reason: 'install' | 'update' }
  | { kind: 'report'; id: string; message: string }

/** What each call answers; a file's bytes in base64. */
export interface MarketResults {
  publisher: MarketPublisher | null
  'set-publisher': MarketPublisher
  mine: MarketMine
  publish: PublishResult
  update: MineListing
  withdraw: MineListing
  delete: null
  directory: MarketDirectory
  listing: MarketListing
  version: MarketVersionFiles
  file: { data: string; sha256: string | null }
  install: null
  report: null
}

export type MarketCallAnswer = { result: unknown } | { error: MarketFailure }

/** The host's Kettu account while it is signed in with Kettu's services on; else none. */
export interface MarketAccount {
  name: string | null
  email: string
}

/**
 * Where a listing was last published from on this host, and the session each version came from,
 * kept on the host since the service knows neither.
 */
export interface PublishOrigin {
  path: string
  /** Session ids by version. */
  sessions: Record<string, string>
}

/** What Marketplace › Published shows of a host. */
export interface MarketPublished {
  /** Null while the host is signed out or Kettu's services are off, which hides the tab. */
  account: MarketAccount | null
  /** Null while signed out, or when the service could not be read. */
  mine: MarketMine | null
  /** Why the service could not be read. */
  error: string | null
  drafts: PublishDraft[]
  /** By listing id. */
  origins: Record<string, PublishOrigin>
}

/** A version the user put off, or the service refused, kept on the host to publish later. */
export interface PublishDraft {
  id: string
  /** The folder, or the MCP bundle, on the host. */
  path: string
  manifest: PublishManifest
  /** The listing it is a new version of. */
  listingId: string | null
  sessionId: string | null
  sessionTitle: string | null
  agentId: string | null
  createdAt: number
  /** Why the service refused it, after Publish; null for one put off. */
  error: string | null
  problems: MarketProblem[]
}

/** A handle or slug from a name: lowercase letters, digits and hyphens; empty when none is left. */
export function toHandle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '')
}

/** The publisher name a first publish suggests: the account's name, else its email's local part. */
export function suggestHandle(account: MarketAccount): string {
  for (const source of [account.name ?? '', account.email.split('@')[0] ?? '']) {
    const handle = toHandle(source)
    if (HANDLE.test(handle)) return handle
  }
  return ''
}

type Parts = [number, number, number, string | null]

function versionParts(version: string): Parts | null {
  const match = VERSION.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.slice(1) ?? null]
}

/** Orders versions by their numbers; a pre-release comes before its release. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a)
  const y = versionParts(b)
  if (!x || !y) return a.localeCompare(b)
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  }
  if (x[3] === y[3]) return 0
  if (x[3] === null) return 1
  if (y[3] === null) return -1
  return x[3].localeCompare(y[3], 'en', { numeric: true })
}

/** The patch after the highest of `versions`, which a version without one of its own takes. */
export function nextPatch(versions: readonly string[]): string {
  const highest = [...versions].sort(compareVersions).at(-1)
  const parts = highest ? versionParts(highest) : null
  if (!parts) return '1.0.0'
  // A pre-release's release is the next version up from it.
  return parts[3] !== null
    ? `${parts[0]}.${parts[1]}.${parts[2]}`
    : `${parts[0]}.${parts[1]}.${parts[2] + 1}`
}
