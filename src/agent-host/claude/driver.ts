// Claude Code's driver: the Claude Agent SDK, loaded into the agent host from the folder Kettu
// installed it in, which runs one Claude Code process per open session.

import { pathToFileURL } from 'node:url'
import type { HostedDriver } from '../driver'
import { t } from '../i18n'
import { ClaudeConnection, type LoadSdk } from './connection'
import type { ClaudeSdk } from './sdk'
import { restoreConfig } from './stored-config'

const EXPORTS = [
  'query',
  'listSessions',
  'getSessionInfo',
  'getSessionMessages',
  'getSubagentMessages',
  'deleteSession',
  'forkSession',
  'resolveSettings',
  'filterEscalatingDefaultMode',
] as const

/** Loads the SDK from its installed entry module, checking that it has what Kettu calls. */
export async function loadClaudeSdk(entry: string): Promise<ClaudeSdk> {
  const module = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Record<
    string,
    unknown
  >
  const missing = EXPORTS.filter((name) => typeof module[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(t('agent.sdkLacks', { entry, missing: missing.join(', ') }))
  }
  return module as unknown as ClaudeSdk
}

/** The driver, loading the SDK with `load`; a test passes a fake SDK's. */
export function claudeSdkDriver(load: LoadSdk = loadClaudeSdk): HostedDriver {
  return {
    kind: 'hosted',
    reads: { limits: true, context: true },
    restoreConfig,
    connect: (context) => new ClaudeConnection(context, load),
  }
}

export const CLAUDE_SDK_DRIVER = claudeSdkDriver()
