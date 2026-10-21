import { useSyncExternalStore } from 'react'

// The system voice through the Web Speech API: one utterance at a time, app-wide.
let speakingId: string | null = null
const listeners = new Set<() => void>()

function setSpeaking(id: string | null): void {
  speakingId = id
  for (const listener of listeners) listener()
}

export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

/** Reads the text aloud, stopping whatever was being read. */
export function speak(id: string, text: string): void {
  speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.onend = utterance.onerror = () => {
    if (speakingId === id) setSpeaking(null)
  }
  setSpeaking(id)
  speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  speechSynthesis.cancel()
  setSpeaking(null)
}

/** Whether `id` is the one being read aloud. */
export function useSpeaking(id: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => speakingId === id,
  )
}

/** Markdown as it reads aloud: no code blocks, link targets or formatting marks. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}
