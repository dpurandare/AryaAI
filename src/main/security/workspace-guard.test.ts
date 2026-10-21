import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceGuard, expandHome } from './workspace-guard'

describe('WorkspaceGuard', () => {
  // A real OS-native absolute path (not a hand-built one) so the expected
  // values match WorkspaceGuard's own internal `resolve()` call exactly on
  // every platform — a synthetic path like `/workspace` is fully absolute on
  // POSIX but drive-relative on Windows, where `resolve()` prepends the
  // current drive (e.g. `D:\workspace`), which a naive hand-built expectation
  // wouldn't account for. Caught live by this project's cross-platform CI.
  const root = resolve(tmpdir(), 'sachiv-workspace-guard-root')
  const outsideDir = resolve(tmpdir(), 'sachiv-workspace-guard-outside')
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
    expect(() => guard.assertWithinWorkspace(join(outsideDir, 'secret.txt'))).toThrow(
      /outside the workspace/
    )
  })

  it('accepts an absolute path that happens to be inside the workspace', () => {
    expect(guard.assertWithinWorkspace(join(root, 'inside.txt'))).toBe(join(root, 'inside.txt'))
  })

  describe('expandHome (TASKS #235)', () => {
    const home = resolve(tmpdir(), 'sachiv-fake-home')
    it('expands ~, ~/x and ~\\x to the home folder', () => {
      expect(expandHome('~', home)).toBe(home)
      expect(expandHome('~/Downloads/a.txt', home)).toBe(join(home, 'Downloads', 'a.txt'))
      if (process.platform === 'win32') expect(expandHome('~\\Downloads\\a.txt', home)).toBe(join(home, 'Downloads', 'a.txt'))
    })
    it('leaves ~user, ~x and ordinary paths alone', () => {
      expect(expandHome('~bob/x', home)).toBe('~bob/x')
      expect(expandHome('~x', home)).toBe('~x')
      expect(expandHome('a/~/b', home)).toBe('a/~/b')
    })
    it('the guard rejects an expanded home path outside the workspace', () => {
      expect(() => guard.assertWithinWorkspace('~/Downloads/a.txt')).toThrow(/outside the workspace/)
    })
  })
})
