import { Radio as RadioPrimitive } from '@base-ui/react/radio'
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import { LucideProvider } from 'lucide-react'
import { cn } from 'cn'

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('grid w-full gap-2', className)}
      {...props}
    />
  )
}

// Off, a ring of the strong line; on, a 5 px fox border around the surface.
const DOT =
  'size-4 shrink-0 rounded-full border-0 border-control-on bg-card shadow-[inset_0_0_0_1.5px_var(--border-strong)] transition-[border-width,box-shadow] duration-(--duration-fast)'

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        DOT,
        'peer relative flex aspect-square outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-ring disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:shadow-[inset_0_0_0_1.5px_var(--danger)] data-checked:border-[5px] data-checked:shadow-none',
        className,
      )}
      {...props}
    />
  )
}

/**
 * An option tile: a choice drawn as a card, its radio's dot beside what the choice is. Chosen, it
 * takes a fox line and tint. Icons inside draw at the tiles' finer stroke.
 */
function RadioGroupTile({ className, children, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-tile"
      render={<div />}
      className={cn(
        'group/radio-group-tile flex min-w-0 items-start gap-2.25 rounded-tile bg-card px-2.75 py-2.5 text-left text-control shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] transition-[background-color,box-shadow] duration-(--duration-fast) outline-none select-none focus-ring not-data-checked:not-data-disabled:hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)] data-checked:bg-control-on-tint data-checked:shadow-[inset_0_0_0_1.5px_var(--control-on)] data-disabled:cursor-not-allowed data-disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          DOT,
          'group-data-checked/radio-group-tile:border-[5px] group-data-checked/radio-group-tile:shadow-none',
        )}
      />
      <LucideProvider strokeWidth={1.2} nonScalingStroke>
        <div className="min-w-0 flex-1">{children}</div>
      </LucideProvider>
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupTile }
