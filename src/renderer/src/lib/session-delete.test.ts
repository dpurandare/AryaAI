import { describe, expect, it, vi } from 'vitest'
import { createSessionDeleteConfirm } from './session-delete'

describe('createSessionDeleteConfirm (TASKS #230)', () => {
  it('asking does not delete; Cancel keeps the session', async () => {
    const remove = vi.fn(async () => {})
    const c = createSessionDeleteConfirm(remove)
    c.request('s1', 'My chat')
    expect(c.pending).toEqual({ id: 's1', title: 'My chat' })
    expect(remove).not.toHaveBeenCalled()
    c.cancel()
    expect(c.pending).toBeNull()
    await c.confirm()
    expect(remove).not.toHaveBeenCalled()
  })

  it('Delete removes exactly the session that was asked about, once', async () => {
    const remove = vi.fn(async () => {})
    const c = createSessionDeleteConfirm(remove)
    c.request('s1', 'First')
    c.request('s2', 'Second')
    await c.confirm()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('s2')
    expect(c.pending).toBeNull()
    await c.confirm()
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
