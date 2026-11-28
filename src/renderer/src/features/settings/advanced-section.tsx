import type { ReactNode } from 'react'
import { Setting07Icon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { DiagnosticsStatus, HostInfo } from '@shared/remote/host-admin'
import { useHostContext } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { DebugModeRow } from './debug-mode'
import type { GroupDef, RowDef, SectionDef } from './model'
import {
  DataFolderActions,
  DataFolderText,
  DetailedRecords,
  LogsFolderActions,
  Proxy,
  RecordSteps,
  RemoveAll,
  ReportProblem,
} from './sections'

function group(id: string, label: string): GroupDef {
  return { id, label }
}

export interface AdvancedSectionInput {
  t: TFunction<'settings'>
  onHost: { context?: 'web'; host?: string }
  remote: boolean
  info: HostInfo | null
  diagnostics: DiagnosticsStatus | null
}

/** Builds Settings › Advanced, exposing host diagnostics to paired devices when supported. */
export function buildAdvancedSection({
  t,
  onHost,
  remote,
  info,
  diagnostics,
}: AdvancedSectionInput): SectionDef {
  const data = group('data', t('advanced.groups.data'))
  const supportsDiagnostics = !remote || info?.diagnostics === true
  const showLogs = !remote || Boolean(info?.logsPath)
  const showRecordSteps = !remote || (supportsDiagnostics && diagnostics?.canRecord === true)
  const showDetailedRecords = supportsDiagnostics
  const showDebugMode = !remote || (supportsDiagnostics && diagnostics !== null)
  const debugOn = diagnostics?.debug.on === true
  return {
    id: 'advanced',
    title: t('sections.advanced'),
    description: t('pages.advanced', onHost),
    icon: Setting07Icon,
    rows: [
      {
        id: 'proxy',
        setting: 'advanced.proxy',
        group: group('network', t('advanced.groups.network')),
        layout: 'block',
        render: (text) => <Proxy label={text} />,
      },
      {
        id: 'report',
        setting: 'advanced.report',
        group: data,
        render: () => <ReportProblem />,
      },
      ...(showLogs
        ? [
            {
              id: 'logs',
              setting: 'advanced.logs',
              group: data,
              render: () => <LogsFolderActions />,
            } satisfies RowDef,
          ]
        : []),
      ...(showRecordSteps
        ? [
            {
              id: 'record-steps',
              setting: 'advanced.record-steps',
              group: data,
              render: () => <RecordSteps />,
            } satisfies RowDef,
          ]
        : []),
      ...(showDetailedRecords
        ? [
            {
              id: 'detailed-records',
              setting: 'advanced.detailed-records',
              group: data,
              render: () => <DetailedRecords label={t('advanced.detailedRecords.name')} />,
            } satisfies RowDef,
          ]
        : []),
      ...(showDebugMode
        ? [
            {
              id: 'debug-mode',
              setting: 'advanced.debug-mode',
              description: debugOn
                ? t('advanced.debugMode.descriptionOn')
                : t('advanced.debugMode.description'),
              group: data,
              layout: 'block' as const,
              render: (text: ReactNode) => (
                <DebugModeRow text={text} hostName={onHost.host ?? ''} />
              ),
            } satisfies RowDef,
          ]
        : []),
      {
        id: 'data-folder',
        setting: 'advanced.data-folder',
        rich: <DataFolderText />,
        group: data,
        render: () => <DataFolderActions />,
      },
      {
        id: 'remove-sessions',
        setting: 'advanced.remove-sessions',
        group: group('danger', t('advanced.groups.danger')),
        render: () => <RemoveAll />,
      },
    ],
  }
}

export function useAdvancedSection(): SectionDef {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const scope = useHostScope()
  const remote = isWeb || scope.hostId !== null
  const info = scope.useInfoStore((s) => s.info)
  const diagnostics = scope.useDiagnosticsStore((s) => s.status)
  return buildAdvancedSection({ t, onHost, remote, info, diagnostics })
}
