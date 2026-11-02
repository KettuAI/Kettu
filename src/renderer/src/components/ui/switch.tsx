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
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full px-0.5 transition-colors duration-(--duration-fast) outline-none focus-ring after:absolute after:-inset-x-3 after:-inset-y-2 aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-5.5 data-[size=default]:w-9 data-[size=sm]:h-4.5 data-[size=sm]:w-7.5 data-checked:bg-switch-on data-unchecked:bg-track data-disabled:cursor-not-allowed data-disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {/* Pressed, the thumb stretches toward where it will go, as the platform's switches do. */}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-switch-thumb shadow-thumb transition-[translate,width] duration-(--duration-base) ease-standard motion-reduce:transition-none group-data-[size=default]/switch:size-4.5 group-data-[size=default]/switch:data-checked:translate-x-3.5 group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:size-3.5 group-data-[size=sm]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-unchecked:translate-x-0 group-active/switch:group-data-[size=default]/switch:w-[21px] group-active/switch:group-data-[size=default]/switch:data-checked:translate-x-[11px] group-active/switch:group-data-[size=sm]/switch:w-[17px] group-active/switch:group-data-[size=sm]/switch:data-checked:translate-x-[9px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
