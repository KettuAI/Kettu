// How the macOS notch island runs, as Settings › Notifications shows it beside its switch.

export type IslandState =
  /** Turned off, or not on this system. */
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'running' }
  /**
   * Stopped: it crashed three times within a minute, it and Kettu speak different protocol
   * versions, or this build has no helper. Notifications show as before.
   */
  | { state: 'failed'; reason: 'crashed' | 'protocol' | 'missing' }
