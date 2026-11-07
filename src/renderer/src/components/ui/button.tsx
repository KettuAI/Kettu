import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

const variants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-xl text-ui font-medium whitespace-nowrap transition-all outline-none select-none focus-ring active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-(image:--primary-gradient) text-primary-foreground shadow-primary hover:bg-(image:--primary-gradient-hover)',
        outline:
          'bg-card text-foreground shadow-outline hover:bg-subtle hover:shadow-outline-hover aria-expanded:bg-accent',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-hover aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost:
          'text-secondary hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground',
        // Confirms a deletion in a dialog, and nowhere else.
        destructive: 'bg-(--shell-danger) text-(--on-fill) hover:bg-(--shell-danger-hover)',
        // Delete and remove in rows and popovers: the surface with a thin red ring.
        'destructive-outline':
          'bg-card text-destructive shadow-destructive-ring hover:shadow-destructive-ring-hover aria-expanded:bg-accent disabled:text-tertiary',
        link: 'text-foreground underline decoration-border-strong underline-offset-3 hover:decoration-current',
        quiet:
          'text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground aria-pressed:bg-pressed aria-pressed:text-foreground aria-pressed:shadow-sunk aria-pressed:hover:bg-pressed-hover',
      },
      size: {
        default:
          'h-8 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.75 text-control in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        // A dialog's footer buttons and a card's actions, App Shell's small button.
        dialog:
          'h-6.5 gap-1.25 rounded-[7px] px-2.25 text-hint has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*=size-])]:size-3.5',
        compact:
          "h-control gap-1.5 px-2.5 text-control has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        // Icon buttons hover on the option tile's corner.
        'icon-compact': "size-(--control-height) rounded-tile [&_svg:not([class*='size-'])]:size-5",
        icon: 'size-8 rounded-tile',
        'icon-xs':
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        // The base variant's 16 px icon in the 24 px box, for a message's quiet actions.
        'icon-message': 'size-6 rounded-md',
        'icon-sm': 'size-7 rounded-tile in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-9 rounded-tile',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof variants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function buttonVariants({
  className,
  ...props
}: VariantProps<typeof variants> & { className?: string } = {}): string {
  return cn(variants({ ...props, className }))
}

export { Button, buttonVariants }
