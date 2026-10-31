import type { ReactNode } from 'react'
import { GlobeIcon, LaptopIcon, MonitorIcon, SmartphoneIcon, TabletIcon } from 'lucide-react'
import type { PairedDevice } from '@shared/remote/device'
import { cn } from '@renderer/lib/utils'
import { deviceShape } from './remote-text'

/** A phone, a tablet, a laptop, a desktop or a globe, by what the device is. */
export function DeviceIcon({
  device,
  className,
}: {
  device: Pick<PairedDevice, 'kind' | 'model'>
  className?: string
}) {
  switch (deviceShape(device)) {
    case 'web':
      return <GlobeIcon className={className} />
    case 'laptop':
      return <LaptopIcon className={className} />
    case 'desktop':
      return <MonitorIcon className={className} />
    case 'tablet':
      return <TabletIcon className={className} />
    case 'phone':
      return <SmartphoneIcon className={className} />
  }
}

/** A dot in the success color, beside "Online". */
export function OnlineDot() {
  return <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-success" />
}

/** A device's icon on a tile, 30 px in the list and 40 px on its page and in the question. */
export function DeviceTile({ icon, large }: { icon: ReactNode; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center bg-tile text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]',
        large ? 'size-10 rounded-code' : 'size-7.5 rounded-lg',
      )}
    >
      {icon}
    </span>
  )
}
