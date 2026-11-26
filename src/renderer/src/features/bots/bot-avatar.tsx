// Bot 专属头像组件库（D4）：
// - 8 款原创几何角色 SVG 插画（纯 currentColor + tokens.css 双色令牌，严禁复用厂商 Logo）
// - 8 套字标/符号预设
// - 自定义裁切图片（支持本地 data URL 懒加载与失败降级）
// - 6 档标准尺寸（20/24/32/40/44/64）与 4 种右下角状态角标（needs_you / running / paused / idle）

import { useEffect, type CSSProperties } from 'react'
import type {
  BotAvatar as BotAvatarSpec,
  BotAvatarPalette,
  BotAvatarPreset,
  BotStatus,
} from '@shared/bots'
import { cn } from '@renderer/lib/utils'
import { useBotsStore } from '@renderer/stores/bots'

export type BotAvatarSize = 20 | 24 | 32 | 40 | 44 | 64

/** 8 套配色对应的 CSS 令牌映射。 */
const PALETTE_STYLE: Record<BotAvatarPalette, CSSProperties> = {
  fox: { backgroundColor: 'var(--bot-avatar-fox-bg)', color: 'var(--bot-avatar-fox-fg)' },
  slate: { backgroundColor: 'var(--bot-avatar-slate-bg)', color: 'var(--bot-avatar-slate-fg)' },
  sage: { backgroundColor: 'var(--bot-avatar-sage-bg)', color: 'var(--bot-avatar-sage-fg)' },
  indigo: { backgroundColor: 'var(--bot-avatar-indigo-bg)', color: 'var(--bot-avatar-indigo-fg)' },
  amber: { backgroundColor: 'var(--bot-avatar-amber-bg)', color: 'var(--bot-avatar-amber-fg)' },
  rose: { backgroundColor: 'var(--bot-avatar-rose-bg)', color: 'var(--bot-avatar-rose-fg)' },
  cyan: { backgroundColor: 'var(--bot-avatar-cyan-bg)', color: 'var(--bot-avatar-cyan-fg)' },
  plum: { backgroundColor: 'var(--bot-avatar-plum-bg)', color: 'var(--bot-avatar-plum-fg)' },
}

