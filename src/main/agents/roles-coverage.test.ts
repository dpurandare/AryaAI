import { describe, expect, it, vi } from 'vitest'

// tools/setup.ts imports `electron` (and transitively the keychain) — same mock as tools/setup.test.ts.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))

const { createDefaultRegistry } = await import('../tools/setup')
const { createAgents } = await import('./roles')

/**
 * Tools that are deliberately NOT owned by any specialist. Everything else in the
 * registry must belong to at least one role, or it is reachable only from the
 * top-level assistant and silently vanishes the moment a request is delegated —
 * the "orphaned tool" bug (`mcp_create_connection` had no owner before step 2).
 *
 * The deck-building flow (pptx_start_deck / pptx_add_slide / pptx_save_deck) stays
 * at the top level on purpose: it needs to call Page Creator once per slide, and a
 * specialist cannot delegate. Moving it into Document Creator needs nested
 * delegation (design-discussion.md step 3/4).
 */
const ROUTER_ONLY = new Set(['pptx_start_deck', 'pptx_add_slide', 'pptx_save_deck'])

describe('tool ownership across roles', () => {
  const registry = createDefaultRegistry()
  const agents = createAgents(registry)
  const owned = new Set([...agents.values()].flatMap((a) => a.tools.map((t) => t.name)))

  it('every registered tool is owned by a role, or is explicitly router-only', () => {
    const orphans = registry.list().map((t) => t.name).filter((n) => !owned.has(n) && !ROUTER_ONLY.has(n))
    expect(orphans, `tools no specialist can use: ${orphans.join(', ')}`).toEqual([])
  })

  it('the router-only list contains only tools that really exist and really are unowned (no stale entries)', () => {
    for (const name of ROUTER_ONLY) {
      expect(registry.get(name), `${name} is not registered`).toBeDefined()
      expect(owned.has(name), `${name} is owned by a role — remove it from ROUTER_ONLY`).toBe(false)
    }
  })

  it('a tool may be shared, but the SQL/API/Office/shell tools each have a single home', () => {
    const owners = (tool: string): string[] => [...agents.values()].filter((a) => a.tools.some((t) => t.name === tool)).map((a) => a.role)
    expect(owners('shell_execute')).toEqual(['coding'])
    expect(owners('db_execute_sql')).toEqual(['data'])
    expect(owners('office_create_document')).toEqual(['document-creator'])
    expect(owners('send_email')).toEqual(['email'])
  })
})
