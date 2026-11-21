import type { AgentStatus } from '@shared/agent-host'
import { openInstall } from '@renderer/features/settings/harness-install'
import { openHostSettingsItem } from '@renderer/features/settings/host-sections'
import { confirmCliUpdate } from '@renderer/features/updates/command-confirm-model'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { FIX_URLS, harnessReason, type ProblemFix } from './harness-problem'
import { readiness } from './readiness'

/** A fix's button: a guide that opens in the browser, or what it runs here. */
export interface FixAction {
  label: string
  href: string | null
  run: (() => void) | null
}

/**
 * Whether the agent cannot run because of its harness: it is missing something, Kettu's copy is
 * not installed, or it failed.
 */
export function harnessAtFault(status: AgentStatus | undefined): status is AgentStatus {
  if (!status) return false
  return harnessReason(status) !== null || readiness(status).kind === 'failed'
}

/** Opens the harness's page in Settings of the host it is on. */
export function openHarnessPage(status: AgentStatus, hostId: string | null): void {
  openHostSettingsItem(hostId, 'harnesses', status.harnessId)
}

/**
 * What a fix's button says and does outside Settings: a tool's guide opens in the browser, an
 * update shows its command before it runs, a program is chosen in the system's dialog, and an
 * install opens the install window. Another host's update or program is fixed on its page.
 */
export function fixAction(
  status: AgentStatus,
  fix: ProblemFix,
  hostId: string | null,
  onLeave?: () => void,
): FixAction {
  const t = i18n.t.bind(i18n)
  const open = () => {
    onLeave?.()
    openHarnessPage(status, hostId)
  }
  switch (fix) {
    case 'node':
    case 'npm':
    case 'uv':
      return { label: t(`agents:problem.fix.${fix}`), href: FIX_URLS[fix], run: null }
    case 'install':
      return {
        label: t('agents:problem.fix.install'),
        href: null,
        run: () => {
          onLeave?.()
          void openInstall(status.harnessId, hostId)
        },
      }
    case 'update':
      return {
        label: t('agents:problem.fix.update'),
        href: null,
        run: hostId === null && status.cli?.update ? () => void confirmCliUpdate(status) : open,
      }
    case 'choose':
      return {
        label: t('agents:problem.fix.choose'),
        href: null,
        run:
          hostId === null
            ? () =>
                void window.kettu.dialogs
                  .chooseAgentBinary(status.harnessId)
                  .catch((error: unknown) =>
                    console.warn(`Could not choose a program: ${errorMessage(error)}`),
                  )
            : open,
      }
  }
}
