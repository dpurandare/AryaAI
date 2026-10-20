/**
 * TASKS #230: deleting a session is permanent, so the × on a session row only asks; the delete runs once the user confirms.
 * Kept free of Svelte so "Cancel keeps the session, Delete removes it" is unit-testable.
 */
export interface PendingSessionDelete {
  id: string
  title: string
}

export interface SessionDeleteConfirm {
  /** The session the confirmation dialog is currently asking about, or null when it is closed. */
  readonly pending: PendingSessionDelete | null
  request(id: string, title: string): void
  confirm(): Promise<void>
  cancel(): void
}

export function createSessionDeleteConfirm(remove: (id: string) => Promise<void>): SessionDeleteConfirm {
  let pending: PendingSessionDelete | null = null
  return {
    get pending() {
      return pending
    },
    request(id, title) {
      pending = { id, title }
    },
    async confirm() {
      const target = pending
      pending = null
      if (target) await remove(target.id)
    },
    cancel() {
      pending = null
    }
  }
}
