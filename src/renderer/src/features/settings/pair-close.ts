// How Add device takes a request to close it while it asks whether to add a device.

import type { DialogRootChangeEventReason } from '@base-ui/react/dialog'

/**
 * What a request to close Add device does. The question needs an explicit answer: a click outside
 * keeps it, while Esc or a close button answers Reject, which leaves the dialog on the void code.
 */
export function closeRequest(
  confirming: boolean,
  reason: DialogRootChangeEventReason,
): 'close' | 'reject' | 'stay' {
  if (!confirming) return 'close'
  return reason === 'escape-key' || reason === 'close-press' ? 'reject' : 'stay'
}
