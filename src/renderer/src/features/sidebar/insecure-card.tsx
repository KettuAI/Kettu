import { useRef } from 'react'
import { ShieldAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { NoticeCard } from '@renderer/features/updates/update-notice'

/** How far the popover sits from the card, past the sidebar's edge as other notices' do. */
const BESIDE_SIDEBAR = 16

/**
 * The web client opened over plain http: a standing notice that the page itself is not protected
 * on the network, with what to do instead. It cannot be dismissed, since the page stays so.
 */
export function InsecureCard() {
  const { t } = useTranslation('web')
  const card = useRef<HTMLDivElement>(null)
  return (
    <Popover>
      <NoticeCard
        ref={card}
        icon={<ShieldAlertIcon className="size-3.5 text-warning" />}
        text={t('insecure.title')}
        label={t('insecure.title')}
        opener={<PopoverTrigger />}
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
