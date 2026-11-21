// The site a Codebuddy Code agent talks to, kept in its settings file's `env`. Nothing else in the
// file is read, and every other key stays as the user left it.

import type { CodebuddySettings, CodebuddySiteChange } from '@shared/agent-host'
import {
  CODEBUDDY_SHELL_OVERRIDES,
  CODEBUDDY_SITE_VALUES,
  CODEBUDDY_SITE_VARIABLE,
  CODEBUDDY_SITES,
  type CodebuddyShellOverride,
} from '@shared/agents'
import { t } from '../i18n'
import { isObject, readSettings, writeSettings } from '../settings-file'

/** Reads the site from the file; a file that names none follows the agent's sign-in. */
export async function readCodebuddySite(
  file: string,
): Promise<Pick<CodebuddySettings, 'site' | 'otherSite'>> {
  const settings = await readSettings(file)
  const raw = isObject(settings.env) ? settings.env[CODEBUDDY_SITE_VARIABLE] : undefined
  const value = raw === undefined || raw === null ? '' : String(raw).trim()
  if (value === '') return { site: 'automatic', otherSite: null }
  // The agent compares the value without regard to case.
  const site = CODEBUDDY_SITES.find(
    (candidate) => CODEBUDDY_SITE_VALUES[candidate] === value.toLowerCase(),
  )
  return site ? { site, otherSite: null } : { site: 'other', otherSite: value }
}

/** The shell variables set in the agent's environment that win over the settings file. */
export function shellOverrides(
  getEnv: (name: string) => string | undefined,
): CodebuddyShellOverride[] {
  return CODEBUDDY_SHELL_OVERRIDES.filter((name) => (getEnv(name) ?? '').trim() !== '')
}

/** Checks a change before anything is written, so only a site Settings offers is. */
export function checkCodebuddySite(change: CodebuddySiteChange): CodebuddySiteChange {
  const { site } = change
  if (site !== 'automatic' && !CODEBUDDY_SITES.includes(site)) {
    throw new Error(t('agentConfig.siteChoice'))
  }
  return { site }
}

/** Writes the site into the settings file, or removes it for automatic; nothing else changes. */
export async function writeCodebuddySite(file: string, input: CodebuddySiteChange): Promise<void> {
  const { site } = checkCodebuddySite(input)
  const settings = await readSettings(file)
  const env = isObject(settings.env) ? { ...settings.env } : {}
  if (site === 'automatic') {
    if (!(CODEBUDDY_SITE_VARIABLE in env)) return
    delete env[CODEBUDDY_SITE_VARIABLE]
  } else {
    const value = CODEBUDDY_SITE_VALUES[site]
    if (env[CODEBUDDY_SITE_VARIABLE] === value) return
    env[CODEBUDDY_SITE_VARIABLE] = value
  }
  const next = { ...settings }
  if (Object.keys(env).length > 0) next.env = env
  else delete next.env
  await writeSettings(file, next)
}
