import { cn } from 'cn'
import { Loader2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  const { t } = useTranslation('common')
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label={t('loading')}
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  )
}

/** A faint full ring with a quarter arc turning on it: a run in progress, as status marks draw it. */
function RingSpinner({ className, ...props }: React.ComponentProps<'span'>) {
  const { t } = useTranslation('common')
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label={t('loading')}
      className={cn(
        'inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current/18 border-t-(--text-secondary)',
        className,
      )}
      {...props}
    />
  )
}

export { RingSpinner, Spinner }