/** 8 款原创几何角色矢量插画（24×24 viewBox，纯 currentColor 适应浅/深主题）。 */
export function BotPresetGlyph({
  preset,
  className,
}: {
  preset: BotAvatarPreset
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {preset === 'architect' && (
        <>
          <path d="M4 18.5 12 5l8 13.5H4Z" />
          <path d="M12 5v13.5" />
          <path d="M8.2 12.2h7.6" />
          <circle cx="12" cy="5" r="1.2" fill="currentColor" stroke="none" />
        </>
      )}
      {preset === 'owl' && (
        <>
          <path d="M5.5 7.5 8 5l4 1.5L16 5l2.5 2.5V15a6.5 6.5 0 0 1-13 0V7.5Z" />
          <circle cx="9.5" cy="11.5" r="1.75" />
          <circle cx="14.5" cy="11.5" r="1.75" />
          <path d="m11 14.5 1 1.4 1-1.4" />
        </>
      )}
      {preset === 'sentinel' && (
        <>
          <path d="M12 3.5 19 6.5v5.3c0 4.2-2.9 7.3-7 8.7-4.1-1.4-7-4.5-7-8.7V6.5L12 3.5Z" />
          <circle cx="12" cy="11.5" r="2.2" />
          <path d="M12 7v1.2M12 14.8V16M7.8 11.5H9M15 11.5h1.2" />
        </>
      )}
      {preset === 'scribe' && (
        <>
          <path d="M12 4 17.5 12.5 12 20 6.5 12.5 12 4Z" />
          <path d="M12 4v8.2" />
          <circle cx="12" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
          <path d="M7 19.5h10" />
        </>
      )}
      {preset === 'courier' && (
        <>
          <path d="M3.8 11.6 19.8 4.8l-4.2 14.4-4.5-4.3-7.3-3.3Z" />
          <path d="M19.8 4.8 11.1 14.9v4.2l2.8-2.8" />
        </>
      )}
      {preset === 'compass' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="m15.6 8.4-2.2 5-5 2.2 2.2-5 5-2.2Z" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      )}
      {preset === 'anvil' && (
        <>
          <path d="M4 9h16l-2.2 4.5H9.2L7 11.5H4V9Z" />
          <path d="M9.5 13.5 8 18.5h8l-1.5-5" />
          <path d="M12 4.2v2.2M8.8 5.4l1.2 1.4M15.2 5.4 14 6.8" />
        </>
      )}
      {preset === 'spark' && (
        <>
          <path d="M12 3.5 14.1 9.9 20.5 12l-6.4 2.1L12 20.5l-2.1-6.4L3.5 12l6.4-2.1L12 3.5Z" />
          <circle cx="18.2" cy="5.8" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="5.8" cy="18.2" r="0.9" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}

/** 头像超椭圆圆角比例（28%）与内图标尺寸换算。 */
function boxGeometry(size: BotAvatarSize): { radius: number; glyph: number; fontSize: number } {
  const radius = Math.max(5, Math.round(size * 0.28))
  const glyph = Math.round(size * 0.6)
  const fontSize = Math.max(10, Math.round(size * 0.44))
  return { radius, glyph, fontSize }
}

export interface BotAvatarProps {
  avatar: BotAvatarSpec
  name: string
  /** 仅当 avatar.kind === 'image' 且需要向宿主读取本地图片文件时传入。 */
  botId?: string
  /** 编辑器内预览本地未保存图片时可直接传入 data URL。 */
  imageDataUrl?: string | null
  size?: BotAvatarSize
  status?: BotStatus
  className?: string
}

/** Bot 专属头像组件：固定超椭圆方框，可选右下角状态角标。 */
export function BotAvatar({
  avatar,
  name,
  botId,
  imageDataUrl,
  size = 32,
  status,
  className,
}: BotAvatarProps) {
  const imageKey = botId && avatar.kind === 'image' ? `${botId}:${avatar.file}` : null
  const cachedUrl = useBotsStore((s) => (imageKey ? s.avatars[imageKey] : undefined))
  const ensureAvatarLoaded = useBotsStore((s) => s.ensureAvatarLoaded)

  useEffect(() => {
    if (botId && avatar.kind === 'image' && !imageDataUrl && !cachedUrl) {
      void ensureAvatarLoaded(botId, avatar.file)
    }
  }, [botId, avatar, imageDataUrl, cachedUrl, ensureAvatarLoaded])

  const { radius, glyph, fontSize } = boxGeometry(size)
  const resolvedImage = imageDataUrl ?? cachedUrl ?? null
  const paletteStyle = avatar.kind === 'image' ? PALETTE_STYLE.slate : PALETTE_STYLE[avatar.palette]
  const fallbackInitial = [...(name.trim() || 'B')].slice(0, 1).join('').toUpperCase()
  const paused = status === 'paused'

  return (
    <span
      className={cn('relative inline-flex shrink-0 select-none', className)}
      style={{ width: size, height: size }}
    >
      <span
        className={cn(
          'grid h-full w-full place-items-center overflow-hidden border border-(--border-subtle) font-semibold tracking-tight transition-opacity',
          paused && 'opacity-55 grayscale',
        )}
        style={{
          ...paletteStyle,
          borderRadius: radius,
        }}
      >
        {avatar.kind === 'image' && resolvedImage ? (
          <img
            src={resolvedImage}
            alt={name}
            className="h-full w-full object-cover"
            style={
              avatar.crop
                ? {
                    transform: `translate(${avatar.crop.x}%, ${avatar.crop.y}%) scale(${avatar.crop.scale})`,
                  }
                : undefined
            }
          />
        ) : avatar.kind === 'preset' ? (
          <span style={{ width: glyph, height: glyph }} className="grid place-items-center">
            <BotPresetGlyph preset={avatar.preset} className="h-full w-full" />
          </span>
        ) : (
          <span style={{ fontSize, lineHeight: 1 }} className="uppercase">
            {avatar.kind === 'monogram' ? avatar.text.trim().slice(0, 2) : fallbackInitial}
          </span>
        )}
      </span>

      {/* 右下角状态角标（仅 needs_you / running / paused 展示，idle 保持洁净） */}
      {status === 'needs_you' && (
        <span
          aria-hidden
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full bg-(--attention-dot) ring-2 ring-(--bg-app)',
            size <= 24 ? 'size-[7px]' : 'size-[9px]',
          )}
        />
      )}
      {status === 'running' && (
        <span
          aria-hidden
          className={cn(
            'absolute -right-1 -bottom-0.5 inline-flex items-center gap-[1.5px] rounded-full bg-(--bg-raised) px-[3px] py-[2px] ring-1 ring-(--border-default)',
            size <= 24 && 'scale-90',
          )}
        >
          <span className="size-[3px] animate-pulse rounded-full bg-(--thread-fox)" />
          <span className="size-[3px] animate-pulse rounded-full bg-(--thread-fox) [animation-delay:150ms]" />
          <span className="size-[3px] animate-pulse rounded-full bg-(--thread-fox) [animation-delay:300ms]" />
        </span>
      )}
      {status === 'paused' && (
        <span
          aria-hidden
          className={cn(
            'absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-(--bg-subtle) text-(--text-tertiary) ring-2 ring-(--bg-app)',
            size <= 24 ? 'size-[9px]' : 'size-[11px]',
          )}
        >
          <span className="flex gap-[1.5px]">
            <span className="h-[5px] w-[1.5px] rounded-full bg-current" />
            <span className="h-[5px] w-[1.5px] rounded-full bg-current" />
          </span>
        </span>
      )}
    </span>
  )
}
