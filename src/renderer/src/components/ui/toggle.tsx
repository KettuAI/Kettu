import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-all outline-none hover:bg-muted hover:text-foreground focus-ring focus-visible:border-strong disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted data-[state=on]:bg-muted dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-input bg-transparent hover:bg-muted',
        // A segment of a segmented control; the control's thumb raises the one marked active.
        segmented:
          'min-w-0 rounded-md text-secondary transition-colors duration-(--duration-fast) hover:bg-transparent hover:text-foreground aria-pressed:bg-transparent data-[state=on]:bg-transparent data-active:text-foreground',
        // A theme's card: its picture over its label, raised; the chosen card takes an ink ring.
        tile: 'flex-col items-stretch gap-0 rounded-xl bg-surface font-normal text-foreground shadow-card transition-shadow duration-(--duration-fast) hover:bg-surface hover:text-foreground hover:shadow-outline-hover aria-pressed:bg-surface aria-pressed:shadow-[inset_0_0_0_2px_var(--text-primary),var(--elevation-card),var(--highlight)]',
        // A chart's legend key that shows or hides its series; shown, its name is in full.
        legend:
          'font-normal text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground aria-pressed:bg-transparent aria-pressed:text-foreground aria-pressed:hover:bg-accent',
        // One of a set picked together, such as a routine's weekdays: ringed, filled in ink when on.
        fill: 'text-secondary shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] hover:bg-transparent hover:text-foreground hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)] aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:shadow-none aria-pressed:hover:bg-primary/88',
      },
      size: {
        default:
          'h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        sm: "h-7 min-w-7 px-2.5 text-small has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 min-w-9 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        compact: "h-control-sm min-w-0 px-2.5 text-control [&_svg:not([class*='size-'])]:size-3.5",
        tile: 'h-auto min-w-0 p-1.5 pb-0 text-ui',
        legend: 'h-control-sm min-w-0 gap-1.5 px-1.5 text-xs',
      },
    },
    compoundVariants: [{ variant: 'segmented', size: 'compact', class: 'text-small' }],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
