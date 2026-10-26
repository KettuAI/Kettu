import { cn } from 'cn'

function Kbd({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'kbd'> & { variant?: 'default' | 'primary' }) {
  return (
    <kbd
      data-slot="kbd"
      data-variant={variant}
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-card px-1 font-sans text-xs font-medium text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-default),0_var(--hairline)_0_var(--border-default)] select-none in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background in-data-[slot=tooltip-content]:shadow-none dark:in-data-[slot=tooltip-content]:bg-background/10 [&_svg:not([class*='size-'])]:size-3",
        // The key of the usual choice, inked as a primary button is.
        variant === 'primary' && 'bg-primary text-primary-foreground shadow-none',
        className,
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
