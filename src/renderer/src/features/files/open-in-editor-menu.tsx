import { useEffect, useState } from 'react'
import { CodeIcon, ComputerIcon, FolderOpenIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { EditorList } from '@shared/editors'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { toast } from '@renderer/components/ui/toast'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { errorMessage } from '@renderer/lib/host'

/**
 * **Open in editor**: the editors installed on this computer with their own icons, the last one
 * used checked and named on the item, and **Choose app…** for one Kettu does not know. Works in
 * both dropdown menus and context menus, opening either a folder or a file at `path`.
 */
export function OpenInEditorMenu({ path }: { path: string }) {
  const { t } = useTranslation('sidebar')
  const [list, setList] = useState<EditorList | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.kettu.editors.list().then(
      (next) => !cancelled && setList(next),
      (failure: unknown) => !cancelled && setError(errorMessage(failure)),
    )
    return () => {
      cancelled = true
    }
  }, [])

  const current = list?.editors.find((editor) => editor.id === list.last) ?? null
  const open = (editorId: string) =>
    void window.kettu.editors
      .open(editorId, path)
      .catch((failure: unknown) => toast(errorMessage(failure)))
  const choose = () =>
    void window.kettu.editors.choose(path).catch((failure: unknown) => toast(errorMessage(failure)))

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MenuGlyph icon={CodeIcon} />
        <span className="min-w-0 flex-1 truncate">{t('row.openInEditor')}</span>
        {current && (
          <span className="max-w-24 shrink-0 truncate pl-4 text-hint text-tertiary">
            {current.name}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-50">
        {error ? (
          <DropdownMenuItem disabled>{error}</DropdownMenuItem>
        ) : list === null ? (
          <DropdownMenuItem disabled>{t('row.findingEditors')}</DropdownMenuItem>
        ) : list.editors.length === 0 ? (
          <DropdownMenuItem disabled>{t('row.noEditors')}</DropdownMenuItem>
        ) : (
          list.editors.map((editor) => (
            <DropdownMenuItem key={editor.id} onClick={() => open(editor.id)}>
              {editor.icon ? (
                <img src={editor.icon} alt="" className="size-4 shrink-0" draggable={false} />
              ) : (
                <MenuGlyph icon={ComputerIcon} />
              )}
              <span className="min-w-0 truncate">{editor.name}</span>
              {editor.id === current?.id && (
                <Glyph icon={Tick02Icon} size={12} className="ml-auto size-3" />
              )}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={choose}>
          <MenuGlyph icon={FolderOpenIcon} />
          {t('row.chooseApp')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
