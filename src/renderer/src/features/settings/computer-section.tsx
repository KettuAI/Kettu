import { useCallback, useEffect, useState } from 'react'
import { Cursor01Icon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ComputerUseStatus } from '@shared/computer-use'
import { errorMessage } from '@renderer/lib/host'
import { isMac, isWindows, platform } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import { Pill } from './controls'
import { AllowedAppRow, ComputerSwitch, PermissionRow, StopShortcut } from './computer-rows'
import type { GroupDef, RowDef, SectionDef } from './model'
import { GroupNote } from './rows'

const isLinux = platform === 'linux'

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

/** This computer's computer use state, read again whenever the window comes back to the front. */
function useComputerStatus(): {
  status: ComputerUseStatus | null
  reload: () => void
} {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const reload = useCallback(() => {
    void window.kettu.computer.status().then(setStatus, () => setStatus(null))
  }, [])
  useEffect(() => {
    reload()
    // The user grants a permission in System Settings and comes back.
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  return { status, reload }
}

/** What the driver can do on this Linux desktop, as one line. */
export function linuxLine(status: ComputerUseStatus, t: TFunction<'settings'>): string {
  const desktop = status.desktop ?? t('computer.desktop.unknown')
  if (status.sessionType === 'x11') return t('computer.desktop.x11', { desktop })
  if (status.sessionType === 'wayland') {
    const lower = desktop.toLowerCase()
    if (lower.includes('kde')) return t('computer.desktop.kde', { desktop })
    if (lower.includes('gnome')) return t('computer.desktop.gnome', { desktop })
    return t('computer.desktop.wayland', { desktop })
  }
  return t('computer.desktop.none')
}

/** Settings › Computer use: the switch, what the computer allows, and the always-allowed apps. */
export function useComputerUseSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { status, reload } = useComputerStatus()
  const allowedApps = useSettingsStore((s) => s.settings.computerUse.allowedApps)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const remove = (id: string) => {
    setRemoveError(null)
    useSettingsStore
      .getState()
      .update({ computerUse: { allowedApps: allowedApps.filter((app) => app.id !== id) } })
      .catch((e: unknown) => setRemoveError(errorMessage(e)))
  }
  const main = group('computer-use', t('computer.groups.use'), {
    unlabeled: true,
    note: (
      <>
        {status && !status.driver && <GroupNote>{t('computer.noDriver')}</GroupNote>}
        <GroupNote>{t('computer.blocked')}</GroupNote>
      </>
    ),
  })
  const permissions = group('permissions', t('computer.groups.permissions'), {
    note: <GroupNote>{t('computer.permission.note')}</GroupNote>,
  })
  const allowed = group('allowed-apps', t('computer.groups.allowedApps'), {
    count: allowedApps.length,
    note: removeError ? <GroupNote>{removeError}</GroupNote> : undefined,
  })
  const rows: RowDef[] = [
    {
      id: 'enabled',
      setting: 'computer-use.enabled',
      group: main,
      render: () => <ComputerSwitch label={t('computer.enabled.name')} />,
    },
    {
      id: 'pause-on-use',
      setting: 'computer-use.pause-on-use',
      group: main,
      render: () => <ComputerSwitch label={t('computer.pauseOnUse.name')} setting="pauseOnUse" />,
    },
    {
      id: 'stop-shortcut',
      setting: 'computer-use.stop-shortcut',
      group: main,
      render: () => <StopShortcut />,
    },
    ...(isMac && status?.accessibility && status.screenRecording
      ? ([
          {
            id: 'accessibility',
            setting: 'computer-use.accessibility',
            group: permissions,
            render: () => (
              <PermissionRow
                kind="accessibility"
                state={status.accessibility!}
                onChanged={reload}
              />
            ),
          },
          {
            id: 'screen-recording',
            setting: 'computer-use.screen-recording',
            group: permissions,
            render: () => (
              <PermissionRow
                kind="screen-recording"
                state={status.screenRecording!}
                onChanged={reload}
              />
            ),
          },
        ] satisfies RowDef[])
      : []),
    ...(isWindows
      ? [
          {
            id: 'windows',
            setting: 'computer-use.windows',
            group: permissions,
            render: () => <Pill tone="success">{t('computer.permission.none')}</Pill>,
          } satisfies RowDef,
        ]
      : []),
    ...(isLinux && status
      ? [
          {
            id: 'desktop',
            setting: 'computer-use.desktop',
            description: linuxLine(status, t),
            group: permissions,
            render: () => null,
          } satisfies RowDef,
        ]
      : []),
    ...(allowedApps.length === 0
      ? [
          {
            id: 'no-allowed-apps',
            setting: 'computer-use.allowed-apps',
            item: {
              name: t('computer.allowedApps.none'),
              description: t('computer.allowedApps.description'),
            },
            group: allowed,
            render: () => null,
          } satisfies RowDef,
        ]
      : allowedApps.map((app): RowDef => ({
          id: `app-${app.id}`,
          setting: 'computer-use.allowed-apps',
          item: { name: app.name },
          group: allowed,
          layout: 'custom',
          render: () => <AllowedAppRow app={app} onRemove={() => remove(app.id)} />,
        }))),
  ]
  return {
    id: 'computer-use',
    title: t('sections.computer-use'),
    description: t('pages.computer-use'),
    icon: Cursor01Icon,
    rows,
  }
}
