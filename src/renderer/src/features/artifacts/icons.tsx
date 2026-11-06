// The artifact views' icons: Hugeicons at the redesign's stroke, under the names the views use.

import type { SVGProps } from 'react'
import {
  AlertCircleIcon as AlertCircleIconSvg,
  ArrowDown01Icon as ArrowDown01IconSvg,
  ArrowExpand01Icon as ArrowExpand01IconSvg,
  ArrowLeft01Icon as ArrowLeft01IconSvg,
  ArrowLeft02Icon as ArrowLeft02IconSvg,
  ArrowRight01Icon as ArrowRight01IconSvg,
  ArrowShrink01Icon as ArrowShrink01IconSvg,
  ArrowUp02Icon as ArrowUp02IconSvg,
  Cancel01Icon as Cancel01IconSvg,
  CenterFocusIcon as CenterFocusIconSvg,
  Clock01Icon as Clock01IconSvg,
  CloudIcon as CloudIconSvg,
  Comment01Icon as Comment01IconSvg,
  Copy01Icon as Copy01IconSvg,
  Cursor01Icon as Cursor01IconSvg,
  Delete02Icon as Delete02IconSvg,
  Download04Icon as Download04IconSvg,
  Folder01Icon as Folder01IconSvg,
  Globe02Icon as Globe02IconSvg,
  LinkSquare02Icon as LinkSquare02IconSvg,
  MinusSignIcon as MinusSignIconSvg,
  MoreHorizontalIcon as MoreHorizontalIconSvg,
  PlayIcon as PlayIconSvg,
  PlusSignIcon as PlusSignIconSvg,
  RotateClockwiseIcon as RotateClockwiseIconSvg,
  RotateLeft01Icon as RotateLeft01IconSvg,
  Share08Icon as Share08IconSvg,
  SparklesIcon as SparklesIconSvg,
  TextAlignCenterIcon as TextAlignCenterIconSvg,
  TextAlignLeftIcon as TextAlignLeftIconSvg,
  TextAlignRightIcon as TextAlignRightIconSvg,
  Tick02Icon as Tick02IconSvg,
  UserIcon as UserIconSvg,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref' | 'strokeWidth'> & {
  strokeWidth?: number | string
}

/** A caller's own stroke width gives way to the redesign's one. */
const draw = (icon: IconSvgElement) =>
  function DrawnIcon(props: IconProps) {
    return <HugeiconsIcon aria-hidden {...props} icon={icon} strokeWidth={1.9} />
  }

export const AlignCenterIcon = draw(TextAlignCenterIconSvg)
export const AlignLeftIcon = draw(TextAlignLeftIconSvg)
export const AlignRightIcon = draw(TextAlignRightIconSvg)
export const ArrowLeftIcon = draw(ArrowLeft02IconSvg)
export const ArrowUpIcon = draw(ArrowUp02IconSvg)
export const CheckIcon = draw(Tick02IconSvg)
export const ChevronDownIcon = draw(ArrowDown01IconSvg)
export const ChevronLeftIcon = draw(ArrowLeft01IconSvg)
export const ChevronRightIcon = draw(ArrowRight01IconSvg)
export const CircleAlertIcon = draw(AlertCircleIconSvg)
export const CloudIcon = draw(CloudIconSvg)
export const CopyIcon = draw(Copy01IconSvg)
export const DownloadIcon = draw(Download04IconSvg)
export const EllipsisIcon = draw(MoreHorizontalIconSvg)
export const ExternalLinkIcon = draw(LinkSquare02IconSvg)
export const FolderIcon = draw(Folder01IconSvg)
export const GlobeIcon = draw(Globe02IconSvg)
export const HistoryIcon = draw(Clock01IconSvg)
export const Maximize2Icon = draw(ArrowExpand01IconSvg)
export const MessageSquareIcon = draw(Comment01IconSvg)
export const Minimize2Icon = draw(ArrowShrink01IconSvg)
export const MinusIcon = draw(MinusSignIconSvg)
export const MousePointer2Icon = draw(Cursor01IconSvg)
export const PlayIcon = draw(PlayIconSvg)
export const PlusIcon = draw(PlusSignIconSvg)
export const RotateCcwIcon = draw(RotateLeft01IconSvg)
export const RotateCwIcon = draw(RotateClockwiseIconSvg)
export const ScanIcon = draw(CenterFocusIconSvg)
export const ShareIcon = draw(Share08IconSvg)
export const SparkleIcon = draw(SparklesIconSvg)
export const TrashIcon = draw(Delete02IconSvg)
export const UserRoundIcon = draw(UserIconSvg)
export const XIcon = draw(Cancel01IconSvg)
