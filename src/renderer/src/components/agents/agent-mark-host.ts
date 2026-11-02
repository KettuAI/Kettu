import { createContext } from 'react'

/** The host whose agents the marks inside show, where it is not this computer, as in Settings. */
export const AgentMarkHost = createContext<string | null>(null)
