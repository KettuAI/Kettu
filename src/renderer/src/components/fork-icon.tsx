import { SplitIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/** Fork's icon: Lucide's Split turned to branch off to the right. */
export function ForkIcon({ className, ...props }: React.ComponentProps<typeof SplitIcon>) {
  return <SplitIcon className={cn('rotate-90', className)} {...props} />
}
