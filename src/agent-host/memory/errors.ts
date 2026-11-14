export type MemoryErrorCode = 'invalid' | 'secret' | 'full' | 'not_found' | 'conflict' | 'off'

/** A refusal of Kettu's memory, whose message says why in words an agent or the user can act on. */
export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}
