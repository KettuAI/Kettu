import { useState } from 'react'
import { ChevronRightIcon, WalletIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertTitle } from '@renderer/components/ui/alert'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { CopyButton } from '@renderer/features/git/copy-button'
import { cn } from '@renderer/lib/utils'
import { ConfirmedLink } from '../link-confirm'
import { PANEL } from './helpers'
import { splitLinks } from './text-links'

/**
 * The line that ends a turn the model provider refused for want of credit. It only records what
 * happened, with the provider's own words behind Details; the composer's strip offers what to do.
 */
export function OutOfCreditEnd({
  title,
  description,
  className,
}: {
  title: string
  description?: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<Alert variant="warning" className={cn('py-2 text-small', className)} />}
    >
      <WalletIcon />
      <AlertTitle className="flex flex-wrap items-baseline gap-x-2">
        <span>{title}</span>
        {description && (
          <CollapsibleTrigger className="group/details inline-flex items-center gap-0.5 rounded-sm font-normal text-tertiary outline-none focus-ring hover:text-primary">
            {t('thread.outOfCredit.details')}
            <ChevronRightIcon className="size-3 transition-transform duration-(--duration-fast) group-data-panel-open/details:rotate-90" />
          </CollapsibleTrigger>
        )}
      </AlertTitle>
      {description && (
        <CollapsibleContent className={cn(PANEL, 'col-start-2')}>
          <div className="relative mt-1.5 rounded-md bg-card py-2 pr-9 pl-2.5" data-selectable="">
            <p className="font-mono text-xs break-all whitespace-pre-wrap text-secondary">
              {splitLinks(description).map((part, i) =>
                part.type === 'link' ? <ConfirmedLink key={i} url={part.url} /> : part.text,
              )}
            </p>
            <CopyButton
              text={description}
              label={t('thread.outOfCredit.copy')}
              className="absolute top-1 right-1"
            />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}
