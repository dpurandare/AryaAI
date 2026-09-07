/**
 * Single source of truth for the channel names and payload/result types
 * crossing the main <-> preload <-> renderer boundary. Keeping this in
 * `shared` (imported by both main and renderer) is what keeps the IPC
 * layer typed without a separate RPC library.
 */

export const IpcChannel = {
  AppGetInfo: 'app:get-info'
} as const

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
}

/** Request/response (invoke/handle) channel -> [request, response] type map. */
export interface IpcInvokeMap {
  [IpcChannel.AppGetInfo]: [void, AppInfo]
}
