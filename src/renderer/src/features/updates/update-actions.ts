import { errorMessage } from '@renderer/lib/host'
import { restartToUpdate } from '@renderer/stores/updates'
import type { AppUpdateAction } from './app-updates'

/** A small button's shape on the card and in its list. */
export const CARD_BUTTON = 'rounded-lg px-2.25'

/** Restart and Update, which run here; Download and What's new are links. */
export function runAppAction(action: AppUpdateAction | null): void {
  if (action === 'restart') restartToUpdate()
  if (action === 'update') {
    void window.kettu.updates
      .download()
      .catch((error: unknown) =>
        console.warn(`Could not download the update: ${errorMessage(error)}`),
      )
  }
}
