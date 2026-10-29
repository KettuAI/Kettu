import type { KettuApi } from '@shared/ipc'

declare global {
  interface Window {
    kettu: KettuApi
  }
}
