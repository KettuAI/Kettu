// The tier of a Claude Code subscription ("5x" of Max), which the account Claude Code reports
// over ACP leaves out.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { ConfigLocation } from './agent-details'
import type { LogFn } from './storage'

/** "default_claude_max_5x" -> "5x"; null for a value that does not end in `_<n>x`. */
export function tierOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /_(\d+)x$/.exec(value.trim())
  return match ? `${match[1]}x` : null
}

/**
 * Claude Code's `.claude.json`: in the configuration folder when that folder is moved, by a
 * variable or in Settings, else in the home directory beside `.claude`.
 */
export function claudeJsonPath(folder: ConfigLocation, home: string, platform: Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const moved = folder.env !== null || folder.chosen === true
  return moved ? p.join(folder.candidates[0]!, '.claude.json') : p.join(home, '.claude.json')
}

/** The plan name and address in `.claude.json`, beside the rate-limit tier. */
export interface ClaudeProfile {
  tier: string | null
  plan: string | null
  email: string | null
}

/** The tier in a `.claude.json`; null when the file, the field or the pattern is not there. */
export async function readPlanTier(file: string, log: LogFn): Promise<string | null> {
  return (await readClaudeProfile(file, log))?.tier ?? null
}

/**
 * The subscription Claude Code stores beside its login. `auth status` on current Claude Code
 * names neither the plan nor the address, so Settings reads them from here.
 */
export async function readClaudeProfile(file: string, log: LogFn): Promise<ClaudeProfile | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log('warn', `Could not read ${file}: ${(error as Error).message}`)
    }
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const account = (parsed as { oauthAccount?: unknown }).oauthAccount
    if (typeof account !== 'object' || account === null || Array.isArray(account)) return null
    const fields = account as Record<string, unknown>
    const value = (name: string): string | null => {
      const field = fields[name]
      return typeof field === 'string' && field.trim() !== '' ? field.trim() : null
    }
    return {
      tier: tierOf(fields.organizationRateLimitTier),
      plan: value('planDisplayName'),
      email: value('emailAddress'),
    }
  } catch (error) {
    log('warn', `Could not parse ${file}: ${(error as Error).message}`)
    return null
  }
}
