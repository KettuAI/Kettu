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
        "pointer-events-none inline-flex h-5.5 w-fit min-w-5.5 items-center justify-center gap-1 rounded-tile bg-card px-1.5 font-sans text-xs font-medium text-secondary shadow-outline select-none [&_svg:not([class*='size-'])]:size-3",
        // In a tooltip, the shortcut is the tooltip's own text, faded, with no cap around it.
        'in-data-[slot=tooltip-content]:h-auto in-data-[slot=tooltip-content]:min-w-0 in-data-[slot=tooltip-content]:bg-transparent in-data-[slot=tooltip-content]:px-0 in-data-[slot=tooltip-content]:text-[length:inherit] in-data-[slot=tooltip-content]:font-normal in-data-[slot=tooltip-content]:text-background/60 in-data-[slot=tooltip-content]:shadow-none',
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
