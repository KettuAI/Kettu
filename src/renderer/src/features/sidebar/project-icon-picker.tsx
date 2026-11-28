import { useState, type KeyboardEvent } from 'react'
import { Cancel01Icon, Search01Icon, Undo02Icon } from '@hugeicons/core-free-icons'
import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import {
  extractSingleProjectEmoji,
  type ProjectIcon,
  type ProjectIconColor,
  type ProjectIconName,
} from '@shared/project-icon'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { ProjectMark } from '@renderer/features/shell/project-icon'
import {
  CURATED_PROJECT_EMOJIS,
  PROJECT_COLOR_SWATCHES,
  filterProjectIcons,
  projectIconColorVar,
} from '@renderer/features/shell/project-icons'

type PickerTab = 'icons' | 'emoji'

/**
 * Popover picker for a project's sidebar icon inside the Edit project dialog.
 * Supports built-in linear icons with theme-adapted preset colors, curated or custom single emoji,
 * and one-click reset back to the default folder mark.
 */
export function ProjectIconPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ProjectIcon | null
  onChange: (next: ProjectIcon | null) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('sidebar')
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PickerTab>(() => (value?.kind === 'emoji' ? 'emoji' : 'icons'))
  const [query, setQuery] = useState('')
  const [selectedColor, setSelectedColor] = useState<ProjectIconColor | null>(() =>
    value?.kind === 'icon' ? (value.color ?? null) : null,
  )
  const [customEmoji, setCustomEmoji] = useState('')
  const [emojiError, setEmojiError] = useState<string | null>(null)

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) {
      setTab(value?.kind === 'emoji' ? 'emoji' : 'icons')
      setSelectedColor(value?.kind === 'icon' ? (value.color ?? null) : null)
      setQuery('')
      setCustomEmoji('')
      setEmojiError(null)
    }
  }

  const activeColor: ProjectIconColor | null =
    value?.kind === 'icon' ? (value.color ?? null) : selectedColor

  const filteredIcons = filterProjectIcons(query)

  const pickBuiltInIcon = (name: ProjectIconName) => {
    onChange(
      activeColor
        ? { kind: 'icon', value: name, color: activeColor }
        : { kind: 'icon', value: name },
    )
  }

  const pickColor = (color: ProjectIconColor | null) => {
    setSelectedColor(color)
    const targetName: ProjectIconName = value?.kind === 'icon' ? value.value : 'folder'
    onChange(
      color ? { kind: 'icon', value: targetName, color } : { kind: 'icon', value: targetName },
    )
  }

  const pickEmoji = (emoji: string) => {
    setEmojiError(null)
    onChange({ kind: 'emoji', value: emoji })
  }

  const applyCustomEmoji = () => {
    const parsed = extractSingleProjectEmoji(customEmoji)
    if (!parsed) {
      setEmojiError(t('project.edit.iconEmojiError'))
      return
    }
    setEmojiError(null)
    setCustomEmoji('')
    onChange({ kind: 'emoji', value: parsed })
  }

  const resetToDefault = () => {
    setSelectedColor(null)
    setEmojiError(null)
    setCustomEmoji('')
    onChange(null)
  }

  const stopFormSubmitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const onCustomEmojiKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      applyCustomEmoji()
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              type="button"
              disabled={disabled}
              aria-label={t('project.edit.iconButton')}
              data-project-icon-trigger=""
              className={cn(
                'flex h-full w-10 shrink-0 items-center justify-center rounded-l-[9px] border-r border-input/70 text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:pointer-events-none disabled:opacity-50',
                open && 'bg-selected text-primary',
              )}
            />
          }
        >
          <ProjectMark icon={value} size={16} />
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('project.edit.iconButton')}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-75 gap-0 overflow-hidden p-0"
        data-project-icon-picker=""
      >
        <Tabs
          value={tab}
          onValueChange={(next) => {
            setTab(next as PickerTab)
            setEmojiError(null)
          }}
          className="gap-0"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/70 px-2.5 py-2">
            <TabsList className="h-7">
              <TabsTrigger value="icons" className="px-2.5 text-small">
                {t('project.edit.iconTabIcons')}
              </TabsTrigger>
              <TabsTrigger value="emoji" className="px-2.5 text-small">
                {t('project.edit.iconTabEmoji')}
              </TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={value === null}
              onClick={resetToDefault}
              className="gap-1 text-small text-secondary hover:text-primary"
            >
              <Glyph icon={Undo02Icon} size={13} />
              {t('project.edit.iconReset')}
            </Button>
          </div>

          <TabsContent value="icons" className="flex flex-col">
            <div className="px-2.5 pt-2.5 pb-2">
              <div className="relative flex items-center">
                <Glyph
                  icon={Search01Icon}
                  size={13}
                  className="pointer-events-none absolute left-2.5 text-tertiary"
                />
                <Input
                  value={query}
                  placeholder={t('project.edit.iconSearchPlaceholder')}
                  aria-label={t('project.edit.iconSearchPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-7.5 pr-7 pl-7.5 text-small"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={stopFormSubmitOnEnter}
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t('project.edit.iconClearSearch')}
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 flex size-5 items-center justify-center rounded text-tertiary hover:bg-hover hover:text-primary"
                  >
                    <Glyph icon={Cancel01Icon} size={12} />
                  </button>
                )}
              </div>
            </div>

            <div className="max-h-49 overflow-y-auto px-2.5 pb-2.5">
              {filteredIcons.length === 0 ? (
                <p className="py-6 text-center text-small text-tertiary">
                  {t('project.edit.iconNoMatch')}
                </p>
              ) : (
                <div
                  role="listbox"
                  aria-label={t('project.edit.iconTabIcons')}
                  className="grid grid-cols-7 gap-1"
                >
                  {filteredIcons.map((entry) => {
                    const selected = value?.kind === 'icon' && value.value === entry.name
                    return (
                      <button
                        key={entry.name}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={t(`project.edit.iconNames.${entry.name}`, {
                          defaultValue: entry.name,
                        })}
                        title={t(`project.edit.iconNames.${entry.name}`, {
                          defaultValue: entry.name,
                        })}
                        onClick={() => pickBuiltInIcon(entry.name)}
                        style={
                          activeColor ? { color: projectIconColorVar(activeColor) } : undefined
                        }
                        className={cn(
                          'flex size-8 items-center justify-center rounded-md text-icon transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40',
                          selected && 'bg-control-on-tint ring-1 ring-control-on/40',
                        )}
                      >
                        <Glyph icon={entry.glyph} size={16} />
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div
              role="group"
              aria-label={t('project.edit.iconColorLabel')}
              className="flex items-center justify-between gap-1.5 border-t border-border/70 px-3 py-2.5"
            >
              {PROJECT_COLOR_SWATCHES.map((swatch) => {
                const selected = activeColor === swatch.color
                const label = swatch.color
                  ? t(`project.edit.iconColors.${swatch.color}`)
                  : t('project.edit.iconColors.default')
                return (
                  <button
                    key={swatch.color ?? 'default'}
                    type="button"
                    aria-label={label}
                    aria-pressed={selected}
                    title={label}
                    onClick={() => pickColor(swatch.color)}
                    className={cn(
                      'flex size-5.5 items-center justify-center rounded-full transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50',
                      selected && 'ring-2 ring-border-strong ring-offset-2 ring-offset-popover',
                    )}
                  >
                    {swatch.cssVar ? (
                      <span
                        aria-hidden="true"
                        style={{ backgroundColor: swatch.cssVar }}
                        className="size-4.5 rounded-full"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="size-4.5 rounded-full border-2 border-strong bg-transparent"
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </TabsContent>

          <TabsContent value="emoji" className="flex flex-col">
            <div className="px-2.5 pt-2.5 pb-2">
              <div className="flex items-center gap-1.5">
                <Input
                  value={customEmoji}
                  placeholder={t('project.edit.iconEmojiPlaceholder')}
                  aria-label={t('project.edit.iconEmojiPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-7.5 min-w-0 flex-1 text-small"
                  onChange={(event) => {
                    setCustomEmoji(event.target.value)
                    setEmojiError(null)
                  }}
                  onKeyDown={onCustomEmojiKeyDown}
                />
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={customEmoji.trim() === ''}
                  onClick={applyCustomEmoji}
                >
                  {t('project.edit.iconEmojiApply')}
                </Button>
              </div>
              {emojiError && (
                <p role="alert" className="mt-1.5 text-[11.5px] leading-snug text-danger">
                  {emojiError}
                </p>
              )}
            </div>

            <div className="max-h-56 overflow-y-auto px-2.5 pb-2.5">
              <div
                role="listbox"
                aria-label={t('project.edit.iconTabEmoji')}
                className="grid grid-cols-8 gap-1"
              >
                {CURATED_PROJECT_EMOJIS.map((emoji) => {
                  const selected = value?.kind === 'emoji' && value.value === emoji
                  return (
                    <button
                      key={emoji}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-label={emoji}
                      onClick={() => pickEmoji(emoji)}
                      className={cn(
                        'flex size-8 items-center justify-center rounded-md text-[17px] leading-none transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40',
                        selected && 'bg-control-on-tint ring-1 ring-control-on/40',
                      )}
                    >
                      {emoji}
                    </button>
                  )
                })}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}
