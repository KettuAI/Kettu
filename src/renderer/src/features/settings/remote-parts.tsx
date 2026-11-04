import type { ReactNode } from 'react'
import { GlobeIcon, LaptopIcon, MonitorIcon, SmartphoneIcon, TabletIcon } from 'lucide-react'
import type { PairedDevice } from '@shared/remote/device'
import { SystemLogo } from '@renderer/components/system-logo'
import { cn } from '@renderer/lib/utils'
import { deviceShape, systemLogoOf } from './remote-text'

/** A device's system logo; a globe for a browser, else a phone, tablet, laptop or desktop. */
export function DeviceIcon({
  device,
  className,
}: {
  device: Pick<PairedDevice, 'kind' | 'model' | 'platform'>
  className?: string
}) {
  const shape = deviceShape(device)
  const logo = shape === 'web' ? null : systemLogoOf(device.platform)
  if (logo) return <SystemLogo name={logo} className={className} />
  switch (shape) {
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

/** A host's system logo, or a monitor for a system without one. */
export function HostIcon({ platform, className }: { platform: string; className?: string }) {
  const logo = systemLogoOf(platform)
  return logo ? (
    <SystemLogo name={logo} className={className} />
  ) : (
    <MonitorIcon className={className} />
  )
}

/** A dot in the success color, beside "Online". */
export function OnlineDot() {
  return <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-success" />
}

/** A device's icon on a tile, 34 px in the list and 40 px on its page and in the question. */
export function DeviceTile({ icon, large }: { icon: ReactNode; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-segments bg-subtle text-secondary',
        large ? 'size-10' : 'size-8.5',
      )}
    >
      {icon}
    </span>
  )
}
