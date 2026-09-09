import { listConnections } from '../../data/connections'
import type { SavedQueryDto, SavedQueryParamType } from '@shared/ipc-contract'
import type { Tool } from '../types'
import { openDriver } from './driver-factory'
import { bindNamedParams } from './param-binding'

const JSON_SCHEMA_TYPE: Record<SavedQueryParamType, 'string' | 'number'> = { string: 'string', number: 'number' }

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || 'query'
}

/**
 * The random suffix (not the readable slug) is what actually guarantees no
 * two saved queries can ever collide on the same tool name — same
 * uniqueness pattern as git_clone_repo's destination folders, for the same
 * reason: the slug alone (two queries both named "Get Order" on different
 * connections, say) is not enough on its own.
 */
export function savedQueryToolName(query: SavedQueryDto): string {
  return `db_query_${slugify(query.name)}_${query.id.slice(0, 6)}`
}

/**
 * Turns one saved query into a real, callable `Tool` — the whole point of
 * "curated" queries: the model picks this tool and supplies the declared
 * parameters, it never re-derives the SQL. `mutates` is whatever was
 * computed once at save time (saved-queries.ts), not recomputed per call.
 */
export function buildSavedQueryTool(query: SavedQueryDto): Tool {
  const connectionName = listConnections().find((c) => c.id === query.connectionId)?.name ?? query.connectionId

  const properties: Record<string, unknown> = {}
  for (const param of query.params) {
    properties[param.name] = { type: JSON_SCHEMA_TYPE[param.type] }
  }

  return {
    name: savedQueryToolName(query),
    description:
      `${query.description || query.name} — a saved query on data connection "${connectionName}".` +
      (query.params.length ? '' : ' Takes no parameters.'),
    inputSchema: {
      type: 'object',
      properties,
      required: query.params.map((p) => p.name)
    },
    mutates: query.mutates,
    describe(input) {
      return `Run saved query "${query.name}" on "${connectionName}": ${JSON.stringify(input)}`
    },
    async execute(input) {
      const driver = openDriver(query.connectionId)
      try {
        const { sql, params } = bindNamedParams(query.sql, input, driver.engine)
        const result = await driver.execute(sql, params)
        if (result.rows) {
          return `${result.rowCount} row(s):\n${JSON.stringify(result.rows, null, 2)}`
        }
        return `${result.rowCount} row(s) affected.`
      } finally {
        await driver.close()
      }
    }
  }
}
