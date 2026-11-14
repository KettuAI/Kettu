import type { Platform } from '@shared/platform'
import { sessionHost } from '@renderer/lib/host'
import { hostPlatform } from '@renderer/lib/platform'
import { useOtherHost } from '@renderer/stores/hosts'

const POSIX = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'shell-session', 'shellsession'])
const WINDOWS = new Set(['powershell', 'pwsh', 'ps1', 'cmd', 'bat'])
const TRANSCRIPT = new Set(['console', 'shell-session', 'shellsession'])

/** Whether a fence of this language holds commands that run on a host of this system. */
export function isCommandLanguage(language: string, platform: Platform): boolean {
  const lang = language.toLowerCase()
  return POSIX.has(lang) || (platform === 'win32' && WINDOWS.has(lang))
}

/** Whether the block is a transcript, whose `$ ` lines are the commands and the rest output. */
export function isTranscript(language: string): boolean {
  return TRANSCRIPT.has(language.toLowerCase())
}

/** What a block runs: a transcript's `$ ` lines, else the whole block. */
export function blockCommand(code: string, language: string): string {
  const text = code.replace(/\n$/, '')
  if (!isTranscript(language)) return text
  return text
    .split('\n')
    .filter((line) => line.startsWith('$ '))
    .map((line) => line.slice(2))
    .join('\n')
}

/** The system of the host a session is on, or null while another host is not known yet. */
export function useSessionPlatform(sessionId: string): Platform | null {
  const hostId = sessionHost(sessionId)
  const other = useOtherHost(hostId)
  return hostId === null ? hostPlatform() : (other?.platform ?? null)
}
