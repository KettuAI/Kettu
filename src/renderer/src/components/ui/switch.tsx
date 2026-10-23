import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from 'cn'

function Switch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default'
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full px-0.5 transition-colors duration-(--duration-fast) outline-none group-has-[:focus-visible]/field-label:outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-ring aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-4 data-[size=default]:w-7 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-checked:bg-primary data-unchecked:bg-input data-unchecked:shadow-card data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {/* Pressed, the thumb stretches toward where it will go, as the platform's switches do. */}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full shadow-thumb transition-[translate,width] duration-(--duration-base) ease-out-quart motion-reduce:transition-none group-data-[size=default]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-3 group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:size-2.5 group-data-[size=sm]/switch:data-checked:translate-x-2.5 group-data-[size=sm]/switch:data-unchecked:translate-x-0 group-active/switch:group-data-[size=default]/switch:w-[15px] group-active/switch:group-data-[size=default]/switch:data-checked:translate-x-[9px] group-active/switch:group-data-[size=sm]/switch:w-[13px] group-active/switch:group-data-[size=sm]/switch:data-checked:translate-x-[7px] data-checked:bg-primary-foreground data-unchecked:bg-background dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
