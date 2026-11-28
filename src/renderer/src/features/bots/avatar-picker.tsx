// Bot avatar picker supporting 8 flagship origami animal portraits, 1-2 char monograms, and
// center-cropped local image uploads compressed under 64 KB.

import { useRef, useState, type ChangeEvent, type CSSProperties } from 'react'
import { ImageUploadIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  BOT_AVATAR_MAX_BYTES,
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_PRESETS,
  type BotAvatar as BotAvatarSpec,
  type BotAvatarMimeType,
  type BotAvatarPalette,
} from '@shared/bots'
import { Button } from '@renderer/components/ui/button'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { BotAvatar, BotPresetGlyph } from './bot-avatar'

type Tab = 'preset' | 'monogram' | 'upload'

const SWATCH_COLOR: Record<BotAvatarPalette, CSSProperties> = {
  fox: { backgroundColor: 'var(--bot-avatar-fox-fg)' },
  slate: { backgroundColor: 'var(--bot-avatar-slate-fg)' },
  sage: { backgroundColor: 'var(--bot-avatar-sage-fg)' },
  indigo: { backgroundColor: 'var(--bot-avatar-indigo-fg)' },
  amber: { backgroundColor: 'var(--bot-avatar-amber-fg)' },
  rose: { backgroundColor: 'var(--bot-avatar-rose-fg)' },
  cyan: { backgroundColor: 'var(--bot-avatar-cyan-fg)' },
  plum: { backgroundColor: 'var(--bot-avatar-plum-fg)' },
}

export interface PendingAvatarUpload {
  mimeType: BotAvatarMimeType
  dataBase64: string
  previewUrl: string
}

/** Center-crops an uploaded image to 160x160 and compresses it to <= 64 KB on canvas. */
async function compressSquareAvatar(file: File): Promise<PendingAvatarUpload | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const sx = Math.floor((bitmap.width - side) / 2)
    const sy = Math.floor((bitmap.height - side) / 2)
    const target = 160
    const canvas = document.createElement('canvas')
    canvas.width = target
    canvas.height = target
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, target, target)

    const attempts: Array<{ mime: BotAvatarMimeType; quality: number }> = [
      { mime: 'image/webp', quality: 0.85 },
      { mime: 'image/webp', quality: 0.65 },
      { mime: 'image/jpeg', quality: 0.75 },
      { mime: 'image/jpeg', quality: 0.5 },
    ]
    for (const attempt of attempts) {
      const dataUrl = canvas.toDataURL(attempt.mime, attempt.quality)
      const base64 = dataUrl.split(',')[1] ?? ''
      const approxBytes = Math.ceil((base64.length * 3) / 4)
      if (approxBytes > 0 && approxBytes <= BOT_AVATAR_MAX_BYTES) {
        return { mimeType: attempt.mime, dataBase64: base64, previewUrl: dataUrl }
      }
    }
    return null
  } finally {
    bitmap.close()
  }
}

