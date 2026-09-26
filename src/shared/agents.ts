/**
 * The role manifest — the single source of truth for what Sachivji's specialist
 * roles ARE (design-discussion.md 3.2, order-of-work step 1). Everything that
 * used to be a hand-maintained parallel list (the `AgentRole` union, the
 * mode-picker cycle, the classifier's valid plan targets, the human labels,
 * the roster text in the router prompt) is derived from `ROLE_MANIFEST` below,
 * so adding or renaming a role is one edit.
 *
 * Lives in shared/ (not main/agents/) because it crosses the IPC boundary —
 * the main process (routing/execution) and the renderer (attributing streamed
 * content to the agent that produced it, the Ctrl+Tab mode picker) both need
 * it. Only *data* lives here: each role's system prompt and tool list stay in
 * main/agents/roles.ts, keyed by the same id.
 *
 * A record is deliberately shaped so it could later be loaded from a file
 * (design section 11): plain JSON-able fields only, `id` a validated string in
 * spirit, flags on the record rather than in separate lists.
 */
export interface RoleMeta {
  /** Stable id: persisted in sessions (`agentRole` on content blocks), used in delegate tool names (`delegate_to_<id>`). Lower-case letters, digits and hyphens. */
  readonly id: string
  /** Human-readable label — the renderer's mode picker and role chips, and the router's roster. */
  readonly label: string
  /**
   * ROUTING text: what the role does (and, once step 2 lands, what it does NOT
   * and where it hands off). The only role text the router carries in every
   * request, so it stays short (target <= ~30 tokens).
   */
  readonly summary: string
  /** LISTING text: fuller prose shown only by `describe_capabilities` and Settings — never in a routing prompt, so detail here costs nothing per request. */
  readonly description: string
  /** Offered in the composer's "Agent: X" picker (Ctrl+Tab cycle). */
  readonly pickable: boolean
  /** A valid classify-and-plan step target. */
  readonly plannable: boolean
  /**
   * Live configuration this role is useless without — ANY of these being present is enough (Data Access needs a database OR an API).
   * Feeds the planner's capability digest, so a plan never routes "email it to X" to a role that has no account to send from.
   */
  readonly requiresAnyOf?: readonly ('database' | 'api' | 'email')[]
  /** Real prompts that belong to this role — used by the routing evaluation and the summary lint (design 3.2). */
  readonly examples: readonly string[]
  /** Prompts that LOOK like they belong to this role but do not — each names, in brackets, the role that should take it. */
  readonly notExamples: readonly string[]
}

/**
 * Order matters: it is the order of the mode-picker cycle, the router's
 * roster and the plan-target list. Each `summary` is a routing contract — it
 * says what the role does, what it does NOT do, and who takes that instead —
 * enforced by `lintRoutingSummary` (shared/role-lint.test.ts).
 */
