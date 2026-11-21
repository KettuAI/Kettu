import { DragDropVerticalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { SIDEBAR_PAGES, type SidebarPage } from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import { SortableGroup, SortableList } from '@renderer/features/sidebar/sortable-list'
import { isDefaultPages, PAGE_ICON, pageRow } from '@renderer/features/sidebar/sidebar-pages'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, SetButton, SettingSwitch } from './controls'
import { rowText, type RowDef } from './model'
import { Row, RowGroup, RowShell } from './rows'
import { useApply } from './use-apply'

const useAppearance = () => useHostScope().useSettingsStore((s) => s.settings.appearance)

function pageOf(row: RowDef): SidebarPage | undefined {
  return SIDEBAR_PAGES.find((page) => pageRow(page) === row.id)
}

/**
 * Settings › Appearance › Sidebar: its other rows, then the pages under New session, each dragged
 * into place by its handle and shown or hidden by its switch, then Restore default.
 */
export function SidebarCard({ rows }: { rows: RowDef[] }) {
  const { t } = useTranslation('settings')
  const { sidebarOrder: order, sidebarHidden: hidden } = useAppearance()
  const [apply, error] = useApply()
  const pages = rows.flatMap((row) => {
    const page = pageOf(row)
    return page ? [{ row, page }] : []
  })
  const move = (from: number, to: number) => {
    const next = [...order]
    const [page] = next.splice(from, 1)
    if (!page) return
    next.splice(to, 0, page)
    apply({ appearance: { sidebarOrder: next } })
  }
  return (
    <RowGroup>
      {rows
        .filter((row) => !pageOf(row))
        .map((row) => (
          <Row key={row.id} row={row} />
        ))}
      <SortableList className="k-sort-rows" onMove={move}>
        {pages.map(({ row, page }, index) => (
          <SortableGroup
            key={row.id}
            id={page}
            index={index}
            disabled={false}
            className="k-sort-row"
          >
            {(handleRef) => (
              <RowShell id={row.id}>
                <PageLine
                  name={rowText(row).name}
                  page={page}
                  shown={!hidden.includes(page)}
                  handleRef={handleRef}
                  onShow={(shown) =>
                    apply({
                      appearance: {
                        sidebarHidden: shown ? hidden.filter((p) => p !== page) : [...hidden, page],
                      },
                    })
                  }
                />
              </RowShell>
            )}
          </SortableGroup>
        ))}
      </SortableList>
      <RowShell>
        <div className="ui-sg-row k-sort-restore">
          <SetButton
            disabled={isDefaultPages(order, hidden)}
            onClick={() =>
              apply({ appearance: { sidebarOrder: [...SIDEBAR_PAGES], sidebarHidden: [] } })
            }
          >
            {t('appearance.sidebarPages.restore')}
          </SetButton>
          <ControlError error={error} />
        </div>
      </RowShell>
    </RowGroup>
  )
}

function PageLine({
  name,
  page,
  shown,
  handleRef,
  onShow,
}: {
  name: string
  page: SidebarPage
  shown: boolean
  handleRef: (element: Element | null) => void
  onShow: (shown: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const move = t('appearance.sidebarPages.move', { name })
  return (
    <div className="ui-sg-row k-sort-line">
      <button
        ref={handleRef}
        type="button"
        className="k-sort-handle"
        aria-label={move}
        title={move}
      >
        <Icon icon={DragDropVerticalIcon} size={16} />
      </button>
      <span className="k-sort-icon" aria-hidden>
        <Icon icon={PAGE_ICON[page]} size={16} />
      </span>
      <span className="ui-sg-label">
        <b>{name}</b>
      </span>
      <span className="ui-sg-control">
        <SettingSwitch label={name} checked={shown} onChange={onShow} />
      </span>
    </div>
  )
}
