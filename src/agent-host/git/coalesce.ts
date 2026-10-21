// One run at a time; requests that arrive during a run share a single follow-up run.

/**
 * `request()` resolves with the result of a run that started after the call, so a
 * caller that changed something and then asks always sees it reflected.
 */
export function createCoalescer<T>(run: () => Promise<T>): { request(): Promise<T> } {
  let inFlight: Promise<T> | null = null
  let followUp: Promise<T> | null = null

  function start(): Promise<T> {
    const current = run().finally(() => {
      if (inFlight === current) inFlight = null
    })
    inFlight = current
    return current
  }

  return {
    request() {
      if (!inFlight) return start()
      followUp ??= inFlight
        .catch(() => undefined)
        .then(() => {
          followUp = null
          return start()
        })
      return followUp
    },
  }
}