export const ROLE_MANIFEST = [
  {
    id: 'planning',
    label: 'Planner',
    summary:
      'Turns a complex or ambiguous request into ordered steps. Has no tools and executes nothing — hands each step to Researcher, Developer, Data Access or the other specialists.',
    description:
      'Reasoning only — has no tools of its own. Turns a large or vague request into an ordered plan of concrete steps, at role granularity, that the user or another specialist can follow. It never claims to execute anything.',
    pickable: true,
    plannable: true,
    examples: [
      'Plan the steps to move our monthly reports from spreadsheets to a database',
      'Break down what we need to do to launch a customer newsletter'
    ],
    notExamples: [
      'Search the web for solar tariff news [research]',
      'Run the test suite [coding]'
    ]
  },
  {
    id: 'research',
    label: 'Researcher',
    summary:
      'Finds information on the web and reads web pages. Does not recall past conversations (History Analyst), call configured APIs (Data Access) or write files (Developer).',
    description:
      'Looks things up on the web: web search and fetching and reading web pages, synthesizing what it finds with sources. It does not write files, run code, recall your past conversations, or call your configured external APIs.',
    pickable: true,
    plannable: true,
    examples: [
      'Find recent news about renewable energy policy in the EU',
      'Summarise what this article says about battery storage costs'
    ],
    notExamples: [
      'What did we conclude about the Q3 forecast last week? [history-analyst]',
      'Save these findings into a Word document [document-creator]',
      'Call the weather API for the next three days [data]'
    ]
  },
  {
    id: 'history-analyst',
    label: 'History Analyst',
    summary:
      'Recalls and compares things from earlier conversations, including how a detail changed over time. Does not search the web (Researcher).',
    description:
      'Semantic search over your own past sessions (including the current one) to recall what was said or decided, or to compare how a detail changed between conversations. It cannot look anything up online.',
    pickable: true,
    plannable: true,
    examples: [
      'What did we conclude about the Q3 forecast in an earlier conversation?',
      'How did the numbers we discussed for the Pune site change between last month and now?'
    ],
    notExamples: [
      'Find the latest news on the Pune solar project [research]',
      'Redo that analysis for a different region [data]'
    ]
  },
  {
    id: 'coding',
    label: 'Developer',
    summary:
      'Writes AND runs code (Python in the workspace venv), edits files, uses git, cloud CLIs and GitHub. Not for plain Word documents (Document Creator) or database queries (Data Access).',
    description:
      'Writes and edits code and files in the workspace, and runs them: shell commands and Python scripts (with the workspace virtual environment active), git, the AWS / Azure / Google Cloud CLIs, and GitHub via gh. Because it both writes and runs, "make a chart / a script and run it" is one job for it. Every command and every change asks for confirmation. Not a sandbox.',
    pickable: true,
    plannable: true,
    examples: [
      'Write a Python script that turns this data into bar charts, run it, and put the charts in a Word file',
      'Run analysis.py and show me the output',
      'Create a GitHub release for v1.4 with these notes'
    ],
    notExamples: [
      'Write a one-page Word summary of these findings [document-creator]',
      'How many customers are in the Northwind database? [data]'
    ]
  },
  {
    id: 'data',
    label: 'Data Access',
    summary:
      'Queries configured databases and calls configured external APIs. Not for local files (Data Processor) or for creating connections (Configurator).',
    description:
      'Explores and queries the databases configured in Settings > Data sources (list, introspect schema, run SQL, saved queries) and calls the external APIs configured in Settings > External APIs. Mutating SQL and API calls ask for confirmation. Needs at least one configured connection.',
    pickable: true,
    plannable: true,
    requiresAnyOf: ['database', 'api'],
    examples: [
      'How many customers are there in the Northwind database?',
      'Show the top 10 customers by sales for each year',
      'Call the weather API for the next three days in Pune'
    ],
    notExamples: [
      'Total up the amounts column in this CSV file [data-processor]',
      'Connect to our new Postgres server [configurator]'
    ]
  },
  {
    id: 'data-processor',
    label: 'Data Processor',
    summary:
      'Reads, queries and transforms local CSV, JSON, XML and Excel files. Not for databases (Data Access) or general programming (Developer).',
    description:
      'Works with structured files on disk or at a URL: summarizes and queries CSV / JSON / XML, appends a record to CSV / JSON, and reads and edits Excel workbooks. It does not run SQL against databases and does not write general-purpose code.',
    pickable: true,
    plannable: true,
    examples: [
      'Summarise the columns in sales_2024.csv',
      'Add these three rows to the Excel workbook on the Summary sheet'
    ],
    notExamples: [
      "Query last year's sales from the database [data]",
      'Write a script that cleans this file and run it [coding]'
    ]
  },
  {
    id: 'document-creator',
    label: 'Document Creator',
    summary:
      'Creates, fills from templates and reads Word and other Office documents. Cannot run code or draw charts from data (Developer) and cannot edit an existing file in place.',
    description:
      'Creates Word and other Office documents from scratch, fills user-authored templates (keeping their styling), turns an existing document into a template, and reads documents. It cannot edit an existing .docx / .pptx in place, cannot embed charts from data on its own (that takes a script — Developer), and does not build presentations (the top-level assistant does, one slide at a time).',
    pickable: true,
    plannable: true,
    examples: [
      'Create a Word document summarising these findings with headings and bullets',
      'Fill our invoice template with these customer details'
    ],
    notExamples: [
      'Generate bar charts from this data and put them in a Word file [coding]',
      'Read the numbers out of this Excel sheet [data-processor]'
    ]
  },
  {
    id: 'configurator',
    label: 'Configurator',
    summary:
      'Sets up connections to databases, external APIs and MCP servers. Does not query them (Data Access); secrets go through the confirmation dialog, never chat.',
    description:
      'Creates connections from details you give in chat: databases, external APIs and MCP servers. Each is tested for real before saving. Passwords, keys and tokens are typed into the confirmation dialog, never into chat. It does not use the connections afterwards.',
    pickable: true,
    plannable: true,
    examples: [
      'Connect Sachivji to our Postgres reporting database',
      'Add the weather API at https://api.example.com as an external API'
    ],
    notExamples: [
      'How many rows are in the orders table? [data]',
      'Send an email to the team [email]'
    ]
  },
  {
    id: 'page-creator',
    label: 'Page Creator',
    summary:
      'Designs one slide of a presentation from a brief. Not conversational and never a plan step — the top-level assistant calls it once per slide.',
    description:
      'Isolated, delegate-only specialist: builds exactly one slide of a presentation from a brief. It is not a conversational agent and is not offered in the mode picker or as a plan step; the top-level assistant calls it once per slide.',
    pickable: false,
    plannable: false,
    examples: [
      'Build slide 3: quarterly revenue chart with three supporting bullets',
      'Design a title slide for the Q3 review with the subtitle "Growth and risks"'
    ],
    notExamples: ['Make me a 10-slide deck about our roadmap [orchestrator builds the deck, one page-creator call per slide]']
  },
  {
    id: 'email',
    label: 'Email',
    summary:
      'Drafts and sends an email from a brief (recipients, what to say). Does not write documents (Document Creator) or look up addresses (Data Access).',
    description:
      'Isolated specialist: drafts and sends an email from a short brief using the email accounts configured in Settings. Sending always asks for confirmation. Needs at least one configured email account.',
    pickable: true,
    plannable: true,
    requiresAnyOf: ['email'],
    examples: [
      'Email the team that the monthly report is ready',
      'Send Priya a short summary of the invoice discussion'
    ],
    notExamples: [
      'Write a blog post about our launch [document-creator]',
      'Find out who our largest customer is, then email them [data, then email]'
    ]
  }
] as const satisfies readonly RoleMeta[]

