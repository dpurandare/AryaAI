import { describe, expect, it } from 'vitest'
import { join, sep } from 'node:path'
import { WorkspaceGuard } from './workspace-guard'

describe('WorkspaceGuard', () => {
  const root = join(sep, 'workspace')
  const guard = new WorkspaceGuard(root)

  it('resolves a simple relative path within the workspace', () => {
    expect(guard.assertWithinWorkspace('foo.txt')).toBe(join(root, 'foo.txt'))
  })

  it('resolves a nested relative path within the workspace', () => {
    expect(guard.assertWithinWorkspace('a/b/c.txt')).toBe(join(root, 'a', 'b', 'c.txt'))
  })

  it('resolves "." to the workspace root itself', () => {
    expect(guard.assertWithinWorkspace('.')).toBe(root)
  })

  it('rejects a path that escapes via ..', () => {
    expect(() => guard.assertWithinWorkspace('../outside.txt')).toThrow(/outside the workspace/)
  })

  it('rejects a path that escapes via a nested ..', () => {
    expect(() => guard.assertWithinWorkspace('a/../../outside.txt')).toThrow(/outside the workspace/)
  })

  it('rejects an absolute path outside the workspace', () => {
    expect(() => guard.assertWithinWorkspace(join(sep, 'etc', 'passwd'))).toThrow(
      /outside the workspace/
    )
  })

  it('accepts an absolute path that happens to be inside the workspace', () => {
    expect(guard.assertWithinWorkspace(join(root, 'inside.txt'))).toBe(join(root, 'inside.txt'))
  })
})
