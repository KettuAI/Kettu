import { describe, expect, it } from 'vitest'
import { pauseOthers } from './playback'

function player(paused: boolean) {
  return {
    paused,
    pause() {
      this.paused = true
    },
  }
}

describe('pauseOthers', () => {
  it('pauses the others that play when one starts, and leaves the one that started', () => {
    const clip = player(false)
    const sound = player(false)
    const started = player(false)
    const idle = player(true)
    pauseOthers(started, [clip, sound, started, idle])
    expect([clip.paused, sound.paused, started.paused, idle.paused]).toEqual([
      true,
      true,
      false,
      true,
    ])
  })
})
