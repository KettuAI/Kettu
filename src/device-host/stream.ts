// One device's frames, fanned out to every port that watches it. A port gets only a window of
// unacknowledged frames; behind that it skips to the next keyframe instead of queueing, so a slow
// phone never holds the frames of a fast window, and a joining port starts at a keyframe. The
// window counts the frames a port was sent, never the ones that passed it by.

import { DEVICE_FLOW, type FrameKind } from '@shared/device-host'

export interface StreamFrame {
  seq: number
  kind: FrameKind
  data: Uint8Array
}

interface Watcher {
  /** The last sequence number the port acknowledged. */
  acked: number
  /** The last one sent to it. */
  sent: number
  /** The ones sent to it and not acknowledged, oldest first. */
  unacked: number[]
  /** Waiting for a keyframe after joining or falling behind. */
  waiting: boolean
}

/** A group of pictures longer than this is not replayed to a new port; it waits for a keyframe. */
const MAX_REPLAY_FRAMES = 240

export class FrameFanout {
  private readonly watchers = new Map<string, Watcher>()
  private description: StreamFrame | null = null
  private seed: StreamFrame | null = null
  /** The last keyframe and the deltas after it. */
  private group: StreamFrame[] = []
  private seq = 0

  constructor(
    private readonly deliver: (port: string, frame: StreamFrame) => void,
    private readonly wantKeyframe: () => void,
    private readonly window: number = DEVICE_FLOW.window,
  ) {}

  get watching(): number {
    return this.watchers.size
  }

  /** Whether a port that could take frames again still waits for a keyframe. */
  get starved(): boolean {
    for (const watcher of this.watchers.values()) {
      if (watcher.waiting && watcher.unacked.length < this.window) return true
    }
    return false
  }

  add(port: string): void {
    const watcher: Watcher = { acked: this.seq, sent: this.seq, unacked: [], waiting: true }
    this.watchers.set(port, watcher)
    if (this.description) this.send(port, watcher, this.description)
    if (this.group.length > 0 && this.group.length <= MAX_REPLAY_FRAMES) {
      watcher.waiting = false
      for (const frame of this.group) this.send(port, watcher, frame)
    } else {
      if (this.seed) this.send(port, watcher, this.seed)
      this.wantKeyframe()
    }
    // What a joining port is shown first is older than anything it can acknowledge.
    watcher.unacked = []
  }

  remove(port: string): void {
    this.watchers.delete(port)
  }

  ack(port: string, seq: number): void {
    const watcher = this.watchers.get(port)
    if (!watcher || !Number.isSafeInteger(seq) || seq <= watcher.acked || seq > watcher.sent) return
    watcher.acked = seq
    watcher.unacked = watcher.unacked.filter((sent) => sent > seq)
    // A port that caught up resumes at a keyframe, which a still screen may never send by itself.
    if (watcher.waiting && watcher.unacked.length < this.window) this.wantKeyframe()
  }

  push(kind: FrameKind, data: Uint8Array): void {
    const frame: StreamFrame = { seq: ++this.seq, kind, data }
    if (kind === 'description') {
      this.description = frame
      this.group = []
    } else if (kind === 'seed') {
      this.seed = frame
    } else if (kind === 'key') {
      this.group = [frame]
    } else if (this.group.length > 0) {
      this.group.push(frame)
    }
    let behind = false
    for (const [port, watcher] of this.watchers) {
      if (kind === 'description' || kind === 'seed') {
        this.send(port, watcher, frame)
        continue
      }
      if (watcher.waiting && kind !== 'key') continue
      if (watcher.unacked.length >= this.window) {
        watcher.waiting = true
        behind = true
        continue
      }
      watcher.waiting = false
      this.send(port, watcher, frame)
    }
    if (behind) this.wantKeyframe()
  }

  reset(): void {
    this.description = null
    this.seed = null
    this.group = []
    for (const watcher of this.watchers.values()) watcher.waiting = true
  }

  private send(port: string, watcher: Watcher, frame: StreamFrame): void {
    watcher.sent = frame.seq
    watcher.unacked.push(frame.seq)
    this.deliver(port, frame)
  }
}
