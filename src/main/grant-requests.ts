/**
 * Grants main has posted to the agent host and waits on: each settles when the host answers
 * `host:granted` for it, fails after `timeoutMs`, or fails when the host goes away.
 */
export class GrantRequests {
  private readonly pending = new Map<number, (error: Error | null) => void>()
  private nextId = 1

  constructor(
    private readonly timeoutMs: number,
    private readonly failure: () => Error,
  ) {}

  /** Posts a request with `post`, which says whether it reached the host. */
  request(post: (requestId: number) => boolean): Promise<void> {
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(this.failure()), this.timeoutMs)
      const settle = (error: Error | null) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        if (error) reject(error)
        else resolve()
      }
      this.pending.set(requestId, settle)
      if (!post(requestId)) settle(this.failure())
    })
  }

  /** The host holds the grants of this request. */
  answered(requestId: number): void {
    this.pending.get(requestId)?.(null)
  }

  /** The host is gone, and with it every grant still on the way. */
  failAll(): void {
    for (const settle of [...this.pending.values()]) settle(this.failure())
  }
}
