import type { TFunction } from 'i18next'
import type { EnvironmentInfo } from '@shared/agent-host'
import { longAgo } from '@renderer/lib/format'

/** Where the agents' environment was read from, as the line under the agent list says it. */
export function environmentText(
  t: TFunction<'settings'>,
  environment: EnvironmentInfo | null,
  now?: number,
): string {
  const source = environment?.source
  if (!environment || source === 'pending') return t('agents.environment.pending')
  if (source === 'login-shell') {
    return environment.shell && environment.resolvedAt && environment.durationMs
      ? t('agents.environment.loginShell', {
          shell: environment.shell,
          ago: longAgo(environment.resolvedAt, now),
          ms: environment.durationMs,
        })
      : t('agents.environment.loginShellPlain')
  }
  return source === 'inherited'
    ? t('agents.environment.inherited')
    : t('agents.environment.fallback')
}
