import { create } from 'zustand'

interface Shown {
  id: number
  path: string
  name: string
}

let nextId = 1

/** The project whose worktree settings are open; a menu opens them and closes before they show. */
export const useWorktreeSettings = create<{ shown: Shown | null }>(() => ({ shown: null }))

export function openWorktreeSettings(project: { path: string; name: string }): void {
  useWorktreeSettings.setState({ shown: { id: nextId++, path: project.path, name: project.name } })
}
