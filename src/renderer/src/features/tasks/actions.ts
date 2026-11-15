// What the task's row and page change on its host.

import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { useTasksStore } from '@renderer/stores/tasks'

type TaskChange = { title?: string; pinned?: boolean; archived?: boolean; unread?: boolean }

/** Changes the task on its host and takes the view it returns; a failure shows as a toast. */
export async function updateTask(taskId: string, change: TaskChange): Promise<void> {
  try {
    const view = await host('tasks.update', { taskId, ...change })
    useTasksStore.getState().receive(view, useTasksStore.getState().hosts[taskId] ?? null)
  } catch (error) {
    toast(errorMessage(error))
    throw error
  }
}
