import { ROLE_MANIFEST, type RoleMeta } from '@shared/agents'
import type { RoleProblemDto, RoleRosterDto, RoleRosterEntryDto } from '@shared/ipc-contract'
import { buildDelegateToolDefinition } from '../agents/orchestrator'
import { countTokens } from '../util/tokens'
import type { LoadResult } from './user-roles'

/** Above this many enabled user roles, or this many tokens together, Settings warns: every enabled role's summary reaches the router on every turn (design 11.4). */
export const USER_ROLE_COUNT_WARNING = 8
export const USER_ROLE_TOKEN_WARNING = 600

/** Rough tokens a role adds to every request: its delegate tool, plus its line in the planner's role list when it can be a plan target. */
export function roleTokenCost(id: string, label: string, summary: string, plannable: boolean): number {
  const t = buildDelegateToolDefinition(id, label, summary)
  const tool = countTokens(JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
  return tool + (plannable ? countTokens(`- ${id}: ${summary}\n`) : 0)
}

function builtinEntry(r: RoleMeta): RoleRosterEntryDto {
  return { id: r.id, label: r.label, summary: r.summary, description: r.description, builtin: true, pickable: r.pickable, plannable: r.plannable, enabled: true, tokenCost: roleTokenCost(r.id, r.label, r.summary, r.plannable), warnings: [] }
}

/** Built-in roles first (read-only), then the user's, then the load problems — the whole picture the Settings panel shows. */
export function buildRoster(loaded: LoadResult, folder: string): RoleRosterDto {
  const user: RoleRosterEntryDto[] = loaded.roles.map((l) => ({
    id: l.file.id,
    label: l.file.name,
    summary: l.file.summary,
    description: l.file.description,
    builtin: false,
    pickable: l.file.pickable,
    plannable: l.file.plannable,
    enabled: l.enabled,
    tokenCost: roleTokenCost(l.file.id, l.file.name, l.file.summary, l.file.plannable),
    warnings: l.warnings,
    file: l.sourceFile,
    stale: l.stale || undefined
  }))
  const enabled = user.filter((u) => u.enabled)
  const userTokenCost = enabled.reduce((n, u) => n + u.tokenCost, 0)
  let budgetWarning: string | undefined
  if (enabled.length > USER_ROLE_COUNT_WARNING || userTokenCost > USER_ROLE_TOKEN_WARNING) {
    budgetWarning = `${enabled.length} of your roles are enabled and add about ${userTokenCost} tokens to every request. Disable the ones you do not use — routing also gets worse as the list grows.`
  }
  const problems: RoleProblemDto[] = loaded.problems
  return { roles: [...ROLE_MANIFEST.map(builtinEntry), ...user], problems, folder, userTokenCost, budgetWarning }
}
