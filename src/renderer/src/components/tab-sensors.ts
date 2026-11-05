import { KeyboardSensor, PointerSensor } from '@dnd-kit/react'

const pointerDefaults = PointerSensor.defaults.activationConstraints

/** For a strip of sortable tabs. Space picks a tab up; Enter stays the tab's own key for selecting it. */
export const tabSensors = [
  PointerSensor.configure({
    // A mouse press on a handle starts a drag at once by default, which swallows the tab's clicks;
    // the handle takes the constraints of a press anywhere else: 5 px of travel or a 200 ms hold.
    activationConstraints: (event, source) =>
      typeof pointerDefaults === 'function'
        ? pointerDefaults(event, Object.create(source, { handle: { value: undefined } }))
        : pointerDefaults,
  }),
  KeyboardSensor.configure({
    keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'] },
  }),
]
