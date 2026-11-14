import type { Transition } from 'motion/react'

/** How the label and the pill come in and morph between states. */
export const CONTROL_EASE: Transition = { duration: 0.32, ease: [0.22, 1, 0.36, 1] }

/** How they leave when the turn ends. */
export const CONTROL_LEAVE_EASE: Transition = { duration: 0.26, ease: [0.4, 0, 1, 1] }
