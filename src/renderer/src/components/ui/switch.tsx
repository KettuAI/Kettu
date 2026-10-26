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
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full px-0.5 transition-colors duration-(--duration-fast) outline-none group-has-[:focus-visible]/field-label:outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-ring aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-4.5 data-[size=default]:w-8 data-[size=sm]:h-4 data-[size=sm]:w-7 data-checked:bg-primary data-unchecked:bg-border-strong data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {/* Pressed, the thumb stretches toward where it will go, as the platform's switches do. */}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full shadow-thumb transition-[translate,width] duration-(--duration-base) ease-out-quart motion-reduce:transition-none group-data-[size=default]/switch:size-3.5 group-data-[size=default]/switch:data-checked:translate-x-3.5 group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:size-3 group-data-[size=sm]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-unchecked:translate-x-0 group-active/switch:group-data-[size=default]/switch:w-[17px] group-active/switch:group-data-[size=default]/switch:data-checked:translate-x-[11px] group-active/switch:group-data-[size=sm]/switch:w-[15px] group-active/switch:group-data-[size=sm]/switch:data-checked:translate-x-[9px] bg-surface"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
