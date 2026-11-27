import { memo, type MouseEvent } from 'react'
import { Alert02Icon, File01Icon, LinkSquare02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { ConfigWarningDetail, ConfigWarningSource } from '@shared/thread'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Badge } from '@renderer/components/ui/badge'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { openFileInDefaultApp } from '@renderer/features/files/operations'
import { CopyButton } from '@renderer/features/git/copy-button'
import { isMod, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { openFile } from '@renderer/stores/files'
import { useSessionsStore } from '@renderer/stores/sessions'
import { ConfirmedLink } from '../link-confirm'
import { sessionLinkProps } from '../open-link'
import {
  knownConfigWarningLayer,
  resolveConfigWarningSourceAction,
  safeConfigDocsUrl,
  type ConfigWarningSourceAction,
} from './config-warning-actions'
import { splitLinks } from './text-links'

const IMPACT_BADGE_VARIANT = {
  deprecated: 'warning',
  ignored: 'neutral',
  invalid: 'error',
} as const

function triggerSourceOpen(
  action: ConfigWarningSourceAction,
  event: Pick<MouseEvent<HTMLElement>, 'metaKey' | 'ctrlKey'>,
): void {
  if (action.filesPane) {
    if (action.localFile && isMod(event)) {
      openFileInDefaultApp(action.localFile)
      return
    }
    openFile(action.filesPane.projectPath, action.filesPane.relativePath, action.filesPane.line, {
      preview: true,
    })
    return
  }
  if (action.localFile) {
    openFileInDefaultApp(action.localFile)
  }
}

export interface ConfigWarningEntryProps {
  sessionId: string
  projectPath?: string
  title: string
  description?: string
  detail: ConfigWarningDetail
  className?: string
}

/**
 * Notice card for Codex configuration warnings: identifies the source, distinguishes deprecated
 * (still active) vs ignored/removed vs invalid settings, shows reported config locations, and
 * offers local file viewing/opening alongside official Codex configuration documentation.
 */
export const ConfigWarningEntry = memo(function ConfigWarningEntry({
  sessionId,
  projectPath: explicitProjectPath,
  title,
  description,
  detail,
  className,
}: ConfigWarningEntryProps) {
  const { t } = useTranslation('session')
  const storedProjectPath = useSessionsStore((s) => s.byId[sessionId]?.projectPath ?? '')
  const projectPath = explicitProjectPath ?? storedProjectPath
  const sources: readonly ConfigWarningSource[] = detail.sources ?? []
  const resolved = sources.map((source) => ({
    source,
    action: resolveConfigWarningSourceAction(source, { projectPath, web: isWeb }),
  }))
  const singleSource = resolved.length === 1 ? resolved[0]! : null
  const docsUrl = safeConfigDocsUrl(detail.docsUrl)
  const heading = detail.agent === 'codex' ? t('thread.configWarning.title') : title
  const impact = detail.impact

  const layerLabel = (layer: string | undefined): string => {
    const known = knownConfigWarningLayer(layer)
    if (known) return t(`thread.configWarning.layer.${known}`)
    if (layer?.trim()) return layer.trim()
    return t('thread.configWarning.sourceLabel')
  }

  return (
    <Alert variant="warning" className={cn('ks-notice', className)} data-config-warning="">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.9} aria-hidden />
      <AlertTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{heading}</span>
        {impact && (
          <Badge variant={IMPACT_BADGE_VARIANT[impact]} data-config-impact={impact}>
            {t(`thread.configWarning.impact.${impact}.badge`)}
          </Badge>
        )}
      </AlertTitle>
      {impact && (
        <p className="col-start-2 mt-0.5 text-small text-secondary">
          {t(`thread.configWarning.impact.${impact}.note`)}
        </p>
      )}
      {resolved.length > 0 && (
        <div className="col-start-2 mt-1.5 flex flex-col gap-1" data-config-sources="">
          {resolved.map(({ source, action }) => (
            <div
              key={`${source.layer ?? ''}:${action.location}`}
              className="flex min-w-0 items-center gap-1.5 rounded-md bg-subtle px-2 py-1 text-xs"
            >
              <span className="shrink-0 font-medium text-tertiary">{layerLabel(source.layer)}</span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-secondary"
                title={action.location}
                data-selectable=""
              >
                {action.location}
              </span>
              {resolved.length > 1 && action.primary !== null && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={(event) => triggerSourceOpen(action, event)}
                >
                  <HugeiconsIcon icon={File01Icon} strokeWidth={1.9} aria-hidden />
                  {action.primary === 'files-pane'
                    ? t('thread.configWarning.viewShort')
                    : t('thread.configWarning.openShort')}
                </Button>
              )}
              <CopyButton text={source.path} label={t('thread.configWarning.copyPath')} />
            </div>
          ))}
        </div>
      )}
      {description && (
        <AlertDescription
          className="col-start-2 mt-1.5 break-words whitespace-pre-wrap"
          data-selectable=""
        >
          {splitLinks(description).map((part, i) =>
            part.type === 'link' ? <ConfirmedLink key={i} url={part.url} /> : part.text,
          )}
        </AlertDescription>
      )}
      <div className="col-start-2 mt-2 flex flex-wrap items-center gap-1.5">
        {singleSource && singleSource.action.primary !== null && (
          <Button
            variant="outline"
            size="xs"
            data-config-action="open-file"
            onClick={(event) => triggerSourceOpen(singleSource.action, event)}
          >
            <HugeiconsIcon icon={File01Icon} strokeWidth={1.9} aria-hidden />
            {singleSource.action.primary === 'files-pane'
              ? t('thread.configWarning.viewInFiles')
              : t('thread.configWarning.openConfig')}
          </Button>
        )}
        <a
          className={buttonVariants({ variant: 'quiet', size: 'xs' })}
          data-config-action="open-docs"
          {...sessionLinkProps(docsUrl, sessionId)}
        >
          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.9} aria-hidden />
          {t('thread.configWarning.docs')}
        </a>
      </div>
    </Alert>
  )
})
