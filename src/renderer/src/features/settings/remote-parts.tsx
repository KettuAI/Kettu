import type { ReactNode } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  ComputerIcon,
  Globe02Icon,
  LaptopIcon,
  SmartPhone01Icon,
  Tablet01Icon,
} from '@hugeicons/core-free-icons'
import type { PairedDevice } from '@shared/remote/device'
import { SystemLogo } from '@renderer/components/system-logo'
import { cn } from '@renderer/lib/utils'
import { deviceShape, systemLogoOf } from './remote-text'

function Glyph({ icon, className }: { icon: IconSvgElement; className?: string }) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={24}
      strokeWidth={1.9}
      aria-hidden
      className={cn('shrink-0', className)}
    />
  )
}

const SHAPE_ICON = {
  web: Globe02Icon,
  laptop: LaptopIcon,
  desktop: ComputerIcon,
  tablet: Tablet01Icon,
  phone: SmartPhone01Icon,
} as const

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
  return <Glyph icon={SHAPE_ICON[shape]} className={className} />
}

/** A host's system logo, or a computer for a system without one. */
export function HostIcon({ platform, className }: { platform: string; className?: string }) {
  const logo = systemLogoOf(platform)
  return logo ? (
    <SystemLogo name={logo} className={className} />
  ) : (
    <Glyph icon={ComputerIcon} className={className} />
  )
}

/** A dot in the success color, beside "Online". */
export function OnlineDot() {
  return <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-success" />
}

/** A device's mark, unframed: 20 px in a list, 28 px on its page and in a dialog. */
export function DeviceTile({ icon, large }: { icon: ReactNode; large?: boolean }) {
  return (
    <span aria-hidden className={cn('k-device', large && 'k-device--large')}>
      {icon}
    </span>
  )
}
