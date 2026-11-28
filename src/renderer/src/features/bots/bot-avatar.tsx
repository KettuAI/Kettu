// Kettu Bot avatar component:
// - 8 flagship 3D origami animal WebP portraits mapped to preset IDs (never agent vendor logos)
// - 8 monogram color palettes
// - Custom uploaded square avatars with lazy host loading and fallback
// - Squircle geometry (26% corner radius) and bottom-right status badges (needs_you / running / paused)

import { useEffect, type CSSProperties } from 'react'
import type {
  BotAvatar as BotAvatarSpec,
  BotAvatarPalette,
  BotAvatarPreset,
  BotStatus,
} from '@shared/bots'
import bearWebp from '@renderer/assets/bots/bear.webp'
import catWebp from '@renderer/assets/bots/cat.webp'
import foxWebp from '@renderer/assets/bots/fox.webp'
import koalaWebp from '@renderer/assets/bots/koala.webp'
import owlWebp from '@renderer/assets/bots/owl.webp'
import penguinWebp from '@renderer/assets/bots/penguin.webp'
import rabbitWebp from '@renderer/assets/bots/rabbit.webp'
import shibaWebp from '@renderer/assets/bots/shiba.webp'
import { cn } from '@renderer/lib/utils'
import { useBotsStore } from '@renderer/stores/bots'

export type BotAvatarSize = 14 | 16 | 20 | 24 | 32 | 40 | 44 | 64

/** Maps each preset ID to its flagship origami animal portrait asset. */
const BOT_PRESET_IMAGE: Record<BotAvatarPreset, string> = {
  architect: foxWebp,
  owl: owlWebp,
  sentinel: penguinWebp,
  scribe: bearWebp,
  courier: rabbitWebp,
  compass: shibaWebp,
  anvil: catWebp,
  spark: koalaWebp,
}

/** Palette background/foreground token styles for monogram and subtle backing fills. */
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

/** Renders the origami portrait thumbnail for a preset avatar. */
export function BotPresetGlyph({
  preset,
  className,
}: {
  preset: BotAvatarPreset
  className?: string
}) {
  return (
    <img
      src={BOT_PRESET_IMAGE[preset]}
      alt=""
      aria-hidden
      draggable={false}
      className={cn('rounded-[26%] object-cover', className)}
    />
  )
}

/** Computes squircle radius (26%) and monogram font size for any standard avatar size. */
function boxGeometry(size: BotAvatarSize): { radius: number; fontSize: number } {
  const radius = Math.max(4, Math.round(size * 0.26))
  const fontSize = Math.max(8, Math.round(size * 0.44))
  return { radius, fontSize }
}

export interface BotAvatarProps {
  avatar: BotAvatarSpec
  name: string
  /** Required when avatar.kind === 'image' and loading the saved file from host storage. */
  botId?: string
  /** Direct data URL preview for unsaved uploads inside the Bot editor. */
  imageDataUrl?: string | null
  size?: BotAvatarSize
  status?: BotStatus
  className?: string
}

/** Squircle Bot avatar with optional bottom-right live status badge. */
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

  const { radius, fontSize } = boxGeometry(size)
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
            draggable={false}
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
          <img
            src={BOT_PRESET_IMAGE[avatar.preset]}
            alt={name}
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <span style={{ fontSize, lineHeight: 1 }} className="uppercase">
            {avatar.kind === 'monogram' ? avatar.text.trim().slice(0, 2) : fallbackInitial}
          </span>
        )}
      </span>

      {/* Bottom-right status indicator (needs_you / running / paused; idle stays clean) */}
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
