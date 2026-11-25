import { useRef } from 'react'
import { Shield01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { Glyph } from '@renderer/features/shell/glyph'
import { NoticeCard } from '@renderer/features/updates/update-notice'
import { setInsecureHidden, useInsecureState } from '@renderer/stores/insecure-notice'

/** How far the popover sits from the card, past the sidebar's edge as other notices' do. */
const BESIDE_SIDEBAR = 16

/**
 * The web client opened over plain http: a notice that the page itself is not protected on the
 * network, with what to do instead. Dismissed, it leaves a mark by the account row that brings
 * it back, since the page stays so.
 */
export function InsecureCard() {
  const { t } = useTranslation('web')
  const card = useRef<HTMLDivElement>(null)
  return (
    <Popover>
      <NoticeCard
        ref={card}
        icon={<Glyph icon={Shield01Icon} size={14} className="text-warning" />}
        text={t('insecure.title')}
        label={t('insecure.title')}
        opener={<PopoverTrigger />}
        onDismiss={() => setInsecureHidden(true)}
      />
      <PopoverContent
        anchor={card}
        side="right"
        align="end"
        sideOffset={BESIDE_SIDEBAR}
        className="w-85 max-w-[calc(100vw-2rem)] gap-2 p-4"
      >
        <PopoverTitle className="font-semibold">{t('insecure.title')}</PopoverTitle>
        <PopoverDescription className="text-ui leading-5">{t('insecure.body')}</PopoverDescription>
      </PopoverContent>
    </Popover>
  )
}

/** By the account row once the notice is dismissed on this page: a click shows it again. */
export function InsecureMark() {
  const { t } = useTranslation('web')
  if (useInsecureState() !== 'hidden') return null
  const label = t('insecure.show')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setInsecureHidden(false)}
      className="ui-as-icon-btn ui-as-user-action"
    >
      <Glyph icon={Shield01Icon} size={16} className="text-warning" />
    </button>
  )
}