/**
 * Role ids that existed before step 2's split and may still appear on saved
 * messages (`agentRole` on content blocks). They are NOT agents any more —
 * `terminal-devops` and `distribution` were merged into Developer (`coding`) —
 * but old transcripts, exports and print views still look their label up.
 */
export const LEGACY_ROLE_LABELS = {
  'terminal-devops': 'Terminal/DevOps',
  distribution: 'Distribution'
} as const

/** Every specialist role id. Derived from the manifest — persisted `agentRole` values stay valid because ids are unchanged. */
export type AgentRole = (typeof ROLE_MANIFEST)[number]['id'] | keyof typeof LEGACY_ROLE_LABELS

const BY_ID: ReadonlyMap<string, RoleMeta> = new Map(ROLE_MANIFEST.map((r) => [r.id, r]))

/** The manifest record for a role id, or `undefined` for an id it does not know. */
export function roleMeta(id: string): RoleMeta | undefined {
  return BY_ID.get(id)
}

/**
 * The user-selectable roles — powers the renderer's manual Ctrl+Tab
 * mode-picker cycle. Deliberately does NOT include every role: `page-creator`
 * (#78) is an isolated, delegate-only specialist that expects a specific
 * one-slide brief, not a general chat turn — forcing a user conversation onto
 * it directly would be nonsensical. `email` (#79) IS included: "send an email
 * about X" is a perfectly normal standalone request.
 */
export const AGENT_ROLES: readonly AgentRole[] = ROLE_MANIFEST.filter((r) => r.pickable).map((r) => r.id)

/**
 * Roles the classify-and-plan step may target (orchestrator.ts's
 * `VALID_STEP_ROLES` and the classifier's role list). Today this equals
 * `AGENT_ROLES`, but it is its own list so the two can diverge — a role may be
 * pickable yet never a plan step, or the reverse.
 */
export const PLANNABLE_ROLES: readonly AgentRole[] = ROLE_MANIFEST.filter((r) => r.plannable).map((r) => r.id)

/** Human-readable label per role — used by the router's own system prompt and the renderer's mode picker/role chips, so the two stay in sync. */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  ...(Object.fromEntries(ROLE_MANIFEST.map((r) => [r.id, r.label])) as Record<(typeof ROLE_MANIFEST)[number]['id'], string>),
  ...LEGACY_ROLE_LABELS
}
