/**
 * Guard for the automatically inserted "look up domain knowledge" step (orchestrator.ts, `ensureDomainKnowledgeStep`).
 * Connected MCP servers hold knowledge (rules, standards, processes), never the user's own data. The planner's schema
 * asks for a topic that is not a data source, but a small model ignored that (manual test 8.2, run 2: topic "Northwind
 * database schema"), so the check is made here in code instead of being asked again in a prompt.
 */

/** Words that make a topic about somebody's data rather than about knowledge. */
const USER_DATA_WORDS = /\b(databases?|schemas?|tables?|rows?|records?|datasets?)\b/i

/** Parts of a connection name that say nothing about which data it is. */
const GENERIC_NAME_PARTS = new Set([
  'server', 'sample', 'sqlite', 'mssql', 'mysql', 'postgres', 'postgresql', 'database', 'default', 'local', 'prod', 'production', 'test', 'demo', 'main', 'data'
])

/** The searchable terms in the user's data-source names: each whole name plus its distinctive words ("NorthwindSQLServer" -> northwind). */
export function userDataTerms(names: readonly string[]): string[] {
  const terms = new Set<string>()
  for (const raw of names) {
    const name = raw.trim().toLowerCase()
    if (name.length >= 4) terms.add(name)
    for (const part of raw.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const word = part.toLowerCase()
      if (word.length >= 5 && !GENERIC_NAME_PARTS.has(word)) terms.add(word)
    }
  }
  return [...terms]
}

/** True when the topic names one of the user's data sources, or is plainly about tables, schemas or records. */
export function isUserDataTopic(topic: string, terms: readonly string[]): boolean {
  if (USER_DATA_WORDS.test(topic)) return true
  const lower = topic.toLowerCase()
  return terms.some((t) => lower.includes(t))
}
