import { Folder01Icon } from '@hugeicons/core-free-icons'
import { cn } from 'cn'
import type { ProjectIcon } from '@shared/project-icon'
import { FolderClosedMark } from '@renderer/components/affect/app-shell'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import { Glyph } from './glyph'
import { PROJECT_ICON_GLYPHS, projectIconColorVar } from './project-icons'

/**
 * Renders a project's visual mark across the sidebar, pickers, search, artifacts and settings.
 * Projects without a custom icon keep the default folder mark with zero visual change.
 */
export function ProjectMark({
  icon,
  open = false,
  size = 16,
  fallback = 'folder-mark',
  className,
}: {
  icon?: ProjectIcon | null
  open?: boolean
  size?: number
  fallback?: 'folder-mark' | 'folder-glyph'
  className?: string
}) {
  if (!icon) {
    if (fallback === 'folder-glyph') {
      return <Glyph icon={Folder01Icon} size={size} className={cn('shrink-0', className)} />
    }
    return open ? <FolderMark /> : <FolderClosedMark />
  }

  if (icon.kind === 'emoji') {
    const fontSize = Math.max(11, Math.round(size * 0.875))
    return (
      <span
        aria-hidden="true"
        data-project-icon="emoji"
        style={{ width: size, height: size, fontSize }}
        className={cn(
          'inline-flex shrink-0 items-center justify-center leading-none select-none',
          className,
        )}
      >
        {icon.value}
      </span>
    )
  }

  const glyph = PROJECT_ICON_GLYPHS[icon.value] ?? Folder01Icon
  return (
    <span
      aria-hidden="true"
      data-project-icon={icon.value}
      data-project-icon-color={icon.color ?? 'default'}
      style={{
        width: size,
        height: size,
        ...(icon.color ? { color: projectIconColorVar(icon.color) } : {}),
      }}
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
    >
      <Glyph icon={glyph} size={size} />
    </span>
  )
}
