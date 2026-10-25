// Keeps the computer from idle sleep while a routine run works; it never wakes one.

import { powerSaveBlocker } from 'electron'

export class RoutinesAwake {
  private blocker: number | null = null

  set(working: boolean): void {
    if (working === (this.blocker !== null)) return
    if (working) {
      this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    } else {
      if (this.blocker !== null) powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
  }
}
