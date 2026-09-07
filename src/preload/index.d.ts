import type { SachivApi } from './index'

declare global {
  interface Window {
    sachiv: SachivApi
  }
}
