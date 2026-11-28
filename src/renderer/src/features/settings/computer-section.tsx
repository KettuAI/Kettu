import { useCallback, useEffect, useState } from 'react'
import { Cursor01Icon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ComputerApp, ComputerUseStatus } from '@shared/computer-use'
import type { Platform } from '@shared/platform'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { hostPlatform, isMac, isWeb, isWindows, platform } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { useOtherHost } from '@renderer/stores/hosts'
import { useSettingsStore } from '@renderer/stores/settings'
import { useViewStore } from '@renderer/stores/view'
import { useWebHostStore } from '@renderer/stores/web-host'
import { Pill } from './controls'
import {
  AllowedAppRow,
  ComputerBooleanPill,
  ComputerPending,
  ComputerSwitch,
  ComputerUnavailable,
  PermissionRow,
  PermissionStatus,
  StopShortcut,
} from './computer-rows'
import type { GroupDef, RowDef, SectionDef } from './model'
import { GroupNote } from './rows'

const isLinux = platform === 'linux'

export type ComputerSupport = 'loading' | 'supported' | 'unsupported' | 'older'

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

/** The host's computer use status, read again when the section opens, reconnects or focuses. */
function useComputerStatus(enabled: boolean): {
  status: ComputerUseStatus | null
  failed: boolean
  reload: () => void
} {
  const scope = useHostScope()
  const shown = useViewStore((s) => s.settings.open && s.settings.section === 'computer-use')
  const webConnection = useWebHostStore((s) => s.host?.connection.state ?? null)
  const [result, setResult] = useState<{
    hostId: string | null
    status: ComputerUseStatus | null
    failed: boolean
  }>({ hostId: scope.hostId, status: null, failed: false })
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return
    let live = true
    void scope.api.computerStatus().then(
      (next) => {
        if (live) setResult({ hostId: scope.hostId, status: next, failed: false })
      },
      () => {
        if (live) setResult({ hostId: scope.hostId, status: null, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [enabled, scope, shown, webConnection, attempt])

  useEffect(() => {
    if (!enabled) return
    // The user grants a permission in System Settings and comes back.
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [enabled, reload])

  if (!enabled || result.hostId !== scope.hostId) {
    return { status: null, failed: false, reload }
  }
  return { status: result.status, failed: result.failed, reload }
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

export interface ComputerSectionInput {
  t: TFunction<'settings'>
  readOnly: boolean
  support: ComputerSupport
  hostName: string
  hostParams: { context?: 'web'; host?: string }
  targetPlatform: Platform
  knownRemotePlatform: Platform | null
  enabled: boolean
  pauseOnUse: boolean
  allowedApps: readonly ComputerApp[]
  status: ComputerUseStatus | null
  statusFailed: boolean
  removeError: string | null
  onReload: () => void
  onRemoveApp: (id: string) => void
}

/** Builds the Settings > Computer use section for local editable or remote read-only display. */
export function buildComputerUseSection({
  t,
  readOnly,
  support,
  hostName,
  hostParams,
  targetPlatform,
  knownRemotePlatform,
  enabled,
  pauseOnUse,
  allowedApps,
  status,
  statusFailed,
  removeError,
  onReload,
  onRemoveApp,
}: ComputerSectionInput): SectionDef {
  const base = {
    id: 'computer-use' as const,
    title: t('sections.computer-use'),
    description: t('pages.computer-use', hostParams),
    icon: Cursor01Icon,
  }

  if (readOnly && support !== 'supported') {
    return {
      ...base,
      rows: [
        {
          id: 'enabled',
          setting: 'computer-use.enabled',
          params: hostParams,
          description:
            support === 'unsupported'
              ? t('computer.none.title')
              : support === 'older'
                ? t('computer.older.title')
                : null,
          searchOnly: true,
          render: () => null,
        },
      ],
      footer:
        support === 'loading' ? <ComputerPending /> : <ComputerUnavailable reason={support} />,
    }
  }

  const showMacPermissions =
    Boolean(status?.accessibility && status.screenRecording) && (readOnly || isMac)
  const showWindows = readOnly ? knownRemotePlatform === 'win32' : isWindows
  const showLinux = readOnly
    ? Boolean(status) &&
      !showMacPermissions &&
      (knownRemotePlatform === 'linux' || status!.sessionType !== null || status!.desktop !== null)
    : isLinux && Boolean(status)

  const main = group('computer-use', t('computer.groups.use'), {
    unlabeled: true,
    note: (
      <>
        {readOnly && (
          <GroupNote>
            {t(hostName ? 'computer.readOnly.note' : 'computer.readOnly.noteGeneric', {
              host: hostName,
            })}
          </GroupNote>
        )}
        {readOnly && statusFailed && (
          <GroupNote>
            {t(
              hostName
                ? 'computer.permission.unavailable'
                : 'computer.permission.unavailableGeneric',
              { host: hostName },
            )}
          </GroupNote>
        )}
        {status && !status.driver && <GroupNote>{t('computer.noDriver')}</GroupNote>}
        <GroupNote>{t('computer.blocked')}</GroupNote>
      </>
    ),
  })
  const permissions = group(
    'permissions',
    hostName
      ? t('computer.groups.permissions', hostParams)
      : readOnly
        ? t('computer.groups.permissionsRemote')
        : t('computer.groups.permissions'),
    {
      note:
        !readOnly || showMacPermissions ? (
          <GroupNote>{t('computer.permission.note')}</GroupNote>
        ) : undefined,
    },
  )
  const allowed = group('allowed-apps', t('computer.groups.allowedApps'), {
    count: allowedApps.length,
    note: !readOnly && removeError ? <GroupNote>{removeError}</GroupNote> : undefined,
  })
  const rows: RowDef[] = [
    {
      id: 'enabled',
      setting: 'computer-use.enabled',
      params: hostParams,
      group: main,
      render: () =>
        readOnly ? (
          <ComputerBooleanPill value={enabled} />
        ) : (
          <ComputerSwitch label={t('computer.enabled.name')} />
        ),
    },
    {
      id: 'pause-on-use',
      setting: 'computer-use.pause-on-use',
      group: main,
      render: () =>
        readOnly ? (
          <ComputerBooleanPill value={pauseOnUse} />
        ) : (
          <ComputerSwitch label={t('computer.pauseOnUse.name')} setting="pauseOnUse" />
        ),
    },
    {
      id: 'stop-shortcut',
      setting: 'computer-use.stop-shortcut',
      group: main,
      render: () => <StopShortcut readOnly={readOnly} targetPlatform={targetPlatform} />,
    },
    ...(showMacPermissions
      ? ([
          {
            id: 'accessibility',
            setting: 'computer-use.accessibility',
            group: permissions,
            render: () =>
              readOnly ? (
                <PermissionStatus state={status!.accessibility!} />
              ) : (
                <PermissionRow
                  kind="accessibility"
                  state={status!.accessibility!}
                  onChanged={onReload}
                />
              ),
          },
          {
            id: 'screen-recording',
            setting: 'computer-use.screen-recording',
            group: permissions,
            render: () =>
              readOnly ? (
                <PermissionStatus state={status!.screenRecording!} />
              ) : (
                <PermissionRow
                  kind="screen-recording"
                  state={status!.screenRecording!}
                  onChanged={onReload}
                />
              ),
          },
        ] satisfies RowDef[])
      : []),
    ...(showWindows
      ? [
          {
            id: 'windows',
            setting: 'computer-use.windows',
            group: permissions,
            render: () => <Pill tone="success">{t('computer.permission.none')}</Pill>,
          } satisfies RowDef,
        ]
      : []),
    ...(showLinux
      ? [
          {
            id: 'desktop',
            setting: 'computer-use.desktop',
            description: linuxLine(status!, t),
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
          render: () => (
            <AllowedAppRow app={app} onRemove={readOnly ? undefined : () => onRemoveApp(app.id)} />
          ),
        }))),
  ]
  return {
    ...base,
    rows,
  }
}

/** Settings > Computer use: local controls on this computer, read-only status on paired devices. */
export function useComputerUseSection(): SectionDef {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const readOnly = isWeb || scope.hostId !== null
  const onHost = useHostContext()
  const hostName = onHost.host ?? ''
  const hostParams = hostName ? onHost : {}
  const info = scope.useInfoStore((s) => s.info)
  const support: ComputerSupport = !readOnly
    ? 'supported'
    : info === null
      ? 'loading'
      : info.computerUse === true
        ? 'supported'
        : info.computerUse === false
          ? 'unsupported'
          : 'older'
  const { status, failed, reload } = useComputerStatus(support === 'supported')
  const enabled = scope.useSettingsStore((s) => s.settings.computerUse.enabled)
  const pauseOnUse = scope.useSettingsStore((s) => s.settings.computerUse.pauseOnUse)
  const allowedApps = scope.useSettingsStore((s) => s.settings.computerUse.allowedApps)
  const webPlatform = useWebHostStore((s) => s.host?.platform ?? null)
  const otherPlatform = useOtherHost(scope.hostId)?.platform ?? null
  const knownRemotePlatform = scope.hostId !== null ? otherPlatform : webPlatform
  const targetPlatform: Platform = !readOnly
    ? platform
    : (knownRemotePlatform ?? (isWeb ? hostPlatform() : 'linux'))
  const [removeError, setRemoveError] = useState<string | null>(null)
  const remove = (id: string) => {
    setRemoveError(null)
    useSettingsStore
      .getState()
      .update({ computerUse: { allowedApps: allowedApps.filter((app) => app.id !== id) } })
      .catch((e: unknown) => setRemoveError(errorMessage(e)))
  }

  return buildComputerUseSection({
    t,
    readOnly,
    support,
    hostName,
    hostParams,
    targetPlatform,
    knownRemotePlatform,
    enabled,
    pauseOnUse,
    allowedApps,
    status,
    statusFailed: failed,
    removeError,
    onReload: reload,
    onRemoveApp: remove,
  })
}
