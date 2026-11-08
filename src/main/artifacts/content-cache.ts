import type { ArtifactContentResult } from '@shared/host-control'

type Ask = (id: string, version: number | null) => Promise<ArtifactContentResult>

/** About as many versions as a few windows show at once. */
const KEPT = 64

/**
 * The host's answers to what files a version has, shared by every request for that version until
 * the host reports a change to any artifact. A page can ask for a file hundreds of times: Chromium
 * fetches an external SVG once per `<use>` on a custom scheme, whatever the response's caching.
 */
export class ContentCache {
  private readonly kept = new Map<string, Promise<ArtifactContentResult>>()

  constructor(
    private readonly ask: Ask,
    private readonly limit = KEPT,
  ) {}

  get(id: string, version: number | null): Promise<ArtifactContentResult> {
    const key = `${id}/${version ?? 'latest'}`
    const kept = this.kept.get(key)
    if (kept) return kept
    const asked = this.ask(id, version).then((result) => {
      // A failure or a missing version is asked again; a clear since the asking already dropped it.
      if (result.kind !== 'found' && this.kept.get(key) === asked) this.kept.delete(key)
      return result
    })
    this.kept.set(key, asked)
    if (this.kept.size > this.limit) this.kept.delete(this.kept.keys().next().value!)
    return asked
  }

  /** Forgets every answer, those still being asked for included. */
  clear(): void {
    this.kept.clear()
  }
}
