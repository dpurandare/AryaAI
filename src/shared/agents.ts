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
  /** Real prompts that belong to this role — used by the routing evaluation and the summary lint (design 3.2). */
  readonly examples: readonly string[]
  /** Prompts that LOOK like they belong to this role but do not — each names, in brackets, the role that should take it. */
  readonly notExamples: readonly string[]
}

/**
 * Order matters: it is the order of the mode-picker cycle, the router's
 * roster and the plan-target list. Wording of `summary` is intentionally
 * unchanged from before the manifest existed (step 1 is "no behaviour
 * change"); step 2 rewrites summaries as validated routing contracts.
 */
export const ROLE_MANIFEST = [
  {
    id: 'planning',
    label: 'Planning',
    summary: 'Breaks a complex or ambiguous request into a clear, ordered set of concrete steps.',
    description:
      'Reasoning only — has no tools of its own. Turns a large or vague request into an ordered plan of concrete steps that the user or another specialist can follow. It never claims to execute anything.',
    pickable: true,
    plannable: true,
    examples: [
      'Plan the steps to move our monthly reports from spreadsheets to a database',
      'Break down what we need to do to launch a customer newsletter'
    ],
    notExamples: [
      'Search the web for solar tariff news [research]',
      'Run the test suite [terminal-devops]'
    ]
  },
  {
    id: 'research',
    label: 'Research',
    summary: 'Gathers and synthesizes information relevant to the request.',
    description:
      'Looks things up: web search, fetching and reading web pages, semantic search over your own past conversations, and calling configured external APIs. Synthesizes what it finds with sources; it does not write files or run code.',
    pickable: true,
    plannable: true,
    examples: [
      'Find recent news about renewable energy policy in the EU',
      'What did we conclude about the Q3 forecast in an earlier conversation?',
      'Call the weather API for the next three days in Pune'
    ],
    notExamples: [
      'Save these findings into a Word document [coding]',
      'Query the sales database for last year [data]'
    ]
  },
  {
    id: 'coding',
    label: 'Coding',
    summary: 'Reads, writes, and organizes files in the workspace to implement changes.',
    description:
      'Reads, writes and organizes files in the workspace: source code, Office documents (Word, Excel), data files, images and media, config. Writes scripts but has no shell — running them is Terminal/DevOps.',
    pickable: true,
    plannable: true,
    examples: [
      'Write a Python script that turns this CSV into a bar chart',
      'Create a Word document summarising these findings',
      'Refactor utils.ts to remove the duplicated parsing'
    ],
    notExamples: [
      'Run the script and show me the output [terminal-devops]',
      'How many customers are in the database? [data]'
    ]
  },
  {
    id: 'terminal-devops',
    label: 'Terminal/DevOps',
    summary: 'Runs shell commands and AWS/Azure/GCP CLI operations.',
    description:
      'Runs shell commands in the workspace (including Python scripts, using the workspace virtual environment) and AWS / Azure / Google Cloud CLI commands. Commands ask for confirmation; the shell is scoped to the workspace as its working directory but is not a sandbox.',
    pickable: true,
    plannable: true,
    examples: [
      'Run analysis.py and show me the output',
      'List the S3 buckets in our AWS account'
    ],
    notExamples: [
      'Write a script that parses the log files [coding]',
      'Publish a GitHub release for v1.4 [distribution]'
    ]
  },
  {
    id: 'data',
    label: 'Data',
    summary: 'Introspects and queries configured database connections.',
    description:
      'Explores and queries the database connections configured in Settings > Data sources (list, introspect schema, run SQL, save queries) and parses CSV / JSON / XML files. Mutating SQL asks for confirmation.',
    pickable: true,
    plannable: true,
    examples: [
      'How many customers are there in the Northwind database?',
      'Show the top 10 customers by sales for each year'
    ],
    notExamples: [
      'Turn those results into a bar chart in a Word file [coding]',
      'Look up industry benchmarks online [research]'
    ]
  },
  {
    id: 'distribution',
    label: 'Distribution',
    summary: 'Packages, publishes, and ships work (releases, deployment).',
    description:
      'Ships work through GitHub: issues, pull requests, releases and repository operations via the gh CLI (assumes gh is installed and authenticated).',
    pickable: true,
    plannable: true,
    examples: [
      'Create a GitHub release for v1.4 with these notes',
      'Open a pull request for this branch'
    ],
    notExamples: [
      'Run the test suite before releasing [terminal-devops]',
      'Write the release notes text [coding]'
    ]
  },
  {
    id: 'page-creator',
    label: 'Page Creator',
    summary: 'Designs and builds one slide of a presentation, given a brief for that slide.',
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
    summary: 'Drafts and sends an email given a loose brief (recipients, what it should say).',
    description:
      'Isolated specialist: drafts and sends an email from a short brief using the email accounts configured in Settings. Sending always asks for confirmation.',
    pickable: true,
    plannable: true,
    examples: [
      'Email the team that the monthly report is ready',
      'Send Priya a short summary of the invoice discussion'
    ],
    notExamples: [
      'Write a blog post about our launch [coding]',
      'Find out who our largest customer is, then email them [data, then email]'
    ]
  }
] as const satisfies readonly RoleMeta[]

/** Every specialist role id. Derived from the manifest — persisted `agentRole` values stay valid because ids are unchanged. */
export type AgentRole = (typeof ROLE_MANIFEST)[number]['id']

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
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = Object.fromEntries(
  ROLE_MANIFEST.map((r) => [r.id, r.label])
) as Record<AgentRole, string>
