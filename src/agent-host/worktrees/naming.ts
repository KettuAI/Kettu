// A new worktree's branch named by its agent: the name is written while the worktree is prepared,
// and taken only before the first message goes, at most NAME_WAIT_MS after preparing ends.

export const NAME_WAIT_MS = 3_000

/** One worktree's written name, which is applied once or never. */
export class BranchNaming {
  private settling: Promise<void> | null = null
  private dropped = false

  /** `slug` resolves to null when no name was written; it never rejects. */
  constructor(private readonly slug: Promise<string | null>) {}

  /**
   * Waits up to `waitMs` for the name and hands it to `apply`, which must not reject. A later call
   * waits for the same; a name that comes after the wait is never applied.
   */
  settle(apply: (slug: string) => Promise<void>, waitMs: number = NAME_WAIT_MS): Promise<void> {
    this.settling ??= this.run(apply, waitMs)
    return this.settling
  }

  /** Never applies the name, as when the worktree goes before it comes. */
  drop(): void {
    this.dropped = true
  }

  private async run(apply: (slug: string) => Promise<void>, waitMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs)
    })
    const slug = await Promise.race([this.slug, late])
    clearTimeout(timer)
    if (slug === null || this.dropped) return
    await apply(slug)
  }
}
