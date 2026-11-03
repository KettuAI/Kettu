import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from 'cn'

/**
 * `default` is 36 x 22 for settings rows, `md` 34 x 20 for list rows, `sm` 28 x 17 inside menus;
 * each keeps its thumb 2 px inside the track.
 */
function Switch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'md' | 'default'
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full px-0.5 transition-colors duration-(--duration-fast) outline-none focus-ring after:absolute after:-inset-x-3 after:-inset-y-2 aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-5.5 data-[size=default]:w-9 data-[size=md]:h-5 data-[size=md]:w-8.5 data-[size=sm]:h-4.25 data-[size=sm]:w-7 data-checked:bg-switch-on data-unchecked:bg-track data-disabled:cursor-not-allowed data-disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {/* Pressed, the thumb stretches toward where it will go, as the platform's switches do. */}
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-switch-thumb shadow-thumb transition-[translate,width] duration-(--duration-base) ease-standard motion-reduce:transition-none group-data-[size=default]/switch:size-4.5 group-data-[size=default]/switch:data-checked:translate-x-3.5 group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=md]/switch:size-4 group-data-[size=md]/switch:data-checked:translate-x-3.5 group-data-[size=md]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:size-3.25 group-data-[size=sm]/switch:data-checked:translate-x-2.75 group-data-[size=sm]/switch:data-unchecked:translate-x-0 group-active/switch:group-data-[size=default]/switch:w-[21px] group-active/switch:group-data-[size=default]/switch:data-checked:translate-x-[11px] group-active/switch:group-data-[size=md]/switch:w-[19px] group-active/switch:group-data-[size=md]/switch:data-checked:translate-x-[11px] group-active/switch:group-data-[size=sm]/switch:w-[16px] group-active/switch:group-data-[size=sm]/switch:data-checked:translate-x-[8px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
