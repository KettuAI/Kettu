import {
  AtIcon,
  Attachment01Icon,
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
import { insertAt } from './mentions'
import { useBoxText, type PromptBoxState } from './use-prompt-box'

/**
 * **+**: adds files, photos or a folder through the system dialog, a screenshot of the session's
 * browser, or starts a mention or a slash command, as the Chat Composer's plus menu. A row that
 * cannot be used says why beside its name.
 */
export function useAddMenu({
  box,
  agentName,
  commands,
}: {
  box: PromptBoxState
  agentName: string
  commands: readonly SlashCommand[]
}): { sections: ComposerAddSection[]; onAttach: (id: string) => void; disabled?: string } {
  const { t } = useTranslation('composer')
  const { disabled, full, remote, source, editor, update, sessionId } = box
  const hasPage = useBrowserStore((s) => {
    const page = sessionId ? s.bySession[sessionId] : undefined
    // An evicted page keeps its address for the pane, with no live page behind it.
    return !!page?.url && page.notice?.kind !== 'evicted'
  })
  // Only a page in front draws a frame to capture; the pane shows the main session's.
  const pageShown = useViewStore(
    (s) =>
      shownSidePane(s) === 'browser' && s.main.kind === 'session' && s.main.sessionId === sessionId,
  )
  const emptyDraft = useBoxText(box, (text) => text === '')
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
          shortcut: formatShortcut('Mod+U'),
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
                description: emptyDraft ? undefined : t('attachments.slashNeedsEmpty'),
                disabled: !emptyDraft,
              },
            ]
          : []),
      ],
    },
  ]
  const startMention = () => {
    const current = editor.current?.text() ?? source.text
    const { from, to } = editor.current?.selection() ?? { from: current.length, to: current.length }
    const next = insertAt(current, from, to)
    update(next.text, next.caret)
  }
  const onAttach = (id: string) => {
    if (id === 'files' || id === 'folder') box.pick(id)
    else if (id === 'screenshot') box.screenshot()
    else if (id === 'mention') startMention()
    else if (id === 'commands') update('/')
    // The menu hands the focus back to its button; the text takes it after that.
    if (id === 'mention' || id === 'commands') requestAnimationFrame(() => box.focus())
  }
  return {
    sections,
    onAttach,
    ...(disabled ? { disabled: t('attachments.waitForAgent', { agent: agentName }) } : {}),
  }
}
