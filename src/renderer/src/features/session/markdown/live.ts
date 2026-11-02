import { createContext } from 'react'

/** Whether the message is still being written, so a half-written block may not parse yet. */
export const LiveContext = createContext(false)
