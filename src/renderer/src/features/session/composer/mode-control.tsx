import { useTranslation } from 'react-i18next'
import type { ComposerMode } from '@renderer/components/affect/chat-composer'
import { formatShortcut } from '@renderer/lib/platform'
import { Glyph } from '@renderer/features/shell/glyph'
import type { SelectOption } from './levels'
import { MODE_GLYPH, modeLook } from './modes'
import { useSelectPick, type Select } from './use-pick'

/**
 * The permission mode as the Chat Composer's approval button and menu: each mode with its icon and
 * what it does, Full access in red, the number keys and the note that Shift+Tab cycles them.
 */
export function useModeControl(option: SelectOption | undefined, onSelect: Select) {
  const { t } = useTranslation('composer')
  const [value, pick] = useSelectPick(option, onSelect)
  if (!option) return { approvalModes: [] as ComposerMode[] }
  const approvalModes: ComposerMode[] = option.choices.map((choice, index) => {
    const look = modeLook(choice.value)
    return {
      id: choice.value,
      label: choice.name,
      description: choice.description ?? '',
      icon: <Glyph icon={MODE_GLYPH[look]} />,
      ...(look === 'full' ? { tone: 'alert' as const } : {}),
      ...(index < 9 ? { shortcut: String(index + 1) } : {}),
    }
  })
  return {
    approval: value,
    approvalModes,
    approvalWidth: 392,
    approvalHead: (
      <>
        <span className="kettu-mode-title">{t('controls.permissionMode')}</span>
        {option.choices.length > 1 && (
          <span className="kettu-menu-keys">
            {formatShortcut('Shift')} {formatShortcut('Tab')} {t('controls.cyclesModes')}
          </span>
        )}
      </>
    ),
    onApprovalChange: pick,
  }
}
