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
import { english, type GroupDef, type RowDef, type SectionDef } from './model'
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
  const en = english()
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
      name: t('computer.enabled.name'),
      english: en('computer.enabled.name'),
      description: t('computer.enabled.description'),
      keywords: t('computer.enabled.keywords'),
      group: main,
      render: () => <ComputerSwitch label={t('computer.enabled.name')} />,
    },
    {
      id: 'stop-shortcut',
      name: t('computer.stopShortcut.name'),
      english: en('computer.stopShortcut.name'),
      description: t('computer.stopShortcut.description'),
      keywords: t('computer.stopShortcut.keywords'),
      group: main,
      render: () => <StopShortcut />,
    },
    ...(isMac && status?.accessibility && status.screenRecording
      ? ([
          {
            id: 'accessibility',
            name: t('computer.accessibility.name'),
            english: en('computer.accessibility.name'),
            description: t('computer.accessibility.description'),
            keywords: t('computer.enabled.keywords'),
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
            name: t('computer.screenRecording.name'),
            english: en('computer.screenRecording.name'),
            description: t('computer.screenRecording.description'),
            keywords: t('computer.enabled.keywords'),
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
            name: t('computer.windows.name'),
            english: en('computer.windows.name'),
            description: t('computer.windows.description'),
            group: permissions,
            render: () => <Pill tone="success">{t('computer.permission.none')}</Pill>,
          } satisfies RowDef,
        ]
      : []),
    ...(isLinux && status
      ? [
          {
            id: 'desktop',
            name: t('computer.desktop.name'),
            english: en('computer.desktop.name'),
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
            name: t('computer.allowedApps.none'),
            description: t('computer.allowedApps.description'),
            keywords: t('computer.allowedApps.keywords'),
            group: allowed,
            render: () => null,
          } satisfies RowDef,
        ]
      : allowedApps.map((app): RowDef => ({
          id: `app-${app.id}`,
          name: app.name,
          keywords: t('computer.allowedApps.keywords'),
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