export function AvatarPicker({
  value,
  name,
  botId,
  pendingUpload,
  onChange,
  onUploadReady,
}: {
  value: BotAvatarSpec
  name: string
  botId?: string
  pendingUpload: PendingAvatarUpload | null
  onChange: (next: BotAvatarSpec) => void
  onUploadReady: (upload: PendingAvatarUpload | null) => void
}) {
  const { t } = useTranslation('bots')
  const [tab, setTab] = useState<Tab>(
    value.kind === 'image' ? 'upload' : value.kind === 'monogram' ? 'monogram' : 'preset',
  )
  const [uploadError, setUploadError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const currentPalette: BotAvatarPalette = value.kind === 'image' ? 'fox' : value.palette
  const currentPreset = value.kind === 'preset' ? value.preset : 'architect'
  const currentText =
    value.kind === 'monogram' ? value.text : [...(name.trim() || 'B')].slice(0, 2).join('')

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploadError(null)
    try {
      const compressed = await compressSquareAvatar(file)
      if (!compressed) {
        setUploadError(t('avatar.uploadTooLarge'))
        return
      }
      onUploadReady(compressed)
      onChange({ kind: 'image', file: 'avatar.webp' })
    } catch {
      setUploadError(t('avatar.uploadTooLarge'))
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-(--border-subtle) bg-(--bg-subtle)/50 p-3.5">
      <div className="flex items-center gap-3.5">
        <BotAvatar
          avatar={value}
          name={name || 'Bot'}
          botId={botId}
          imageDataUrl={pendingUpload?.previewUrl ?? null}
          size={64}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-small font-medium text-primary">{t('avatar.title')}</span>
          <div className="inline-flex w-fit rounded-lg bg-(--bg-subtle) p-0.5">
            {(
              [
                ['preset', t('avatar.tabPresets')],
                ['monogram', t('avatar.tabMonogram')],
                ['upload', t('avatar.tabUpload')],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id)
                  if (id === 'preset') {
                    onUploadReady(null)
                    onChange({ kind: 'preset', preset: currentPreset, palette: currentPalette })
                  } else if (id === 'monogram') {
                    onUploadReady(null)
                    onChange({
                      kind: 'monogram',
                      text: currentText || 'B',
                      palette: currentPalette,
                    })
                  }
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-caption font-medium transition-colors',
                  tab === id
                    ? 'bg-(--bg-raised) text-primary shadow-xs'
                    : 'text-tertiary hover:text-primary',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'preset' && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {BOT_AVATAR_PRESETS.map((preset) => {
            const active = value.kind === 'preset' && value.preset === preset
            return (
              <button
                key={preset}
                type="button"
                title={t(`avatar.presets.${preset}`)}
                onClick={() => onChange({ kind: 'preset', preset, palette: currentPalette })}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-xl border p-1.5 text-secondary transition-all',
                  active
                    ? 'border-(--control-on) bg-(--control-on-tint) text-primary ring-1 ring-(--control-on)/40'
                    : 'border-transparent bg-(--bg-surface) hover:border-(--border-default)',
                )}
              >
                <BotPresetGlyph
                  preset={preset}
                  className="size-10 border border-(--border-subtle)"
                />
                <span className="w-full truncate text-center text-[10px] text-tertiary">
                  {t(`avatar.presets.${preset}`)}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {tab === 'monogram' && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-caption text-secondary">{t('avatar.monogramLabel')}</label>
            <input
              type="text"
              maxLength={2}
              value={value.kind === 'monogram' ? value.text : currentText}
              onChange={(e) =>
                onChange({
                  kind: 'monogram',
                  text: e.target.value.slice(0, 2) || 'B',
                  palette: currentPalette,
                })
              }
              className="h-8 w-20 rounded-md border border-(--border-default) bg-(--bg-surface) px-2 text-center text-sm font-semibold uppercase focus:border-(--focus) focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption text-tertiary">{t('avatar.paletteLabel')}</span>
            {BOT_AVATAR_PALETTES.map((palette) => {
              const active = currentPalette === palette
              return (
                <button
                  key={palette}
                  type="button"
                  aria-label={t(`avatar.palettes.${palette}`)}
                  title={t(`avatar.palettes.${palette}`)}
                  onClick={() => onChange({ kind: 'monogram', text: currentText || 'B', palette })}
                  className={cn(
                    'size-5 rounded-full transition-transform',
                    active
                      ? 'scale-110 ring-2 ring-(--focus) ring-offset-2 ring-offset-(--bg-app)'
                      : '',
                  )}
                  style={SWATCH_COLOR[palette]}
                />
              )
            })}
          </div>
        </>
      )}

      {tab === 'upload' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => void handleFile(e)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
            >
              <Glyph icon={ImageUploadIcon} size={14} />
              {t('avatar.uploadButton')}
            </Button>
            <span className="text-caption text-tertiary">{t('avatar.uploadHint')}</span>
          </div>
          {uploadError && <p className="text-caption text-danger">{uploadError}</p>}
        </div>
      )}
    </div>
  )
}
