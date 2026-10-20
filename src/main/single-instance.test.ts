import { describe, expect, it, vi } from 'vitest'
import { ensureSingleInstance, SECOND_INSTANCE_MESSAGE, SECOND_INSTANCE_TITLE } from './single-instance'

function fakeApp(gotLock: boolean) {
  return { requestSingleInstanceLock: vi.fn(() => gotLock), quit: vi.fn(), on: vi.fn() }
}

describe('ensureSingleInstance (TASKS #131)', () => {
  it('the first instance continues and listens for later launches', () => {
    const app = fakeApp(true)
    const showError = vi.fn()
    const onSecond = vi.fn()
    expect(ensureSingleInstance(app, showError, onSecond)).toBe(true)
    expect(showError).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    expect(app.on).toHaveBeenCalledWith('second-instance', onSecond)
  })

  it('a second instance shows the message, quits only after it is dismissed, and does not continue', async () => {
    const app = fakeApp(false)
    let dismiss: () => void = () => {}
    const showError = vi.fn(() => new Promise<void>((resolve) => (dismiss = resolve)))
    expect(ensureSingleInstance(app, showError, vi.fn())).toBe(false)
    expect(showError).toHaveBeenCalledWith(SECOND_INSTANCE_TITLE, SECOND_INSTANCE_MESSAGE)
    expect(app.quit).not.toHaveBeenCalled()
    dismiss()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(app.on).not.toHaveBeenCalled()
  })
})
