/**
 * Which ports keep a project's git status live, and the watchers each of them holds it for. A
 * client that watches a project from several screens names each one, so one stopping leaves the
 * others watching; one that does not is a single watcher.
 */
export class GitRetains {
  private readonly projects = new Map<string, { path: string; ports: Map<string, Set<string>> }>()

  /** True when the port had no watcher of the project, so the caller retains it for the port. */
  add(key: string, path: string, portId: string, watcher: string): boolean {
    let project = this.projects.get(key)
    if (!project) {
      project = { path, ports: new Map() }
      this.projects.set(key, project)
    }
    const watchers = project.ports.get(portId)
    if (watchers) {
      watchers.add(watcher)
      return false
    }
    project.ports.set(portId, new Set([watcher]))
    return true
  }

  /** The project's path when the port's last watcher of it went, so the caller releases it. */
  remove(key: string, portId: string, watcher: string): string | null {
    const project = this.projects.get(key)
    const watchers = project?.ports.get(portId)
    if (!project || !watchers?.delete(watcher) || watchers.size > 0) return null
    project.ports.delete(portId)
    if (project.ports.size === 0) this.projects.delete(key)
    return project.path
  }

  ports(key: string): Iterable<string> {
    return this.projects.get(key)?.ports.keys() ?? []
  }

  dropPort(portId: string): void {
    for (const [key, project] of this.projects) {
      if (project.ports.delete(portId) && project.ports.size === 0) this.projects.delete(key)
    }
  }
}
