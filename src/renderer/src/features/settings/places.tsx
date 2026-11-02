import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
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

/** A word on a path, such as that its file is not there yet. */
export function PathNote({ children }: { children: ReactNode }) {
  return (
    <span className="h-4.5 shrink-0 rounded-full bg-subtle px-1.5 text-xs leading-4.5 text-tertiary">
      {children}
    </span>
  )
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

/** A place: its path, a word when it is not there yet, and copy and show. */
export function ConfigPath({ item, extra }: { item: PlaceItem; extra?: ReactNode }) {
  const { t } = useTranslation('settings')
  return (
    <PathLine
      path={item.path}
      missing={!item.exists}
      actions={
        (extra || item.exists) && (
          <>
            {extra}
            {item.exists && <PathActions path={item.path} />}
          </>
        )
      }
    >
      {!item.exists && <PathNote>{t('agents.notCreated')}</PathNote>}
    </PathLine>
  )
}

/** What set the place: a folder picked in Kettu, or the variable that moved it. */
export function ConfigNote({ item }: { item: PlaceItem }) {
  const { t } = useTranslation('settings')
  const note = item.chosen
    ? t('agents.configFolder.chosen')
    : item.env && t('agents.setBy', { env: item.env })
  return note ? <span className="text-xs text-tertiary">{note}</span> : null
}

/**
 * A place as a row: its name, then its path in mono and what set it, or that it is not there yet;
 * Show in Finder at the end.
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
      {item.exists && <RevealButton path={item.path} />}
    </RowFrame>
  )
}
