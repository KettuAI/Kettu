import { cn } from 'cn'
import { useTranslation } from 'react-i18next'

// AffectUI's own spinner, a faint ring with a quarter arc turning on it: Hugeicons has none.
function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  const { t } = useTranslation('common')
  return (
    <svg
      data-slot="spinner"
      role="status"
      aria-label={t('loading')}
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      className={cn('size-4 animate-spin', className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" opacity={0.2} />
      <path d="M12 3a9 9 0 0 1 9 9" />
    </svg>
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
