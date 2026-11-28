import { create } from 'zustand'
import { errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'

export type ThoughtViewMode = 'original' | 'translation'

export interface ThoughtTranslationRecord {
  status: 'idle' | 'loading' | 'translated' | 'error'
  view: ThoughtViewMode
  translation: string | null
  agent: string | null
  error: string | null
}

/** Stable idle record returned by selectors when no translation exists for the current key. */
export const IDLE_THOUGHT_TRANSLATION: Readonly<ThoughtTranslationRecord> = Object.freeze({
  status: 'idle',
  view: 'original',
  translation: null,
  agent: null,
  error: null,
})

/** Maximum number of cached thinking summary translations kept in memory. */
export const MAX_CACHED_THOUGHT_TRANSLATIONS = 200

export type ThoughtTranslateRequester = (params: {
  sessionId: string
  entryId: string
  text: string
  language: string
}) => Promise<{ translation: string; agent: string }>

const defaultRequester: ThoughtTranslateRequester = (params) =>
  host('sessions.translateThought', params)

/** Cache key binding a translation strictly to its entry, exact source text and target language. */
export function thoughtTranslationKey(
  sessionId: string,
  entryId: string,
  sourceText: string,
  language: string,
): string {
  return `${sessionId}\0${entryId}\0${language}\0${sourceText}`
}

/** Narrow selector helper returning a stable record reference for the given thought snapshot. */
export function thoughtTranslationOf(
  records: Readonly<Record<string, ThoughtTranslationRecord>>,
  sessionId: string,
  entryId: string,
  sourceText: string,
  language: string,
): ThoughtTranslationRecord {
  return (
    records[thoughtTranslationKey(sessionId, entryId, sourceText, language)] ??
    IDLE_THOUGHT_TRANSLATION
  )
}

function pruneRecords(
  records: Record<string, ThoughtTranslationRecord>,
): Record<string, ThoughtTranslationRecord> {
  const keys = Object.keys(records)
  if (keys.length <= MAX_CACHED_THOUGHT_TRANSLATIONS) return records
  const next = { ...records }
  let over = keys.length - MAX_CACHED_THOUGHT_TRANSLATIONS
  for (const key of keys) {
    if (over <= 0) break
    if (next[key]?.status === 'loading') continue
    delete next[key]
    over--
  }
  return next
}

interface ThoughtTranslationsState {
  records: Record<string, ThoughtTranslationRecord>
  translate(
    sessionId: string,
    entryId: string,
    sourceText: string,
    language: string,
    requester?: ThoughtTranslateRequester,
  ): Promise<void>
  setView(
    sessionId: string,
    entryId: string,
    sourceText: string,
    language: string,
    view: ThoughtViewMode,
  ): void
  clearSession(sessionId: string): void
  reset(): void
}

const inFlight = new Map<string, Promise<void>>()

export const useThoughtTranslationsStore = create<ThoughtTranslationsState>((set, get) => ({
  records: {},

  translate(sessionId, entryId, sourceText, language, requester = defaultRequester) {
    if (sourceText.trim() === '') return Promise.resolve()
    const key = thoughtTranslationKey(sessionId, entryId, sourceText, language)
    const current = get().records[key]

    // Reuse an already cached translation immediately without making another request.
    if (current?.status === 'translated' && current.translation !== null) {
      if (current.view !== 'translation') {
        set((state) => ({
          records: {
            ...state.records,
            [key]: { ...current, view: 'translation' },
          },
        }))
      }
      return Promise.resolve()
    }

    // Deduplicate concurrent clicks for the same thinking summary.
    const running = inFlight.get(key)
    if (running) return running

    set((state) => ({
      records: pruneRecords({
        ...state.records,
        [key]: {
          status: 'loading',
          view: 'original',
          translation: null,
          agent: null,
          error: null,
        },
      }),
    }))

    const request = requester({ sessionId, entryId, text: sourceText, language })
      .then((result) => {
        const translated = result.translation.trim()
        if (translated === '') {
          set((state) => ({
            records: {
              ...state.records,
              [key]: {
                status: 'error',
                view: 'original',
                translation: null,
                agent: null,
                error: i18n.t('session:thoughtTranslation.empty'),
              },
            },
          }))
          return
        }
        set((state) => ({
          records: pruneRecords({
            ...state.records,
            [key]: {
              status: 'translated',
              view: 'translation',
              translation: result.translation,
              agent: result.agent,
              error: null,
            },
          }),
        }))
      })
      .catch((error: unknown) => {
        set((state) => ({
          records: {
            ...state.records,
            [key]: {
              status: 'error',
              view: 'original',
              translation: null,
              agent: null,
              error: errorMessage(error),
            },
          },
        }))
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key)
      })

    inFlight.set(key, request)
    return request
  },

  setView(sessionId, entryId, sourceText, language, view) {
    const key = thoughtTranslationKey(sessionId, entryId, sourceText, language)
    const current = get().records[key]
    if (!current || current.status !== 'translated' || current.translation === null) return
    if (current.view === view) return
    set((state) => ({
      records: {
        ...state.records,
        [key]: { ...current, view },
      },
    }))
  },

  clearSession(sessionId) {
    const prefix = `${sessionId}\0`
    set((state) => {
      let changed = false
      const next: Record<string, ThoughtTranslationRecord> = {}
      for (const [key, value] of Object.entries(state.records)) {
        if (key.startsWith(prefix)) changed = true
        else next[key] = value
      }
      return changed ? { records: next } : state
    })
  },

  reset() {
    inFlight.clear()
    set({ records: {} })
  },
}))
