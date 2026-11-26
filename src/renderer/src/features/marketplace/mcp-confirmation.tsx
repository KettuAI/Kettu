import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMcpCommand } from '@shared/mcp-command'
import type { McpSpec } from '@shared/marketplace'
import { Dialog } from '@renderer/components/ui/dialog'
import {
  SettingsDialogContent,
  SettingsDialogHeader,
} from '@renderer/features/settings/settings-dialog'
import { homeShort } from './model'

export function McpRunPreview({ spec, project }: { spec: McpSpec; project?: string }) {
  const { t } = useTranslation('marketplace')
  const values = spec.type === 'stdio' ? spec.env : spec.headers
  return (
    <div className="k-mcp-run">
      <span>{t(spec.type === 'stdio' ? 'mcp.command' : 'mcp.address')}</span>
      <code className="k-mkt-mono">
        {spec.type === 'stdio' ? formatMcpCommand(spec.command, spec.args) : spec.url}
      </code>
      {spec.type === 'stdio' && (
        <span>
          {t('mcp.runsIn', { folder: project ? homeShort(project) : t('mcp.homeFolder') })}
        </span>
      )}
      {values.length > 0 && (
        <ul
          className="k-mcp-values"
          aria-label={t(spec.type === 'stdio' ? 'mcp.environment' : 'mcp.headers')}
        >
          {values.map((item) => (
            <li key={item.name}>
              <code className="k-mkt-mono">{item.name}</code>
              <span>{'input' in item ? t('mcp.masked') : item.value}</span>
            </li>
          ))}
        </ul>
      )}
      {spec.type === 'stdio' && <span>{t('mcp.runPermission')}</span>}
    </div>
  )
}

export function McpConfirmation({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent className="k-mcp-dialog">
        <SettingsDialogHeader title={title} />
        {open && children}
      </SettingsDialogContent>
    </Dialog>
  )
}
