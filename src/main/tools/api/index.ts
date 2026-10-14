import type { ApiConnectionSpecSummary } from '@shared/ipc-contract'
import { listApiConnections } from '../../data/api-connections'
import type { Tool } from '../types'

export { apiCallTool } from './call'
export { apiIntrospectTool } from './introspect'
export { apiCheckStatusTool } from './status'

function formatSpecSummary(summary: ApiConnectionSpecSummary | undefined): string {
  if (!summary || summary.endpointCount === 0) return '(not yet introspected — call api_introspect)'
  const suffix = summary.sample.length < summary.endpointCount ? ', …' : ''
  return `${summary.endpointCount} endpoint(s), e.g. ${summary.sample.join(', ')}${suffix}`
}

export const apiListConnectionsTool: Tool = {
  name: 'api_list_connections',
  description:
    'List the external API connections configured in Settings > External APIs, by name, base URL, ' +
    'auth type, and a quick endpoint-count hint (no credentials) — call api_introspect on the one you ' +
    'pick for full endpoint details before calling it with api_call.',
  inputSchema: { type: 'object', properties: {} },
  mutates: false,
  async execute() {
    const connections = listApiConnections()
    if (!connections.length) {
      return 'No API connections configured yet. Ask the user to add one in Settings > External APIs.'
    }
    // Quoted for the same reason db_list_connections quotes its name (found live, TASKS): a
    // connection's own name is free text and can itself contain parentheses, which would otherwise
    // make it genuinely ambiguous against the trailing "(baseUrl, auth: ...)" annotation.
    return connections
      .map((c) => `- "${c.name}" (${c.baseUrl}, auth: ${c.authType}): ${formatSpecSummary(c.specSummary)}`)
      .join('\n')
  }
}
