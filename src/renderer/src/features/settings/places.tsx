import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isWeb } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { CopyAction, PathText, RevealAction, RevealButton } from './controls'
import { RowFrame, RowText } from './rows'

/** The fields of a place that Settings shows, on an agent's page and for its MCP servers' file. */
export interface PlaceItem {
  path: string
  exists: boolean
  env: string | null
  chosen: boolean
}

/** A path as a place on a line of its own, then what describes it, then its actions at the end. */
export function PathLine({
  path,
  missing,
  children,
  actions,
}: {
  path: string
  missing?: boolean
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex min-h-6.5 min-w-0 items-center gap-2">
      <PathText path={path} missing={missing} />
      {children}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</span>}
    </div>
  )
}

/**
 * Show in Finder, as a row's text button or an icon, or Copy path where the reveal controls show
 * nothing: in a browser, and for another host.
 */
export function PlaceAction({ path, icon }: { path: string; icon?: boolean }) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  if (isWeb || hostId !== null)
    return <CopyAction text={path} label={t('advanced.dataFolder.copy')} />
  return icon ? <RevealAction path={path} /> : <RevealButton path={path} />
}

export function PathActions({ path }: { path: string }) {
  const { t } = useTranslation('settings')
  return (
    <>
      <CopyAction text={path} label={t('advanced.dataFolder.copy')} />
      <RevealAction path={path} />
    </>
  )
}

/**
 * A place as a row: its name, then its path in mono and what set it, or that it is not there yet;
 * Show in Finder at the end, or Copy path where the window cannot show it.
 */
export function PlaceRow({
  name,
  item,
  note,
  children,
}: {
  name: string
  item: PlaceItem
  note?: ReactNode
  children?: ReactNode
}) {
  const { t } = useTranslation('settings')
  const set = item.chosen
    ? t('agents.chosenInKettu')
    : item.env && t('agents.setByLine', { env: item.env })
  const after = note ?? set
  return (
    <RowFrame
      text={
        <RowText
          name={name}
          description={
            item.exists ? (
              <span className="flex min-w-0 items-baseline gap-1">
                <span
                  title={item.path}
                  data-selectable=""
                  className="min-w-0 truncate font-mono text-code [direction:rtl]"
                >
                  {'\u200E'}
                  {item.path}
                  {'\u200E'}
                </span>
                {after && <span className="shrink-0">· {after}</span>}
              </span>
            ) : (
              t('agents.notCreatedLine')
            )
          }
        />
      }
    >
      {children}
      {item.exists && <PlaceAction path={item.path} />}
    </RowFrame>
  )
}
