import type { ReactElement } from 'react'
import { SlidersHorizontalIcon, ViewOffSlashIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SidebarPage } from '@shared/settings'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { MenuGlyph } from '@renderer/features/shell/glyph'
import { customizeSidebar, hidePage } from './sidebar-pages'

/** A row's menu: Hide from sidebar for a page, then Customize sidebar, which opens its settings. */
export function NavMenu({ row, page }: { row: ReactElement; page?: SidebarPage }) {
  const { t } = useTranslation('sidebar')
  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        {page && (
          <ContextMenuItem onClick={() => hidePage(page)}>
            <MenuGlyph icon={ViewOffSlashIcon} />
            {t('nav.hidePage')}
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => customizeSidebar(page)}>
          <MenuGlyph icon={SlidersHorizontalIcon} />
          {t('nav.customize')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
