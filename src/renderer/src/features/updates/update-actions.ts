import { errorMessage } from '@renderer/lib/host'
import { restartToUpdate } from '@renderer/stores/updates'
import type { AppUpdateAction } from './app-updates'

/** A small button's shape on the card and in its list. */
export const CARD_BUTTON = 'rounded-lg px-2.25'

/** Restart, Update and Download, which run here; What's new is a link. */
export function runAppAction(action: AppUpdateAction | null): void {
  if (action === 'restart') restartToUpdate()
  if (action === 'update' || action === 'download') {
    void window.kettu.updates
      .download()
      .catch((error: unknown) =>
        console.warn(`Could not download the update: ${errorMessage(error)}`),
      )
  }
}
