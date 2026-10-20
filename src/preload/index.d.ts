import type { OverbenchApi } from '@shared/ipc'

declare global {
  interface Window {
    overbench: OverbenchApi
  }
}
