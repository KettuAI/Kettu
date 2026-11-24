// What Marketplace › Published works out from what the host answered: its item keys, a listing's
// tile, where a version came from, the days of its installs and asking an agent to publish.

import { Globe02Icon, SquareLock02Icon, ViewOffSlashIcon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import type {
  ListingVisibility,
  MineListing,
  PublishDraft,
  PublishHarness,
  PublishKind,
} from '@shared/market-publish'
import type { HarnessId } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import {
  flushDraft,
  NEW_SESSION_DRAFT,
  readDraft,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { hostPath, onHost } from '@renderer/lib/host-paths'
import { AGENT_NAMES } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openNewSession, openSession } from '@renderer/stores/view'
import { homeShort } from './model'
import type { ItemKind } from './rows'
import { communitySubject, type TileSubject } from './tile-art'

export { KETTU_ITEM, publishedIdOf, publishedItem } from './published-keys'

export const VISIBILITY_ICON: Record<ListingVisibility, IconSvgElement> = {
  public: Globe02Icon,
  private: SquareLock02Icon,
  unlisted: ViewOffSlashIcon,
}

export function kindOf(kind: PublishKind): ItemKind {
  return kind === 'mcp-server' ? 'mcp' : kind === 'agent-plugin' ? 'plugin' : kind
}

/** A listing's tile, as the Community section draws it; a draft of a new one goes by its slug. */
export function listingSubject(listing: {
  id?: string | null
  kind: PublishKind
  harness?: PublishHarness | null
  slug: string
}): TileSubject {
  return communitySubject({
    id: listing.id ?? listing.slug,
    kind: listing.kind,
    slug: listing.slug,
    ...(listing.harness ? { harness: listing.harness } : {}),
  })
}

/** A Claude Code or Codex plugin the account published, which takes no new versions. */
export function isClosed(listing: Pick<MineListing, 'kind' | 'installable'>): boolean {
  return listing.kind === 'plugin' || listing.installable === false
}

export function listingName(listing: Pick<MineListing, 'handle' | 'slug'>): string {
  return `@${listing.handle}/${listing.slug}`
}

/** A harness's name, for the agent a version came from. */
export function harnessName(harness: string | undefined | null): string | null {
  if (!harness) return null
  return (AGENT_NAMES as Record<string, string | undefined>)[harness] ?? harness
}

export function isHarness(harness: string | undefined | null): harness is HarnessId {
  return !!harness && harness in AGENT_NAMES
}

/** A listing's version the service refused, kept as a draft, that waits for a fix. */
export function refusedDraft(drafts: PublishDraft[], listingId: string): PublishDraft | null {
  return drafts.find((d) => d.listingId === listingId && d.error !== null) ?? null
}

/** A session of the host, when the window still lists it. */
export function knownSession(sessionId: string | null | undefined) {
  if (!sessionId) return null
  return useSessionsStore.getState().byId[sessionId] ?? null
}

export function openKnownSession(sessionId: string | null | undefined): void {
  const session = knownSession(sessionId)
  if (session) openSession(session.id, session.projectPath)
}

/** Whether `folder` is `parent` or inside it, by either separator. */
function within(folder: string, parent: string): boolean {
  if (folder === parent) return true
  const base = parent.replace(/[/\\]+$/, '')
  return folder.startsWith(`${base}/`) || folder.startsWith(`${base}\\`)
}

/**
 * A folder of the host as Published shows it: from the project it is in, with the project's name
 * and window path, or with `~` for the home folder.
 */
export function folderShown(
  hostId: string | null,
  folder: string,
): { path: string; project: string | null; projectPath: string | null } {
  const inProject = useProjectsStore
    .getState()
    .projects.map((project) => ({ project, own: hostPath(project.path) }))
    .filter(({ project, own }) => onHost(hostId, own) === project.path && within(folder, own))
    .sort((a, b) => b.own.length - a.own.length)[0]
  if (inProject) {
    const rest = folder.slice(inProject.own.length).replace(/^[/\\]+/, '')
    return {
      path: rest.replace(/\\/g, '/') || '.',
      project: inProject.project.name,
      projectPath: inProject.project.path,
    }
  }
  return { path: homeShort(folder), project: null, projectPath: null }
}

const DAY_MS = 86_400_000

/** The UTC day a time falls on, counted from the epoch, as the service counts installs. */
function utcDay(at: number): number {
  return Math.floor(at / DAY_MS)
}

/**
 * Each day of the last 30 that a version was published on, by its place in `days` (oldest first,
 * today last), the highest version of a day winning. A version held or not approved was not
 * published.
 */
export function releaseDays(
  listing: Pick<MineListing, 'versions'>,
  length: number,
  now = Date.now(),
): Map<number, string> {
  const today = utcDay(now)
  const marks = new Map<number, string>()
  for (const version of [...listing.versions].reverse()) {
    if (version.status !== 'live' && version.status !== 'withdrawn') continue
    const at = Date.parse(version.publishedAt)
    if (Number.isNaN(at)) continue
    const index = length - 1 - (today - utcDay(at))
    if (index >= 0 && index < length) marks.set(index, version.version)
  }
  return marks
}

/** The date of the day at `index` of `length` days that end today. */
export function dayAt(index: number, length: number, now = Date.now()): number {
  return (utcDay(now) - (length - 1 - index)) * DAY_MS
}

/** Round grid lines for a bar chart whose tallest bar is `top`: the step, and the plot's height. */
export function chartScale(top: number): { step: number; max: number } {
  const half = Math.max(top, 1) / 2
  // Installs are whole numbers, so the grid never steps by less than one.
  const power = Math.max(1, 10 ** Math.floor(Math.log10(half)))
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= half) ?? half
  return { step, max: Math.max(top, step * 2) * 1.15 }
}

/** New session with a message asking the agent to publish, in the project given or the selected one. */
export function askAgent(text: string, projectPath: string | null): void {
  const draft = readDraft(NEW_SESSION_DRAFT)
  writeDraft(NEW_SESSION_DRAFT, draft.trim() ? `${draft}\n\n${text}` : text)
  flushDraft(NEW_SESSION_DRAFT)
  openNewSession(projectPath, null)
  emitAppEvent({ kind: 'draft-written', draft: NEW_SESSION_DRAFT })
}
