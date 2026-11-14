import { createContext } from 'react'

/** Whether the message is still being written, so a half-written block may not parse yet. */
export const LiveContext = createContext(false)

/** The session of the agent's reply the markdown shows, whose shell blocks run; null elsewhere. */
export const ReplyContext = createContext<string | null>(null)
