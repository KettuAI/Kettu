import {
  AtIcon,
  Attachment01Icon,
  BubbleChatQuestionIcon,
  Camera01Icon,
  CommandLineIcon,
  FolderAddIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SlashCommand } from '@shared/thread'
import type { ComposerAddSection } from '@renderer/components/affect/chat-composer'
import { formatShortcut, isWeb } from '@renderer/lib/platform'
import { useBrowserStore } from '@renderer/stores/browser'
import { shownSidePane, useViewStore } from '@renderer/stores/view'
import { Glyph } from '@renderer/features/shell/glyph'
import { usePhoneWindow } from '@renderer/features/shell/narrow'
import { insertSign } from './mentions'
import type { PromptBoxState } from './use-prompt-box'

/**
 * **+**: adds files, photos or a folder through the system dialog, a screenshot of the session's
 * browser, or starts a mention or a slash command, as the Chat Composer's plus menu. A row that
 * cannot be used says why beside its name.
 */
export function useAddMenu({
  box,
  agentName,
  commands,
  onSideChat,
}: {
  box: PromptBoxState
  agentName: string
  commands: readonly SlashCommand[]
  /** Opens the session's side chat; absent where there is none. */
  onSideChat?: () => void
}): { sections: ComposerAddSection[]; onAttach: (id: string) => void; disabled?: string } {
  const { t } = useTranslation('composer')
  const phone = usePhoneWindow()
  const { disabled, full, remote, source, editor, update, sessionId } = box
  const hasPage = useBrowserStore((s) => {
    const page = sessionId ? s.bySession[sessionId] : undefined
    // A released tab keeps its address for the pane, with no live page behind it.
    return !!page?.url && !page.tabs.find((tab) => tab.id === page.selected)?.released
  })
  // Only a page in front draws a frame to capture; the pane shows the main session's.
  const pageShown = useViewStore(
    (s) =>
      shownSidePane(s) === 'browser' && s.main.kind === 'session' && s.main.sessionId === sessionId,
  )
  const atMost = full ? t('attachments.atMost') : undefined
  const shot = full
    ? t('attachments.atMost')
    : !hasPage
      ? t('attachments.noPage')
      : !pageShown
        ? t('attachments.openBrowser')
        : undefined
  const sections: ComposerAddSection[] = [
    {
      rows: [
        {
          id: 'files',
          label: t('attachments.addFiles'),
          icon: <Glyph icon={Attachment01Icon} />,
          shortcut: phone ? undefined : formatShortcut('Mod+U'),
          description: atMost,
          disabled: full,
        },
        // A folder here, or a browser's, means nothing on the host.
        ...(!isWeb && !remote
          ? [
              {
                id: 'folder',
                label: t('attachments.addFolder'),
                icon: <Glyph icon={FolderAddIcon} />,
                description: atMost,
                disabled: full,
              },
            ]
          : []),
        // The session's own browser tab, which New session and the web client have none of.
        ...(!isWeb && sessionId
          ? [
              {
                id: 'screenshot',
                label: t('attachments.screenshot'),
                icon: <Glyph icon={Camera01Icon} />,
                description: shot,
                disabled: !!shot,
              },
            ]
          : []),
      ],
    },
    {
      rows: [
        {
          id: 'mention',
          label: t('attachments.mentionFile'),
          icon: <Glyph icon={AtIcon} />,
          shortcut: '@',
        },
        ...(commands.length > 0
          ? [
              {
                id: 'commands',
                label: t('attachments.slashCommands'),
                icon: <Glyph icon={CommandLineIcon} />,
                shortcut: '/',
              },
            ]
          : []),
      ],
    },
    ...(onSideChat
      ? [
          {
            rows: [
              {
                id: 'side-chat',
                label: t('attachments.sideChat'),
                icon: <Glyph icon={BubbleChatQuestionIcon} />,
                shortcut: formatShortcut('Mod+J'),
              },
            ],
          },
        ]
      : []),
  ]
  /** Types `sign` at the caret, as a word of its own, which opens its list. */
  const startWord = (sign: '@' | '/') => {
    const current = editor.current?.text() ?? source.text
    const { from, to } = editor.current?.selection() ?? { from: current.length, to: current.length }
    const next = insertSign(current, from, to, sign)
    update(next.text, next.caret)
  }
  const onAttach = (id: string) => {
    if (id === 'files' || id === 'folder') box.pick(id)
    else if (id === 'screenshot') box.screenshot()
    else if (id === 'mention') startWord('@')
    else if (id === 'commands') startWord('/')
    else if (id === 'side-chat') onSideChat?.()
    // The menu hands the focus back to its button; the text takes it after that.
    if (id === 'mention' || id === 'commands') requestAnimationFrame(() => box.focus())
  }
  return {
    sections,
    onAttach,
    ...(disabled ? { disabled: t('attachments.waitForAgent', { agent: agentName }) } : {}),
  }
}
